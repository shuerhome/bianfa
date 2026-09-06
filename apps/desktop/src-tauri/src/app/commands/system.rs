//! 07 §2.3 settings / app / system.

use crate::app::state::AppState;
use crate::app::{events, hotkey, settings, theme, tray, updater, windows};
use crate::error::{IpcError, IpcResult};
use crate::model::{AppInfo, Settings};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> IpcResult<Settings> {
    Ok(state.settings())
}

#[tauri::command]
pub fn settings_set(app: AppHandle, patch: serde_json::Value) -> IpcResult<Settings> {
    let state = app.state::<AppState>();
    let before = state.settings();
    let next = settings::apply_patch(&before, &patch)?;
    settings::save(&state.paths, &next)?;
    state.set_settings(next.clone());

    if next.hotkey_new_note != before.hotkey_new_note {
        hotkey::setup(&app);
    }
    if next.autostart != before.autostart {
        let al = app.autolaunch();
        let r = if next.autostart { al.enable() } else { al.disable() };
        if let Err(e) = r {
            log::warn!("autostart toggle: {e}");
        }
    }
    if next.theme != before.theme {
        theme::apply(&app);
    }
    if next.language != before.language {
        tray::refresh(&app);
    }
    if next.channel != before.channel {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = updater::check(&app2, false).await;
        });
    }
    if next.ui_scale != before.ui_scale {
        // Note windows re-read their constraints on next open; live windows just get the event.
        log::info!("ui scale → {}", next.ui_scale);
    }
    let _ = events::mutate(&app, "local", &["settings"], vec![], |_| Ok(()));
    Ok(next)
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> IpcResult<AppInfo> {
    let os = match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        _ => "linux",
    };
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        os: os.into(),
        arch: std::env::consts::ARCH.into(),
        data_dir: state.paths.data_dir.to_string_lossy().into_owned(),
        install_id: state.install_id.clone(),
        channel: state.settings().channel,
        webview: tauri::webview_version().unwrap_or_else(|_| "unknown".into()),
        is_autostart_launch: state.is_autostart_launch,
        cloud_sync_folder: state.cloud_folder.clone(),
    })
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> IpcResult<serde_json::Value> {
    let al = app.autolaunch();
    if enabled {
        al.enable()?;
    } else {
        al.disable()?;
    }
    let state = app.state::<AppState>();
    let mut s = state.settings();
    s.autostart = enabled;
    settings::save(&state.paths, &s)?;
    state.set_settings(s);
    let method = if cfg!(target_os = "windows") {
        "registry"
    } else {
        "launchagent"
    };
    Ok(serde_json::json!({ "enabled": al.is_enabled().unwrap_or(enabled), "method": method }))
}

#[tauri::command]
pub fn hotkey_set(app: AppHandle, accelerator: String) -> IpcResult<serde_json::Value> {
    let state = app.state::<AppState>();
    let previous = state.settings().hotkey_new_note;
    match hotkey::register(&app, &accelerator) {
        Ok(()) => {
            let mut s = state.settings();
            s.hotkey_new_note = accelerator;
            settings::save(&state.paths, &s)?;
            state.set_settings(s);
            if let Ok(mut g) = state.hotkey_error.lock() {
                *g = None;
            }
            tray::refresh(&app);
            Ok(serde_json::json!({ "ok": true }))
        }
        Err(e) => {
            let _ = hotkey::register(&app, &previous);
            Ok(serde_json::json!({ "ok": false, "error": e }))
        }
    }
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> IpcResult<()> {
    let parsed = url::Url::parse(&url)?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(IpcError::invalid("only http(s) and mailto links can be opened"));
    }
    app.opener().open_url(url, None::<&str>)?;
    Ok(())
}

#[tauri::command]
pub fn open_data_dir(app: AppHandle) -> IpcResult<()> {
    let dir = app.state::<AppState>().paths.data_dir.clone();
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)?;
    Ok(())
}

#[tauri::command]
pub fn theme_current(app: AppHandle) -> IpcResult<serde_json::Value> {
    Ok(serde_json::json!({
        "system": theme::theme_name(theme::system_theme(&app)),
        "effective": theme::theme_name(theme::effective(&app)),
    }))
}

/// Extra (not in 07): lets the settings page count open windows for the "N notes" warning.
#[tauri::command]
pub fn notes_open_count(state: State<'_, AppState>) -> IpcResult<usize> {
    Ok(state.windows.lock().map(|w| w.open_count()).unwrap_or(0))
}

#[allow(dead_code)]
fn _unused(_: &windows::NoteWindows) {}
