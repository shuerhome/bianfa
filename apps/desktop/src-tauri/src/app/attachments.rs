//! Attachments (05 §7, 02 §8): files land in `attachments/<id>.<ext>`, hashed with BLAKE3
//! for de-duplication, served to the WebView through the `bianfa-att` custom protocol.

use super::state::AppState;
use crate::db::attachments as db_att;
use crate::error::{IpcError, IpcResult};
use crate::model::{AttachmentInfo, AttachmentRow};
use crate::util::{b64_decode, now_ms, uuid_v7};
use std::borrow::Cow;
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
        state.with_tx(|tx| db_att::link(tx, note_id, &existing.id))?;
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
    state.with_tx(|tx| {
        db_att::insert(tx, &row)?;
        db_att::link(tx, note_id, &id)
    })?;
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
