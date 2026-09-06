//! SQLCipher-backed local database (05 §7, 02 §2).
//!
//! `Db` owns one `rusqlite::Connection`. Commands lock it through `AppState`. All query
//! functions live in submodules and take `&Connection` so they work inside transactions.

pub mod attachments;
pub mod imports;
pub mod notes;
pub mod schema;
pub mod sync_state;
pub mod versions;
pub mod window_state;

use crate::error::{IpcError, IpcResult};
use crate::util::now_ms;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::path::{Path, PathBuf};

pub const DB_FILE: &str = "bianfa.sqlite";
pub const BACKUP_KEEP: usize = 14;
pub const TRASH_RETENTION_MS: i64 = 30 * 24 * 3600 * 1000;
pub const UPDATE_HISTORY_MS: i64 = 7 * 24 * 3600 * 1000;

/// Why the database could not be opened (the shell decides what to show).
#[derive(Debug)]
pub enum OpenError {
    /// `PRAGMA user_version` is newer than this build supports (17-#32).
    NewerVersion { found: i64, supported: i64 },
    /// `integrity_check` failed after an unclean exit; the file was renamed aside.
    Corrupt { moved_to: PathBuf },
    /// Wrong key or not a SQLCipher database.
    BadKey,
    Other(IpcError),
}

impl From<rusqlite::Error> for OpenError {
    fn from(e: rusqlite::Error) -> Self {
        OpenError::Other(e.into())
    }
}

impl From<IpcError> for OpenError {
    fn from(e: IpcError) -> Self {
        OpenError::Other(e)
    }
}

impl OpenError {
    pub fn to_ipc(&self) -> IpcError {
        match self {
            OpenError::NewerVersion { found, supported } => IpcError::db(format!(
                "此数据由更高版本创建 (user_version {found} > {supported})"
            ))
            .with_details(serde_json::json!({ "found": found, "supported": supported })),
            OpenError::Corrupt { moved_to } => {
                IpcError::db(format!("database corrupt; moved to {}", moved_to.display()))
            }
            OpenError::BadKey => IpcError::keyring("database key rejected"),
            OpenError::Other(e) => e.clone(),
        }
    }
}

pub struct Db {
    conn: Connection,
    path: Option<PathBuf>,
}

impl Db {
    /// Open (or create) the encrypted database at `path` with a 32-byte hex key.
    pub fn open(path: &Path, key_hex: &str) -> Result<Db, OpenError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| OpenError::Other(e.into()))?;
        }
        let existed = path.exists();
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
        )?;
        let mut db = Db {
            conn,
            path: Some(path.to_path_buf()),
        };
        db.apply_key(key_hex)?;
        if db.key_check().is_err() {
            return Err(OpenError::BadKey);
        }
        db.pragmas()?;
        let user_version = db.user_version()?;
        if user_version > schema::USER_VERSION {
            return Err(OpenError::NewerVersion {
                found: user_version,
                supported: schema::USER_VERSION,
            });
        }
        if existed && user_version > 0 && !db.was_clean_exit()? {
            log::warn!("last exit was not clean; running integrity_check");
            if !db.integrity_ok()? {
                drop(db);
                let moved = path.with_extension(format!("sqlite.corrupt-{}", now_ms()));
                std::fs::rename(path, &moved).map_err(|e| OpenError::Other(e.into()))?;
                for suffix in ["-wal", "-shm"] {
                    let mut p = path.as_os_str().to_owned();
                    p.push(suffix);
                    let _ = std::fs::remove_file(PathBuf::from(p));
                }
                return Err(OpenError::Corrupt { moved_to: moved });
            }
        }
        db.migrate()?;
        db.mark_clean_exit(false)?;
        Ok(db)
    }

    /// In-memory database (tests / dry runs). Also encrypted with `key_hex` so the SQLCipher
    /// code path is exercised.
    pub fn open_in_memory(key_hex: &str) -> Result<Db, OpenError> {
        let conn = Connection::open_in_memory()?;
        let mut db = Db { conn, path: None };
        db.apply_key(key_hex)?;
        db.pragmas()?;
        db.migrate()?;
        Ok(db)
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    fn apply_key(&mut self, key_hex: &str) -> Result<(), OpenError> {
        if key_hex.len() != 64 || !key_hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(OpenError::Other(IpcError::keyring("db key must be 32 bytes hex")));
        }
        // Raw key syntax; cipher_page_size / kdf_iter deliberately left at SQLCipher defaults (05 §7.3).
        self.conn
            .execute_batch(&format!("PRAGMA key = \"x'{key_hex}'\";"))?;
        Ok(())
    }

    fn key_check(&self) -> rusqlite::Result<()> {
        self.conn
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get::<_, i64>(0))
            .map(|_| ())
    }

    fn pragmas(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA foreign_keys = ON;
             PRAGMA temp_store = MEMORY;",
        )
    }

    pub fn user_version(&self) -> rusqlite::Result<i64> {
        self.conn
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
    }

    fn migrate(&mut self) -> rusqlite::Result<()> {
        let v = self.user_version()?;
        if v < 1 {
            let tx = self.conn.transaction()?;
            tx.execute_batch(schema::SCHEMA_V1)?;
            tx.execute_batch(&format!("PRAGMA user_version = {}", schema::USER_VERSION))?;
            tx.commit()?;
        }
        Ok(())
    }

    fn was_clean_exit(&self) -> rusqlite::Result<bool> {
        let has_meta: i64 = self.conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='meta'",
            [],
            |r| r.get(0),
        )?;
        if has_meta == 0 {
            return Ok(true);
        }
        let v: Option<String> = self
            .conn
            .query_row("SELECT v FROM meta WHERE k='last_clean_exit'", [], |r| r.get(0))
            .optional()?;
        Ok(v.as_deref() == Some("1"))
    }

    fn integrity_ok(&self) -> rusqlite::Result<bool> {
        let r: String = self
            .conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        Ok(r == "ok")
    }

    pub fn mark_clean_exit(&self, clean: bool) -> rusqlite::Result<()> {
        meta_set(&self.conn, "last_clean_exit", if clean { "1" } else { "0" })
    }

    /// Daily `VACUUM INTO backups/YYYY-MM-DD.db`, keeping the newest 14 (02 §2).
    /// Returns the path written, or `None` if today's backup already exists.
    pub fn backup_daily(&self, backups_dir: &Path) -> IpcResult<Option<PathBuf>> {
        std::fs::create_dir_all(backups_dir)?;
        let target = backups_dir.join(format!("{}.db", crate::util::utc_day(now_ms())));
        if target.exists() {
            return Ok(None);
        }
        let target_str = target.to_string_lossy().replace('\'', "''");
        self.conn
            .execute_batch(&format!("VACUUM INTO '{target_str}';"))?;
        prune_backups(backups_dir, BACKUP_KEEP)?;
        Ok(Some(target))
    }
}

