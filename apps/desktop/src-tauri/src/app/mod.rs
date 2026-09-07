//! Tauri runtime wiring: plugins (single-instance first), custom protocol, window hooks,
//! command table, startup sequence, deep links and shutdown.

pub mod attachments;
pub mod auth;
pub mod commands;
pub mod events;
pub mod hotkey;
pub mod keys;
pub mod notices;
pub mod settings;
pub mod state;
pub mod theme;
pub mod tray;
pub mod updater;
pub mod windows;

use crate::db::{self, Db, OpenError};
use crate::error::IpcError;
use state::{AppState, FileLogger, Paths};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Listener, Manager, RunEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_deep_link::DeepLinkExt;

pub fn run() {
    let is_autostart = std::env::args().any(|a| a == "--autostart");
    let builder = tauri::Builder::default()
        // single-instance MUST be the first plugin (05 §4.3).
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            handle_second_instance(app, argv);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .register_uri_scheme_protocol(attachments::SCHEME, attachments::protocol_handler)
        .on_window_event(windows::on_window_event)
        .on_page_load(windows::on_page_load)
        .invoke_handler(tauri::generate_handler![
            // notes & local store
            commands::notes::notes_list,
            commands::notes::notes_search,
            commands::notes::note_get,
            commands::notes::note_create,
            commands::notes::note_load_doc,
            commands::notes::note_append_update,
            commands::notes::note_updates_since,
            commands::notes::note_write_snapshot,
            commands::notes::note_compact,
            commands::notes::note_discard_if_empty,
            commands::notes::note_set_synced,
            commands::notes::notes_pending_sync,
            commands::notes::trash_empty,
            commands::notes::notes_purge_expired,
            commands::notes::note_version_save,
            commands::notes::note_versions_list,
            commands::notes::note_version_get,
            commands::notes::sync_state_set_error,
            commands::notes::sync_errors_list,
            commands::notes::sync_status_report,
            commands::notes::window_state_get,
            commands::notes::todos_list,
            commands::notes::todos_counts,
            // windows
            commands::windows::note_window_open,
            commands::windows::note_window_close,
            commands::windows::note_window_set_zmode,
            commands::windows::note_window_set_collapsed,
            commands::windows::note_window_set_color,
            commands::windows::note_window_desktop_edit,
            commands::windows::window_state_save,
            commands::windows::notes_show_all,
            commands::windows::notes_hide_all,
            commands::windows::main_window_open,
            commands::windows::settings_window_open,
            commands::windows::note_new,
            commands::windows::window_start_drag,
            // settings / app / system
            commands::system::settings_get,
            commands::system::settings_set,
            commands::system::app_info,
            commands::system::autostart_set,
            commands::system::hotkey_set,
            commands::system::open_external,
            commands::system::open_data_dir,
            commands::system::theme_current,
            commands::system::notes_open_count,
            // auth & network
            commands::auth::auth_status,
            commands::auth::auth_login_start,
            commands::auth::auth_login_device_start,
            commands::auth::auth_login_cancel,
            commands::auth::auth_logout,
            commands::auth::auth_sync_token,
            commands::auth::api_request,
            // attachments / import / export / updater / notices
            commands::files::attachment_import,
            commands::files::attachment_upload,
            commands::files::attachments_pending_upload,
            commands::files::attachment_local_url,
            commands::files::import_scan,
            commands::files::import_preview,
            commands::files::import_commit,
            commands::files::export_write,
            commands::files::pick_directory,
            commands::files::pick_file,
            commands::files::update_check,
            commands::files::update_install,
            commands::files::notice_get,
            commands::files::notice_ack,
        ])
        .setup(move |app| {
            setup(app.handle().clone(), is_autostart)
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error>)
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building bianfa");

    app.run(|app, event| match event {
        // Closing the last window keeps the app alive in the tray (05 §2.3).
        RunEvent::ExitRequested {
            code: None, api, ..
        } => api.prevent_exit(),
        RunEvent::Exit => shutdown(app),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => {
            let _ = windows::open_main(app, None);
        }
        _ => {}
    });
}

/// Opens the database; on corruption restores the newest backup (never rebuilds silently).
fn open_database(paths: &Paths, key: &str) -> Result<Db, IpcError> {
    match Db::open(&paths.db_path, key) {
        Ok(db) => Ok(db),
        Err(OpenError::Corrupt { moved_to }) => {
            log::error!("database corrupt, moved to {}", moved_to.display());
            let newest = std::fs::read_dir(&paths.backups_dir)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().map(|e| e == "db").unwrap_or(false))
                .max();
            match newest {
                Some(b) => {
                    log::warn!("restoring backup {}", b.display());
                    std::fs::copy(&b, &paths.db_path)?;
                    Db::open(&paths.db_path, key).map_err(|e| e.to_ipc())
                }
                None => Err(OpenError::Corrupt { moved_to }.to_ipc()),
            }
        }
        Err(e) => Err(e.to_ipc()),
    }
}

