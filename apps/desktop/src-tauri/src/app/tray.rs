//! Tray icon + menu (05 §4.1). Same model on both platforms; click semantics differ:
//! Windows left-click = new note / right-click = menu, macOS left-click = menu.

use super::state::{AppState, SyncStatus};
use super::windows;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

pub const TRAY_ID: &str = "main";

pub struct TrayState {
    pub status_item: std::sync::Mutex<Option<MenuItem<tauri::Wry>>>,
    pub warn_item: std::sync::Mutex<Option<MenuItem<tauri::Wry>>>,
}

pub struct Strings {
    pub new_note: &'static str,
    pub open_list: &'static str,
    pub show_all: &'static str,
    pub hide_all: &'static str,
    pub local_mode: &'static str,
    pub settings: &'static str,
    pub quit: &'static str,
    pub hotkey_taken: &'static str,
    pub too_many: &'static str,
    pub synced: &'static str,
    pub syncing: &'static str,
    pub offline: &'static str,
    pub error: &'static str,
    pub update_ready: &'static str,
}

pub const ZH: Strings = Strings {
    new_note: "新建便笺",
    open_list: "打开便笺列表",
    show_all: "显示全部便笺",
    hide_all: "隐藏全部便笺",
    local_mode: "● 本地模式",
    settings: "设置…",
    quit: "退出 bianfa",
    hotkey_taken: "新建便笺的快捷键被占用 · 去设置",
    too_many: "桌面上便笺较多，建议收起一些",
    synced: "● 已同步",
    syncing: "● 正在同步…",
    offline: "● 离线",
    error: "● 同步出错",
    update_ready: "有更新可用 · 立即重启",
};

pub const EN: Strings = Strings {
    new_note: "New note",
    open_list: "Open note list",
    show_all: "Show all notes",
    hide_all: "Hide all notes",
    local_mode: "● Local mode",
    settings: "Settings…",
    quit: "Quit bianfa",
    hotkey_taken: "New-note hotkey is taken · Open settings",
    too_many: "Many notes on the desktop — consider hiding some",
    synced: "● Synced",
    syncing: "● Syncing…",
    offline: "● Offline",
    error: "● Sync error",
    update_ready: "Update available · Restart now",
};

pub fn strings(app: &AppHandle) -> &'static Strings {
    let settings = app.state::<AppState>().settings();
    let locale = sys_locale::get_locale();
    match settings.effective_language(locale.as_deref()) {
        "en" => &EN,
        _ => &ZH,
    }
}

fn accelerator_text() -> &'static str {
    if cfg!(target_os = "macos") {
        "Alt+Cmd+N"
    } else {
        "Ctrl+Alt+N"
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<(Menu<tauri::Wry>, MenuItem<tauri::Wry>, MenuItem<tauri::Wry>)> {
    let t = strings(app);
    let state = app.state::<AppState>();
    let warn_text = state
        .hotkey_error
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|_| t.hotkey_taken.to_string()))
        .or_else(|| {
            let n = state.windows.lock().map(|w| w.open_count()).unwrap_or(0);
            (n > windows::VISIBLE_SOFT_CAP).then(|| t.too_many.to_string())
        })
        .or_else(|| {
            state
                .pending_update
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|_| t.update_ready.to_string()))
        });
    let warn = MenuItem::with_id(app, "warn", warn_text.clone().unwrap_or_default(), true, None::<&str>)?;
    let new_note = MenuItem::with_id(app, "new", t.new_note, true, Some(accelerator_text()))?;
    let open_list = MenuItem::with_id(app, "list", t.open_list, true, None::<&str>)?;
    let show_all = MenuItem::with_id(app, "show-all", t.show_all, true, None::<&str>)?;
    let hide_all = MenuItem::with_id(app, "hide-all", t.hide_all, true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", status_text(app), false, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", t.settings, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", t.quit, true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::new(app)?;
    if warn_text.is_some() {
        menu.append(&warn)?;
        menu.append(&sep()?)?;
    }
    menu.append(&new_note)?;
    menu.append(&sep()?)?;
    menu.append(&open_list)?;
    menu.append(&show_all)?;
    menu.append(&hide_all)?;
    menu.append(&sep()?)?;
    menu.append(&status)?;
    menu.append(&sep()?)?;
    menu.append(&settings)?;
    menu.append(&quit)?;
    Ok((menu, status, warn))
}