fn prune_backups(dir: &Path, keep: usize) -> IpcResult<()> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|e| e == "db").unwrap_or(false))
        .collect();
    files.sort();
    while files.len() > keep {
        let oldest = files.remove(0);
        let _ = std::fs::remove_file(oldest);
    }
    Ok(())
}

pub fn meta_get(conn: &Connection, k: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT v FROM meta WHERE k = ?1", [k], |r| r.get(0))
        .optional()
}

pub fn meta_set(conn: &Connection, k: &str, v: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        [k, v],
    )?;
    Ok(())
}

/// Monotonic `db:changed` counter (05 §7.2 meta.rev).
pub fn bump_rev(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "INSERT INTO meta (k, v) VALUES ('rev', '1')
         ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)
         RETURNING CAST(v AS INTEGER)",
        [],
        |r| r.get(0),
    )
}

pub fn current_rev(conn: &Connection) -> rusqlite::Result<i64> {
    Ok(meta_get(conn, "rev")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0))
}

/// Detects OneDrive / iCloud / Dropbox / Google Drive style sync folders (05 §7.1).
pub fn cloud_folder_hint(path: &Path) -> Option<String> {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    let needles = [
        ("onedrive", "OneDrive"),
        ("mobile documents", "iCloud Drive"),
        ("icloud", "iCloud Drive"),
        ("dropbox", "Dropbox"),
        ("google drive", "Google Drive"),
        ("googledrive", "Google Drive"),
    ];
    needles
        .iter()
        .find(|(n, _)| lower.contains(n))
        .map(|(_, name)| name.to_string())
}

#[cfg(test)]
pub(crate) const TEST_KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_in_memory_sqlcipher() {
        let db = Db::open_in_memory(TEST_KEY).unwrap();
        assert_eq!(db.user_version().unwrap(), schema::USER_VERSION);
        let tables: Vec<String> = db
            .conn()
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for t in [
            "notes",
            "ydoc_updates",
            "ydoc_snapshots",
            "ydoc_versions",
            "note_window_state",
            "attachments",
            "outbox",
            "sync_state",
            "forensic_snapshots",
            "imports",
            "meta",
        ] {
            assert!(tables.iter().any(|x| x == t), "missing table {t}");
        }
        assert_eq!(bump_rev(db.conn()).unwrap(), 1);
        assert_eq!(bump_rev(db.conn()).unwrap(), 2);
        assert_eq!(current_rev(db.conn()).unwrap(), 2);
    }

    #[test]
    fn open_file_wrong_key_and_newer_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        {
            let db = Db::open(&path, TEST_KEY).unwrap();
            db.mark_clean_exit(true).unwrap();
        }
        let other = "ff112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        assert!(matches!(Db::open(&path, other), Err(OpenError::BadKey)));
        {
            let db = Db::open(&path, TEST_KEY).unwrap();
            db.conn().execute_batch("PRAGMA user_version = 99").unwrap();
            db.mark_clean_exit(true).unwrap();
        }
        assert!(matches!(
            Db::open(&path, TEST_KEY),
            Err(OpenError::NewerVersion { found: 99, .. })
        ));
    }

    #[test]
    fn backup_and_prune() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join(DB_FILE), TEST_KEY).unwrap();
        let backups = dir.path().join("backups");
        let first = db.backup_daily(&backups).unwrap();
        assert!(first.is_some());
        assert!(db.backup_daily(&backups).unwrap().is_none());
        for i in 0..20 {
            std::fs::write(backups.join(format!("1900-01-{:02}.db", i + 1)), b"x").unwrap();
        }
        prune_backups(&backups, BACKUP_KEEP).unwrap();
        let n = std::fs::read_dir(&backups).unwrap().count();
        assert_eq!(n, BACKUP_KEEP);
    }

    #[test]
    fn cloud_hint() {
        assert_eq!(
            cloud_folder_hint(Path::new("C:\\Users\\a\\OneDrive\\x")).as_deref(),
            Some("OneDrive")
        );
        assert!(cloud_folder_hint(Path::new("/home/a/.local/share/x")).is_none());
    }
}
