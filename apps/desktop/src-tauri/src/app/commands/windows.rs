//! 07 §2.2 windows. Window creation runs in async commands so it never blocks the IPC thread.

use crate::app::events;
use crate::app::state::AppState;
use crate::app::windows::{self, OpenOpts};
use crate::colors::NoteColor;
use crate::db::window_state;
use crate::error::{IpcError, IpcResult};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn note_window_open(
    app: AppHandle,
    note_id: String,
    focus: Option<bool>,
) -> IpcResult<serde_json::Value> {
    let exists = app
        .state::<AppState>()
        .with_db(|c| crate::db::notes::exists(c, &note_id))?;
    if !exists {
        return Err(IpcError::not_found(format!("note {note_id} not found")));
    }
    let label = windows::open_note(
        &app,
        &note_id,
        OpenOpts {
            focus: focus.unwrap_or(true),
            ..Default::default()
        },
    )?;
    Ok(serde_json::json!({ "label": label }))
}

#[tauri::command]
pub fn note_window_close(app: AppHandle, note_id: String) -> IpcResult<()> {
    windows::close_note(&app, &note_id)
}

#[tauri::command]
pub fn note_window_set_zmode(app: AppHandle, note_id: String, z_mode: i64) -> IpcResult<()> {
    windows::set_z_mode(&app, &note_id, z_mode)
}

#[tauri::command]
pub fn note_window_set_collapsed(app: AppHandle, note_id: String, collapsed: bool) -> IpcResult<()> {
    windows::set_collapsed(&app, &note_id, collapsed)
}

#[tauri::command]
pub fn note_window_set_color(app: AppHandle, note_id: String, color: NoteColor) -> IpcResult<()> {
    windows::set_color(&app, &note_id, color)
}

/// Extra (not in 07): macOS `desktopPinReadonly` fallback — lift a desktop-pinned note to edit.
#[tauri::command]
pub fn note_window_desktop_edit(app: AppHandle, note_id: String, editing: bool) -> IpcResult<()> {
    let win = windows::note_window(&app, &note_id)
        .ok_or_else(|| IpcError::not_found(format!("no window open for note {note_id}")))?;
    windows::pin::desktop_edit(&app, &win, editing)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn window_state_save(
    app: AppHandle,
    note_id: String,
    x: i64,
    y: i64,
    w: i64,
    h: i64,
    monitor_key: Option<String>,
    scale: Option<f64>,
) -> IpcResult<()> {
    let exists = app
        .state::<AppState>()
        .with_db(|c| crate::db::notes::exists(c, &note_id))?;
    if !exists {
        return Ok(()); // fresh note that has not been created yet
    }
    events::mutate(&app, "local", &["note_window_state"], vec![note_id.clone()], |tx| {
        window_state::save_geometry(
            tx,
            &note_id,
            &window_state::Geometry {
                x,
                y,
                w,
                h,
                monitor_key,
                scale,
            },
        )
    })
}

#[tauri::command]
pub async fn notes_show_all(app: AppHandle) -> IpcResult<()> {
    windows::show_all(&app)
}

#[tauri::command]
pub fn notes_hide_all(app: AppHandle) -> IpcResult<()> {
    windows::hide_all(&app)
}

#[tauri::command]
pub async fn main_window_open(app: AppHandle, section: Option<String>) -> IpcResult<()> {
    windows::open_main(&app, section.as_deref())
}

#[tauri::command]
pub async fn settings_window_open(app: AppHandle, section: Option<String>) -> IpcResult<()> {
    windows::open_settings(&app, section.as_deref())
}

#[tauri::command]
pub async fn note_new(
    app: AppHandle,
    at_cursor: Option<bool>,
    color: Option<NoteColor>,
) -> IpcResult<serde_json::Value> {
    let id = windows::new_note(&app, at_cursor.unwrap_or(false), color)?;
    Ok(serde_json::json!({ "noteId": id }))
}

#[tauri::command]
pub fn window_start_drag(window: tauri::WebviewWindow) -> IpcResult<()> {
    window.start_dragging()?;
    Ok(())
}