fn status_text(app: &AppHandle) -> String {
    let t = strings(app);
    let st: SyncStatus = app
        .state::<AppState>()
        .sync_status
        .lock()
        .map(|s| s.clone())
        .unwrap_or_default();
    let base = match st.state.as_str() {
        "synced" => t.synced,
        "syncing" => t.syncing,
        "offline" => t.offline,
        "error" => t.error,
        _ => t.local_mode,
    };
    match st.detail {
        Some(d) if !d.is_empty() => format!("{base} · {d}"),
        _ => base.to_string(),
    }
}

fn handle_menu(app: &AppHandle, id: &str) {
    let app = app.clone();
    match id {
        "new" => {
            tauri::async_runtime::spawn(async move {
                let _ = app.run_on_main_thread(move || {
                    if let Err(e) = windows::new_note(&app, true, None) {
                        log::warn!("tray new note: {e}");
                    }
                });
            });
        }
        "list" => {
            let _ = windows::open_main(&app, Some("notes"));
        }
        "show-all" => {
            let _ = windows::show_all(&app);
        }
        "hide-all" => {
            let _ = windows::hide_all(&app);
        }
        "settings" => {
            let _ = windows::open_settings(&app, None);
        }
        "warn" => {
            let has_update = app
                .state::<AppState>()
                .pending_update
                .lock()
                .map(|g| g.is_some())
                .unwrap_or(false);
            let hotkey_err = app
                .state::<AppState>()
                .hotkey_error
                .lock()
                .map(|g| g.is_some())
                .unwrap_or(false);
            if hotkey_err {
                let _ = windows::open_settings(&app, Some("shortcuts"));
            } else if has_update {
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = super::updater::install(&app).await {
                        log::warn!("update install: {e}");
                    }
                });
            } else {
                let _ = windows::open_main(&app, Some("notes"));
            }
        }
        "quit" => {
            super::shutdown(&app);
            app.exit(0);
        }
        _ => {}
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let (menu, status, warn) = build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("bianfa")
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray: &TrayIcon, event: TrayIconEvent| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if cfg!(target_os = "windows") {
                    handle_menu(tray.app_handle(), "new");
                }
            }
        });
    #[cfg(target_os = "macos")]
    {
        match tauri::image::Image::from_bytes(include_bytes!("../../icons/tray.png")) {
            Ok(img) => builder = builder.icon(img).icon_as_template(true),
            Err(e) => log::warn!("tray template icon: {e}"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
    }
    builder.build(app)?;
    app.manage(TrayState {
        status_item: std::sync::Mutex::new(Some(status)),
        warn_item: std::sync::Mutex::new(Some(warn)),
    });
    Ok(())
}

/// Rebuilds the menu (language / warning row / status text changed).
pub fn refresh(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    match build_menu(app) {
        Ok((menu, status, warn)) => {
            let _ = tray.set_menu(Some(menu));
            if let Some(ts) = app.try_state::<TrayState>() {
                if let Ok(mut g) = ts.status_item.lock() {
                    *g = Some(status);
                }
                if let Ok(mut g) = ts.warn_item.lock() {
                    *g = Some(warn);
                }
            }
        }
        Err(e) => log::warn!("tray menu rebuild: {e}"),
    }
    let _ = tray.set_tooltip(Some(format!("bianfa · {}", status_text(app).trim_start_matches("● "))));
}

/// Sync status from the JS sync layer (`sync:status` event or `sync_status_report`).
pub fn set_sync_status(app: &AppHandle, status: SyncStatus) {
    if let Ok(mut g) = app.state::<AppState>().sync_status.lock() {
        *g = status;
    }
    let text = status_text(app);
    if let Some(ts) = app.try_state::<TrayState>() {
        if let Ok(g) = ts.status_item.lock() {
            if let Some(item) = g.as_ref() {
                let _ = item.set_text(&text);
            }
        }
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(format!("bianfa · {}", text.trim_start_matches("● "))));
    }
}
