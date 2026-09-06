//! The one global hotkey: `Ctrl+Alt+N` / `⌥⌘N` = new note at the cursor (05 §4.2).

use super::state::AppState;
use super::{events, tray, windows};
use std::str::FromStr;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub fn register(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let shortcut = Shortcut::from_str(accelerator).map_err(|e| e.to_string())?;
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    gs.on_shortcut(shortcut, |app, _sc, event| {
        if event.state != ShortcutState::Pressed {
            return;
        }
        let app = app.clone();
        let _ = app.run_on_main_thread(move || match windows::new_note(&app, true, None) {
            Ok(_) => events::emit(&app, events::HOTKEY_NEW_NOTE, serde_json::json!({})),
            Err(e) => log::warn!("hotkey new note: {e}"),
        });
    })
    .map_err(|e| e.to_string())
}

/// Registers the configured hotkey; failures become a tray warning, never a dialog.
pub fn setup(app: &AppHandle) {
    let acc = app.state::<AppState>().settings().hotkey_new_note;
    let result = register(app, &acc);
    if let Ok(mut g) = app.state::<AppState>().hotkey_error.lock() {
        *g = result.as_ref().err().cloned();
    }
    if let Err(e) = &result {
        log::warn!("global hotkey {acc} unavailable: {e}");
    }
    tray::refresh(app);
}