fn setup(app: AppHandle, is_autostart: bool) -> Result<(), IpcError> {
    let data_dir = app.path().app_local_data_dir()?;
    let paths = Paths::new(data_dir);
    paths.ensure_dirs()?;
    FileLogger::install(&paths.logs_dir);
    log::info!(
        "bianfa {} starting (autostart={is_autostart})",
        app.package_info().version
    );

    let install_id = settings::install_id(&paths);
    let settings = settings::load(&paths);
    let secrets = keys::SecretStore::new(paths.secrets_dir.clone());
    let device_id = secrets.device_id().unwrap_or_else(|e| {
        log::error!("device id: {e}");
        crate::util::uuid_v7()
    });

    let (db, db_error) = match secrets.db_key() {
        Ok(key) => match open_database(&paths, &key) {
            Ok(db) => (Some(db), None),
            Err(e) => {
                log::error!("database open failed: {e}");
                (None, Some(e))
            }
        },
        Err(e) => {
            log::error!("keyring: {e}");
            (None, Some(e))
        }
    };
    let cloud_folder = db::cloud_folder_hint(&paths.data_dir);
    if let Some(c) = &cloud_folder {
        log::warn!("data directory is inside a {c} folder");
    }

    let http = reqwest::Client::builder()
        .user_agent(format!("bianfa-desktop/{}", app.package_info().version))
        .build()?;

    app.manage(AppState {
        paths,
        db: Mutex::new(db),
        db_error: Mutex::new(db_error),
        settings: std::sync::RwLock::new(settings),
        windows: Mutex::new(windows::NoteWindows::default()),
        auth: auth::AuthState::new(device_id),
        secrets,
        http,
        install_id,
        is_autostart_launch: is_autostart,
        cloud_folder,
        hotkey_error: Mutex::new(None),
        pending_update: Mutex::new(None),
        sync_status: Mutex::new(state::SyncStatus {
            state: "local".into(),
            at: crate::util::now_ms(),
            detail: None,
        }),
        notice: Mutex::new(None),
        network_blocked: std::sync::atomic::AtomicBool::new(false),
    });

    // Housekeeping: purge expired trash, daily backup (off the main thread).
    {
        let app2 = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let st = app2.state::<AppState>();
            match st.with_tx(|tx| crate::db::notes::purge_expired(tx)) {
                Ok(n) if n > 0 => log::info!("purged {n} expired notes"),
                Err(e) => log::warn!("purge: {e}"),
                _ => {}
            }
            let backups = st.paths.backups_dir.clone();
            {
                let guard = st.db.lock();
                if let Ok(g) = guard {
                    if let Some(db) = g.as_ref() {
                        match db.backup_daily(&backups) {
                            Ok(Some(p)) => log::info!("backup written: {}", p.display()),
                            Err(e) => log::warn!("backup: {e}"),
                            _ => {}
                        }
                    }
                }
            }
        });
    }

    if let Err(e) = tray::setup(&app) {
        log::error!("tray: {e}");
    }
    hotkey::setup(&app);
    windows::pin::setup(&app);
    theme::apply(&app);
    let _ = app.autolaunch_sync_setting();

    // Forward the JS sync layer's `sync:status` events to the tray.
    {
        let app2 = app.clone();
        app.listen_any(events::SYNC_STATUS, move |event| {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                tray::set_sync_status(
                    &app2,
                    state::SyncStatus {
                        state: v["state"].as_str().unwrap_or("local").to_string(),
                        at: v["at"].as_i64().unwrap_or_else(crate::util::now_ms),
                        detail: v["detail"].as_str().map(|s| s.to_string()),
                    },
                );
            }
        });
    }

    // Deep links (`bianfa://note/<uuid>`, `bianfa://auth`).
    {
        let app2 = app.clone();
        app.deep_link().on_open_url(move |event| {
            for url in event.urls() {
                handle_deep_link(&app2, url.as_str());
            }
        });
        #[cfg(all(debug_assertions, any(target_os = "windows", target_os = "linux")))]
        {
            if let Err(e) = app.deep_link().register_all() {
                log::warn!("deep-link dev registration: {e}");
            }
        }
    }

    // Windows and notes.
    windows::prewarm(&app);
    let restored = windows::restore_open_notes(&app);
    let initial_links: Vec<String> = app
        .deep_link()
        .get_current()
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .map(|u| u.to_string())
        .collect();
    let has_link = !initial_links.is_empty();
    for u in initial_links {
        handle_deep_link(&app, &u);
    }
    if !is_autostart && restored == 0 && !has_link {
        if let Err(e) = windows::open_main(&app, None) {
            log::error!("main window: {e}");
        }
    }
    tray::refresh(&app);

    // Network-facing background work.
    auth::init(&app);
    updater::schedule(&app);
    notices::schedule(&app);
    check_webview_runtime(&app);

    // Timers: dock maintenance (3 s) and hide-all auto-close (30 s).
    {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut n: u64 = 0;
            loop {
                tokio::time::sleep(Duration::from_secs(3)).await;
                n += 1;
                let a = app2.clone();
                let _ = app2.run_on_main_thread(move || windows::pin::tick(&a));
                if n.is_multiple_of(10) {
                    let a = app2.clone();
                    let _ = app2.run_on_main_thread(move || windows::hidden_tick(&a));
                }
            }
        });
    }
    Ok(())
}

