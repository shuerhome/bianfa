//! Rust → WebView events (07 §3). Everything goes to every window, including the hidden
//! `sync` host.

use super::state::AppState;
use crate::error::IpcResult;
use crate::model::DbChanged;
use tauri::{AppHandle, Emitter, Manager};

pub const DB_CHANGED: &str = "db:changed";
pub const THEME_CHANGED: &str = "theme-changed";
pub const AUTH_CHANGED: &str = "auth:changed";
pub const AUTH_LOGIN_PROGRESS: &str = "auth:login-progress";
pub const UPDATE_AVAILABLE: &str = "update:available";
pub const NOTICE: &str = "notice";
pub const HOTKEY_NEW_NOTE: &str = "hotkey:new-note";
pub const NOTE_FOCUS_REQUEST: &str = "note:focus-request";
pub const SYNC_STATUS: &str = "sync:status";

pub fn emit<T: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: T) {
    if let Err(e) = app.emit(event, payload) {
        log::warn!("emit {event} failed: {e}");
    }
}

pub fn emit_to<T: serde::Serialize + Clone>(app: &AppHandle, label: &str, event: &str, payload: T) {
    if let Err(e) = app.emit_to(label, event, payload) {
        log::warn!("emit_to {label} {event} failed: {e}");
    }
}

/// Runs `f` in one transaction together with `meta.rev++`, then emits `db:changed`.
pub fn mutate<T>(
    app: &AppHandle,
    origin: &str,
    tables: &[&str],
    ids: Vec<String>,
    f: impl FnOnce(&rusqlite::Transaction<'_>) -> IpcResult<T>,
) -> IpcResult<T> {
    let state = app.state::<AppState>();
    let (out, rev) = state.with_tx(|tx| {
        let out = f(tx)?;
        let rev = crate::db::bump_rev(tx)?;
        Ok((out, rev))
    })?;
    emit(
        app,
        DB_CHANGED,
        DbChanged {
            rev,
            origin: origin.to_string(),
            tables: tables.iter().map(|s| s.to_string()).collect(),
            ids,
        },
    );
    Ok(out)
}

pub fn login_progress(app: &AppHandle, phase: &str, message: Option<String>) {
    emit(
        app,
        AUTH_LOGIN_PROGRESS,
        serde_json::json!({ "phase": phase, "message": message }),
    );
}
