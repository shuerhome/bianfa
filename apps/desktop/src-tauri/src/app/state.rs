//! Process-wide state managed by Tauri (`app.state::<AppState>()`).

use super::auth::AuthState;
use super::keys::SecretStore;
use super::windows::NoteWindows;
use crate::db::Db;
use crate::error::{IpcError, IpcResult};
use crate::model::{Notice, Settings};
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, RwLock};

/// All on-disk locations (05 §7.1).
#[derive(Debug, Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub attachments_dir: PathBuf,
    pub imports_dir: PathBuf,
    pub export_dir: PathBuf,
    pub backups_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub settings_file: PathBuf,
    pub install_id_file: PathBuf,
    pub profile_file: PathBuf,
    pub secrets_dir: PathBuf,
}

impl Paths {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            db_path: data_dir.join(crate::db::DB_FILE),
            attachments_dir: data_dir.join("attachments"),
            imports_dir: data_dir.join("imports"),
            export_dir: data_dir.join("export"),
            backups_dir: data_dir.join("backups"),
            logs_dir: data_dir.join("logs"),
            settings_file: data_dir.join("settings.json"),
            install_id_file: data_dir.join("install_id"),
            profile_file: data_dir.join("profile.json"),
            secrets_dir: data_dir.join(".secrets"),
            data_dir,
        }
    }

    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        for d in [
            &self.data_dir,
            &self.attachments_dir,
            &self.imports_dir,
            &self.export_dir,
            &self.backups_dir,
            &self.logs_dir,
        ] {
            std::fs::create_dir_all(d)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub state: String,
    pub at: i64,
    pub detail: Option<String>,
}

pub struct AppState {
    pub paths: Paths,
    pub db: Mutex<Option<Db>>,
    pub db_error: Mutex<Option<IpcError>>,
    pub settings: RwLock<Settings>,
    pub windows: Mutex<NoteWindows>,
    pub auth: AuthState,
    pub secrets: SecretStore,
    pub http: reqwest::Client,
    pub install_id: String,
    pub is_autostart_launch: bool,
    pub cloud_folder: Option<String>,
    pub hotkey_error: Mutex<Option<String>>,
    pub pending_update: Mutex<Option<tauri_plugin_updater::Update>>,
    pub sync_status: Mutex<SyncStatus>,
    pub notice: Mutex<Option<Notice>>,
    /// Set by a `block` notice: updater / sync / network are disabled, local notes keep working.
    pub network_blocked: AtomicBool,
}

impl AppState {
    /// Runs `f` with the open connection; `db` error if the database failed to open.
    pub fn with_db<T>(&self, f: impl FnOnce(&Connection) -> IpcResult<T>) -> IpcResult<T> {
        let guard = self
            .db
            .lock()
            .map_err(|_| IpcError::db("database lock poisoned"))?;
        match guard.as_ref() {
            Some(db) => f(db.conn()),
            None => Err(self.db_unavailable()),
        }
    }

    /// Runs `f` inside a transaction (committed when `f` returns `Ok`).
    pub fn with_tx<T>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction<'_>) -> IpcResult<T>,
    ) -> IpcResult<T> {
        let mut guard = self
            .db
            .lock()
            .map_err(|_| IpcError::db("database lock poisoned"))?;
        let Some(db) = guard.as_mut() else {
            return Err(self.db_unavailable());
        };
        let tx = db.conn_mut().transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    fn db_unavailable(&self) -> IpcError {
        self.db_error
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_else(|| IpcError::db("database unavailable"))
    }

    pub fn settings(&self) -> Settings {
        self.settings
            .read()
            .map(|s| s.clone())
            .unwrap_or_default()
    }

    pub fn set_settings(&self, s: Settings) {
        if let Ok(mut g) = self.settings.write() {
            *g = s;
        }
    }
}

/// Minimal logger: stderr + `logs/bianfa.log` (last lines end up in diagnostics bundles).
pub struct FileLogger {
    file: Mutex<Option<std::fs::File>>,
}

impl FileLogger {
    pub fn install(logs_dir: &std::path::Path) {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs_dir.join("bianfa.log"))
            .ok();
        let logger = Box::new(FileLogger {
            file: Mutex::new(file),
        });
        if log::set_boxed_logger(logger).is_ok() {
            log::set_max_level(if cfg!(debug_assertions) {
                log::LevelFilter::Debug
            } else {
                log::LevelFilter::Info
            });
        }
    }
}

impl log::Log for FileLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
            && (metadata.target().starts_with("bianfa") || metadata.level() <= log::Level::Warn)
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "{} {:<5} {} — {}\n",
            crate::util::ms_to_iso(crate::util::now_ms()).unwrap_or_default(),
            record.level(),
            record.target(),
            record.args()
        );
        eprint!("{line}");
        if let Ok(mut g) = self.file.lock() {
            if let Some(f) = g.as_mut() {
                use std::io::Write;
                let _ = f.write_all(line.as_bytes());
            }
        }
    }

    fn flush(&self) {}
}
