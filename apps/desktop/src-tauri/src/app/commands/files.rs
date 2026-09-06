//! 07 §2.5 attachments, import, export, updater, notices.

use crate::app::state::AppState;
use crate::app::{attachments, events, notices, updater, windows};
use crate::db::{imports, notes, window_state};
use crate::error::{IpcError, IpcResult};
use crate::import::{self, ImportPreview, ImportSource};
use crate::model::{AttachmentInfo, ImportCommitItem, ImportCommitResult, Notice};
use crate::util::b64_decode;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn attachment_import(
    app: AppHandle,
    note_id: String,
    source_path: Option<String>,
    bytes_b64: Option<String>,
    mime: Option<String>,
) -> IpcResult<AttachmentInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        attachments::import(
            &app,
            &note_id,
            source_path.as_deref(),
            bytes_b64.as_deref(),
            mime.as_deref(),
        )
    })
    .await
    .map_err(|e| IpcError::internal(e.to_string()))?
}

#[tauri::command]
pub fn attachment_local_url(id: String) -> IpcResult<serde_json::Value> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return Err(IpcError::invalid("bad attachment id"));
    }
    Ok(serde_json::json!({ "url": attachments::local_url(&id) }))
}

#[tauri::command]
pub async fn import_scan(app: AppHandle) -> IpcResult<serde_json::Value> {
    let scratch = app.state::<AppState>().paths.imports_dir.clone();
    let sources: Vec<ImportSource> = tauri::async_runtime::spawn_blocking(move || import::scan(&scratch))
        .await
        .map_err(|e| IpcError::internal(e.to_string()))?;
    Ok(serde_json::json!({ "sources": sources }))
}

#[tauri::command]
pub async fn import_preview(app: AppHandle, path: String) -> IpcResult<ImportPreview> {
    let imports_dir = app.state::<AppState>().paths.imports_dir.clone();
    tauri::async_runtime::spawn_blocking(move || import::preview(Path::new(&path), &imports_dir))
        .await
        .map_err(|e| IpcError::internal(e.to_string()))?
}

fn source_kind(path: &str) -> IpcResult<&'static str> {
    import::kind_of(Path::new(path)).ok_or_else(|| IpcError::invalid("unsupported import file"))
}

/// Imported window rects are logical pixels from the old app; convert with the primary
/// monitor's scale, then run the usual on-screen check (02 §7).
fn imported_geometry(app: &AppHandle, w: &crate::model::ImportWindow) -> Option<window_state::Geometry> {
    let (x, y, wd, ht) = (w.x?, w.y?, w.w?, w.h?);
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let rect = windows::sanitize_rect(
        app,
        windows::Rect {
            x: (x as f64 * scale) as i32,
            y: (y as f64 * scale) as i32,
            w: ((wd.max(1) as f64) * scale) as u32,
            h: ((ht.max(1) as f64) * scale) as u32,
        },
    );
    Some(window_state::Geometry {
        x: rect.x as i64,
        y: rect.y as i64,
        w: rect.w as i64,
        h: rect.h as i64,
        monitor_key: None,
        scale: Some(scale),
    })
}

