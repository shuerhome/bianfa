//! `imports` audit rows (one per `import_commit`).

use crate::error::IpcResult;
use crate::util::now_ms;
use rusqlite::{params, Connection};

pub struct ImportRecord<'a> {
    pub source: &'a str,
    pub source_path: &'a str,
    pub archived_to: &'a str,
    pub note_count: i64,
    pub degraded_count: i64,
    pub ink_count: i64,
}

pub fn insert(conn: &Connection, r: &ImportRecord<'_>) -> IpcResult<i64> {
    conn.execute(
        "INSERT INTO imports (source, source_path, archived_to, note_count, degraded_count, ink_count, imported_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            r.source,
            r.source_path,
            r.archived_to,
            r.note_count,
            r.degraded_count,
            r.ink_count,
            now_ms()
        ],
    )?;
    Ok(conn.last_insert_rowid())
}