trait AutostartSync {
    fn autolaunch_sync_setting(&self) -> Result<(), IpcError>;
}

impl AutostartSync for AppHandle {
    /// Keeps the OS autostart entry in line with `settings.autostart`.
    fn autolaunch_sync_setting(&self) -> Result<(), IpcError> {
        use tauri_plugin_autostart::ManagerExt;
        let want = self.state::<AppState>().settings().autostart;
        let al = self.autolaunch();
        let have = al.is_enabled().unwrap_or(false);
        if want != have {
            if want {
                al.enable()?;
            } else {
                al.disable()?;
            }
        }
        Ok(())
    }
}

/// WebView2 ≥ 140 is the baseline (18-裁决2); older runtimes get a notification.
fn check_webview_runtime(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        use tauri_plugin_notification::NotificationExt;
        if let Ok(v) = tauri::webview_version() {
            let major: u32 = v
                .split('.')
                .next()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            if major > 0 && major < 140 {
                log::warn!("WebView2 runtime {v} is older than 140");
                let _ = app
                    .notification()
                    .builder()
                    .title("bianfa")
                    .body("WebView2 运行时版本过旧，请通过 Windows 更新或 Microsoft Edge 更新它。")
                    .show();
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

fn handle_second_instance(app: &AppHandle, argv: Vec<String>) {
    log::info!("second instance: {argv:?}");
    if let Some(link) = argv.iter().find(|a| a.starts_with("bianfa://")) {
        handle_deep_link(app, link);
        return;
    }
    if argv.iter().any(|a| a == "--new-note") {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            if let Err(e) = windows::new_note(&app, true, None) {
                log::warn!("new note: {e}");
            }
        });
        return;
    }
    let _ = windows::open_main(app, None);
}

/// `bianfa://note/<uuid>` → open/focus; `bianfa://auth?...` reserved (M2); others ignored.
pub fn handle_deep_link(app: &AppHandle, link: &str) {
    let Ok(url) = url::Url::parse(link) else {
        log::warn!("bad deep link {link}");
        return;
    };
    if url.scheme() != "bianfa" {
        return;
    }
    match url.host_str() {
        Some("note") => {
            let id = url.path().trim_matches('/').to_string();
            if uuid::Uuid::parse_str(&id).is_err() {
                log::warn!("deep link with invalid note id");
                return;
            }
            let app = app.clone();
            let _ = app.clone().run_on_main_thread(move || {
                if let Err(e) = windows::focus_note(&app, &id) {
                    log::warn!("deep link note {id}: {e}");
                    let _ = windows::open_main(&app, Some("notes"));
                    events::emit(
                        &app,
                        "deeplink:missing",
                        serde_json::json!({ "noteId": id }),
                    );
                }
            });
        }
        Some("auth") => {
            log::info!("bianfa://auth callback received (loopback is the primary path)")
        }
        other => log::info!("ignored deep link host {other:?}"),
    }
}

/// Flushes window geometry and marks a clean exit.
pub fn shutdown(app: &AppHandle) {
    let labels: Vec<String> = app
        .state::<AppState>()
        .windows
        .lock()
        .map(|w| w.labels())
        .unwrap_or_default();
    for l in labels {
        windows::save_window_geometry(app, &l);
    }
    if let Ok(g) = app.state::<AppState>().db.lock() {
        if let Some(db) = g.as_ref() {
            let _ = db.mark_clean_exit(true);
        }
    }
}

/// "注销并删除本机数据": database, attachments, imports, backups, keyring entries — then restart.
pub fn wipe_local(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(mut g) = state.db.lock() {
        *g = None;
    }
    let p = &state.paths;
    for f in [&p.db_path, &p.profile_file] {
        let _ = std::fs::remove_file(f);
    }
    for suffix in ["-wal", "-shm"] {
        let mut s = p.db_path.as_os_str().to_owned();
        s.push(suffix);
        let _ = std::fs::remove_file(std::path::PathBuf::from(s));
    }
    for d in [
        &p.attachments_dir,
        &p.imports_dir,
        &p.backups_dir,
        &p.secrets_dir,
    ] {
        let _ = std::fs::remove_dir_all(d);
    }
    auth::secrets_wipe(&state.secrets);
    log::warn!("local data wiped; restarting");
    app.restart();
}
