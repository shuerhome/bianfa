//! Attachments (05 §7, 02 §8): files land in `attachments/<id>.<ext>`, hashed with BLAKE3
//! for de-duplication, served to the WebView through the `bianfa-att` custom protocol, and
//! uploaded (when signed in) with the server's two-phase `presign → PUT → commit` (04 §6.4).

use super::state::AppState;
use super::{auth, events};
use crate::api::{self, ApiErrorBody, CommitResponse, PresignResponse};
use crate::db::attachments as db_att;
use crate::error::{IpcError, IpcResult};
use crate::model::{AttachmentInfo, AttachmentRow, AttachmentUploadResult};
use crate::util::{b64_decode, now_ms, uuid_v7};
use std::borrow::Cow;
use std::time::Duration;
use tauri::{AppHandle, Manager, UriSchemeContext};

pub const SCHEME: &str = "bianfa-att";
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_SIDE: u32 = 2560;

/// The URL the WebView can load. Windows/Android map custom schemes onto `http://<scheme>.localhost`.
pub fn local_url(id: &str) -> String {
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost/{id}")
    } else {
        format!("{SCHEME}://localhost/{id}")
    }
}

fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"%PDF") {
        Some("application/pdf")
    } else {
        None
    }
}

fn ext_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

struct Prepared {
    bytes: Vec<u8>,
    mime: String,
    width: Option<i64>,
    height: Option<i64>,
    blurhash: Option<String>,
}

/// Decodes images to learn their size, downsizes anything above 2560 px on the long side and
/// computes a blurhash. Non-images are stored as-is.
fn prepare(bytes: Vec<u8>, hint: Option<&str>) -> IpcResult<Prepared> {
    let mime = sniff_mime(&bytes)
        .map(str::to_string)
        .or_else(|| hint.map(|h| h.to_string()))
        .unwrap_or_else(|| "application/octet-stream".into());
    if !mime.starts_with("image/") || mime == "image/gif" {
        return Ok(Prepared {
            bytes,
            mime,
            width: None,
            height: None,
            blurhash: None,
        });
    }
    let img = image::load_from_memory(&bytes)
        .map_err(|e| IpcError::invalid(format!("cannot decode image: {e}")))?;
    let (w, h) = (img.width(), img.height());
    let (out_bytes, out_mime, w, h) = if w.max(h) > MAX_SIDE {
        let resized = img.thumbnail(MAX_SIDE, MAX_SIDE);
        let mut buf = std::io::Cursor::new(Vec::new());
        let (fmt, m) = if mime == "image/jpeg" {
            (image::ImageFormat::Jpeg, "image/jpeg")
        } else {
            (image::ImageFormat::Png, "image/png")
        };
        resized
            .write_to(&mut buf, fmt)
            .map_err(|e| IpcError::invalid(format!("re-encode failed: {e}")))?;
        (
            buf.into_inner(),
            m.to_string(),
            resized.width(),
            resized.height(),
        )
    } else {
        (bytes, mime, w, h)
    };
    let thumb = img.thumbnail(32, 32).to_rgba8();
    let blur = blurhash::encode(4, 3, thumb.width(), thumb.height(), thumb.as_raw()).ok();
    Ok(Prepared {
        bytes: out_bytes,
        mime: out_mime,
        width: Some(w as i64),
        height: Some(h as i64),
        blurhash: blur,
    })
}