#[tauri::command]
pub fn import_commit(
    app: AppHandle,
    path: String,
    items: Vec<ImportCommitItem>,
) -> IpcResult<ImportCommitResult> {
    let source = source_kind(&path)?;
    let archived_to = app
        .state::<AppState>()
        .paths
        .imports_dir
        .to_string_lossy()
        .into_owned();
    let mut decoded: Vec<(ImportCommitItem, Vec<u8>)> = Vec::with_capacity(items.len());
    for it in items {
        let bytes = b64_decode(&it.update_v2_b64)?;
        decoded.push((it, bytes));
    }
    let geometries: Vec<Option<window_state::Geometry>> = decoded
        .iter()
        .map(|(it, _)| it.window.as_ref().and_then(|w| imported_geometry(&app, w)))
        .collect();
    let ids: Vec<String> = decoded.iter().map(|(it, _)| it.note_id.clone()).collect();
    let degraded = decoded.iter().filter(|(it, _)| it.degraded).count() as i64;
    let ink = decoded.iter().filter(|(it, _)| it.has_ink).count() as i64;

    let result = events::mutate(
        &app,
        "import",
        &["notes", "ydoc_updates", "note_window_state", "imports"],
        ids,
        |tx| {
            let mut r = ImportCommitResult::default();
            for ((it, bytes), geom) in decoded.iter().zip(geometries.iter()) {
                match notes::find_by_import(tx, source, &it.external_id)? {
                    None => {
                        notes::create(
                            tx,
                            &it.note_id,
                            bytes,
                            &it.projection,
                            None,
                            Some(source),
                            Some(&it.external_id),
                            "import",
                        )?;
                        window_state::set_is_open(tx, &it.note_id, it.is_open)?;
                        if it.projection.z_mode != 0 {
                            window_state::set_z_mode(tx, &it.note_id, it.projection.z_mode)?;
                        }
                        if let Some(g) = geom {
                            window_state::save_geometry(tx, &it.note_id, g)?;
                        }
                        r.imported += 1;
                    }
                    Some((existing_id, existing_updated_at)) => {
                        let newer = it
                            .source_updated_at
                            .map(|s| s > existing_updated_at)
                            .unwrap_or(false);
                        if newer {
                            notes::append_update(tx, &existing_id, bytes, "import", Some(&it.projection))?;
                            r.updated += 1;
                        } else {
                            r.skipped += 1;
                        }
                    }
                }
            }
            imports::insert(
                tx,
                &imports::ImportRecord {
                    source,
                    source_path: &path,
                    archived_to: &archived_to,
                    note_count: r.imported + r.updated,
                    degraded_count: degraded,
                    ink_count: ink,
                },
            )?;
            Ok(r)
        },
    )?;
    Ok(result)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    pub rel_path: String,
    pub content_b64: String,
}

fn safe_join(base: &Path, rel: &str) -> IpcResult<PathBuf> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute()
        || rel_path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(IpcError::invalid(format!("unsafe relative path: {rel}")));
    }
    Ok(base.join(rel_path))
}

#[tauri::command]
pub fn export_write(out_dir: String, files: Vec<ExportFile>) -> IpcResult<serde_json::Value> {
    let base = PathBuf::from(&out_dir);
    if !base.is_dir() {
        return Err(IpcError::not_found(format!("{out_dir} is not a directory")));
    }
    let mut written = 0;
    for f in files {
        let target = safe_join(&base, &f.rel_path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&target, b64_decode(&f.content_b64)?)?;
        written += 1;
    }
    Ok(serde_json::json!({ "written": written }))
}

#[derive(Debug, serde::Deserialize)]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

fn file_path_to_string(p: tauri_plugin_dialog::FilePath) -> Option<String> {
    p.into_path().ok().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn pick_directory(app: AppHandle, title: Option<String>) -> IpcResult<serde_json::Value> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut b = app.dialog().file();
        if let Some(t) = title {
            b = b.set_title(t);
        }
        b.blocking_pick_folder().and_then(file_path_to_string)
    })
    .await
    .map_err(|e| IpcError::internal(e.to_string()))?;
    Ok(serde_json::json!({ "path": picked }))
}

#[tauri::command]
pub async fn pick_file(
    app: AppHandle,
    title: Option<String>,
    filters: Option<Vec<DialogFilter>>,
) -> IpcResult<serde_json::Value> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut b = app.dialog().file();
        if let Some(t) = title {
            b = b.set_title(t);
        }
        for f in filters.unwrap_or_default() {
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            b = b.add_filter(f.name.clone(), &exts);
        }
        b.blocking_pick_file().and_then(file_path_to_string)
    })
    .await
    .map_err(|e| IpcError::internal(e.to_string()))?;
    Ok(serde_json::json!({ "path": picked }))
}

#[tauri::command]
pub async fn update_check(app: AppHandle, manual: Option<bool>) -> IpcResult<updater::UpdateCheck> {
    updater::check(&app, manual.unwrap_or(false)).await
}

#[tauri::command]
pub async fn update_install(app: AppHandle) -> IpcResult<()> {
    updater::install(&app).await
}

#[tauri::command]
pub async fn notice_get(app: AppHandle) -> IpcResult<serde_json::Value> {
    let notice: Option<Notice> = match notices::current(&app) {
        Some(n) => Some(n),
        None => notices::fetch(&app).await?,
    };
    Ok(serde_json::json!({ "notice": notice }))
}

#[tauri::command]
pub fn notice_ack(app: AppHandle, id: String) -> IpcResult<()> {
    notices::ack(&app, &id)
}

#[allow(dead_code)]
fn _state_marker(_: State<'_, AppState>) {}