pub fn import(
    app: &AppHandle,
    note_id: &str,
    source_path: Option<&str>,
    bytes_b64: Option<&str>,
    mime: Option<&str>,
) -> IpcResult<AttachmentInfo> {
    let raw = match (source_path, bytes_b64) {
        (Some(p), _) => std::fs::read(p)?,
        (None, Some(b)) => b64_decode(b)?,
        (None, None) => return Err(IpcError::invalid("sourcePath or bytesB64 required")),
    };
    if raw.len() > MAX_BYTES {
        return Err(IpcError::invalid("attachment exceeds 10 MB"));
    }
    if raw.is_empty() {
        return Err(IpcError::invalid("attachment is empty"));
    }
    let hint = mime.map(|m| m.to_string()).or_else(|| {
        source_path
            .and_then(|p| std::path::Path::new(p).extension())
            .and_then(|e| e.to_str())
            .map(|e| match e.to_ascii_lowercase().as_str() {
                "png" => "image/png".to_string(),
                "jpg" | "jpeg" => "image/jpeg".to_string(),
                "gif" => "image/gif".to_string(),
                "webp" => "image/webp".to_string(),
                "pdf" => "application/pdf".to_string(),
                _ => "application/octet-stream".to_string(),
            })
    });
    let prepared = prepare(raw, hint.as_deref())?;
    let hash = blake3::hash(&prepared.bytes);
    let hash_bytes = hash.as_bytes().to_vec();
    let state = app.state::<AppState>();

    if let Some(existing) = state.with_db(|c| db_att::find_by_hash(c, &hash_bytes))? {
        let existing_id = existing.id.clone();
        events::mutate(
            app,
            "local",
            &["attachments", "note_attachments"],
            vec![existing_id.clone()],
            |tx| db_att::link(tx, note_id, &existing_id),
        )?;
        return Ok(AttachmentInfo {
            id: existing.id,
            hash: hash.to_hex().to_string(),
            mime: existing.mime,
            byte_size: existing.byte_size,
            width: existing.width,
            height: existing.height,
            blurhash: existing.blurhash,
        });
    }

    let id = uuid_v7();
    let file_name = format!("{id}.{}", ext_for(&prepared.mime));
    let rel = format!("attachments/{file_name}");
    let abs = state.paths.attachments_dir.join(&file_name);
    std::fs::write(&abs, &prepared.bytes)?;
    let row = AttachmentRow {
        id: id.clone(),
        content_hash: hash_bytes,
        byte_size: prepared.bytes.len() as i64,
        mime: prepared.mime.clone(),
        width: prepared.width,
        height: prepared.height,
        blurhash: prepared.blurhash.clone(),
        local_path: rel,
        upload_state: "local".into(),
        created_at: now_ms(),
    };
    // `db:changed { tables: ["attachments"], ids: [<attachment id>] }` lets the sync host upload it.
    events::mutate(
        app,
        "local",
        &["attachments", "note_attachments"],
        vec![id.clone()],
        |tx| {
            db_att::insert(tx, &row)?;
            db_att::link(tx, note_id, &id)
        },
    )?;
    Ok(AttachmentInfo {
        id,
        hash: hash.to_hex().to_string(),
        mime: prepared.mime,
        byte_size: prepared.bytes.len() as i64,
        width: prepared.width,
        height: prepared.height,
        blurhash: prepared.blurhash,
    })
}

fn response(status: u16, mime: &str, body: Vec<u8>) -> tauri::http::Response<Cow<'static, [u8]>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("Access-Control-Allow-Origin", "*")
        .body(Cow::Owned(body))
        .unwrap_or_else(|_| tauri::http::Response::new(Cow::Borrowed(&[][..])))
}

/// `bianfa-att://localhost/<id>` → the file on disk with its stored content type.
pub fn protocol_handler(
    ctx: UriSchemeContext<'_, tauri::Wry>,
    req: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    let id = req.uri().path().trim_start_matches('/').to_string();
    if id.is_empty() || id.contains("..") || id.contains('/') {
        return response(400, "text/plain", b"bad request".to_vec());
    }
    let app = ctx.app_handle();
    let state = app.state::<AppState>();
    let row = match state.with_db(|c| db_att::get(c, &id)) {
        Ok(Some(r)) => r,
        _ => return response(404, "text/plain", b"not found".to_vec()),
    };
    let path = state
        .paths
        .data_dir
        .join(row.local_path.trim_start_matches('/'));
    match std::fs::read(&path) {
        Ok(bytes) => response(200, &row.mime, bytes),
        Err(_) => response(404, "text/plain", b"missing file".to_vec()),
    }
}

// ---------------------------------------------------------------------------------------------
// Upload (presign → PUT to R2 → commit)
// ---------------------------------------------------------------------------------------------

pub const UPLOAD_STATE_LOCAL: &str = "local";
pub const UPLOAD_STATE_COMMITTED: &str = "committed";
const PUT_TIMEOUT: Duration = Duration::from_secs(120);

fn result(id: &str, remote: Option<String>, status: &str) -> AttachmentUploadResult {
    AttachmentUploadResult {
        attachment_id: id.to_string(),
        remote_attachment_id: remote,
        status: status.to_string(),
    }
}

fn server_error(prefix: &str, status: u16, body: &str) -> IpcError {
    let parsed = ApiErrorBody::parse(body);
    let code = parsed.code(status);
    IpcError::new(&code, format!("{prefix} failed ({status}): {code}")).with_details(
        serde_json::json!({ "status": status, "requestId": parsed.request_id, "extra": parsed.extra }),
    )
}

/// Ids of attachments the server has not acknowledged yet (`attachments_pending_upload`).
pub fn pending(app: &AppHandle) -> IpcResult<Vec<String>> {
    app.state::<AppState>()
        .with_db(|c| db_att::pending_upload(c, &api::UPLOAD_MIMES))
}

/// Uploads one local attachment. Not signed in → `local`; non-image → `unsupported`;
/// R2 not configured on the server (503) → `disabled`; quota / permission failures are errors
/// whose `code` is the server's error code (`quota_exceeded`, `insufficient_permission`, …).
pub async fn upload(app: &AppHandle, id: &str) -> IpcResult<AttachmentUploadResult> {
    let state = app.state::<AppState>();
    let auth_status = state.auth.status();
    if !auth_status.logged_in {
        return Ok(result(id, None, UPLOAD_STATE_LOCAL));
    }
    let row = state
        .with_db(|c| db_att::get(c, id))?
        .ok_or_else(|| IpcError::not_found(format!("attachment {id} not found")))?;
    if row.upload_state == UPLOAD_STATE_COMMITTED {
        return Ok(result(id, Some(id.to_string()), UPLOAD_STATE_COMMITTED));
    }
    if !api::UPLOAD_MIMES.contains(&row.mime.as_str()) {
        return Ok(result(id, None, "unsupported"));
    }
    let owner = state.with_db(|c| db_att::note_for(c, id))?;
    let workspace_id = owner
        .and_then(|(_, ws)| ws)
        .or(auth_status.personal_workspace_id)
        .ok_or_else(|| IpcError::auth("no workspace to upload into (claim pending)"))?;
    let path = state
        .paths
        .data_dir
        .join(row.local_path.trim_start_matches('/'));
    let bytes = std::fs::read(&path)?;
    if bytes.len() as i64 != row.byte_size {
        return Err(IpcError::io(format!(
            "attachment {id} size mismatch on disk ({} vs {})",
            bytes.len(),
            row.byte_size
        )));
    }

    let mut presign_body = serde_json::json!({
        "attachment_id": id,
        "workspace_id": workspace_id,
        "hash": hex::encode(&row.content_hash),
        "size": bytes.len(),
        "mime": row.mime,
    });
    if let Some(w) = row.width {
        presign_body["width"] = w.into();
    }
    if let Some(h) = row.height {
        presign_body["height"] = h.into();
    }
    if let Some(b) = &row.blurhash {
        presign_body["blurhash"] = serde_json::Value::String(b.clone());
    }
    let r = auth::api_request(
        app,
        "POST",
        api::paths::ATTACHMENT_PRESIGN,
        Some(presign_body),
        Some(30_000),
    )
    .await?;
    if r.status == 503 {
        return Ok(result(id, None, "disabled"));
    }
    if r.status != 200 {
        return Err(server_error("presign", r.status, &r.body_text));
    }
    let presign: PresignResponse = serde_json::from_str(&r.body_text)?;
    if presign.exists {
        // Same bytes already committed in this workspace (possibly under another id).
        state.with_tx(|tx| db_att::set_upload_state(tx, id, UPLOAD_STATE_COMMITTED))?;
        return Ok(result(
            id,
            Some(presign.attachment_id),
            UPLOAD_STATE_COMMITTED,
        ));
    }
    let upload_url = presign
        .upload_url
        .clone()
        .ok_or_else(|| IpcError::invalid("presign response without upload_url"))?;
    let method = reqwest::Method::from_bytes(
        presign
            .method
            .as_deref()
            .unwrap_or("PUT")
            .to_ascii_uppercase()
            .as_bytes(),
    )
    .map_err(|_| IpcError::invalid("presign response with bad method"))?;
    let mut put = state.http.request(method, &upload_url).timeout(PUT_TIMEOUT);
    for (k, v) in &presign.headers {
        // reqwest derives Content-Length from the body; a duplicate header would be rejected.
        if !k.eq_ignore_ascii_case("content-length") {
            put = put.header(k.as_str(), v.as_str());
        }
    }
    let put_resp = put.body(bytes).send().await?;
    if !put_resp.status().is_success() {
        return Err(IpcError::network(format!(
            "object upload failed ({})",
            put_resp.status()
        )));
    }

    let r = auth::api_request(
        app,
        "POST",
        api::paths::ATTACHMENT_COMMIT,
        Some(serde_json::json!({ "attachment_id": id })),
        Some(30_000),
    )
    .await?;
    if r.status != 200 {
        return Err(server_error("commit", r.status, &r.body_text));
    }
    let committed: CommitResponse = serde_json::from_str(&r.body_text)?;
    state.with_tx(|tx| db_att::set_upload_state(tx, id, UPLOAD_STATE_COMMITTED))?;
    Ok(result(id, Some(committed.attachment_id), &committed.status))
}
