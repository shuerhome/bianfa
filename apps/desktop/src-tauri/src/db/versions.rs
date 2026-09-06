//! `ydoc_versions`: daily / shrink_guard / manual full-state versions (03-sync amendment).

use crate::error::{IpcError, IpcResult};
use crate::model::VersionItem;
use crate::util::{now_ms, uuid_v7};
use rusqlite::{params, Connection, OptionalExtension};

pub const DAILY_KEEP_MS: i64 = 30 * 24 * 3600 * 1000;
pub const SHRINK_GUARD_PER_NOTE: i64 = 3;
pub const SHRINK_GUARD_MAX_ROWS: i64 = 200;
pub const SHRINK_GUARD_MAX_BYTES: i64 = 100 * 1024 * 1024;

pub fn valid_label(label: &str) -> bool {
    matches!(label, "daily" | "shrink_guard" | "manual")
}

pub fn save(conn: &Connection, note_id: &str, state_v2: &[u8], label: &str) -> IpcResult<String> {
    if !valid_label(label) {
        return Err(IpcError::invalid(format!("unknown version label {label}")));
    }
    let id = uuid_v7();
    conn.execute(
        "INSERT INTO ydoc_versions (id, note_id, label, state_v2, byte_size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, note_id, label, state_v2, state_v2.len() as i64, now_ms()],
    )?;
    Ok(id)
}

pub fn list(conn: &Connection, note_id: &str) -> IpcResult<Vec<VersionItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, label, created_at, byte_size FROM ydoc_versions WHERE note_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([note_id], |r| {
        Ok(VersionItem {
            id: r.get(0)?,
            label: r.get(1)?,
            created_at: r.get(2)?,
            byte_size: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> IpcResult<Vec<u8>> {
    conn.query_row("SELECT state_v2 FROM ydoc_versions WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .ok_or_else(|| IpcError::not_found(format!("version {id} not found")))
}

pub fn has_daily_today(conn: &Connection, note_id: &str, now: i64) -> IpcResult<bool> {
    let day_start = now - now.rem_euclid(24 * 3600 * 1000);
    Ok(conn
        .query_row(
            "SELECT 1 FROM ydoc_versions WHERE note_id = ?1 AND label = 'daily' AND created_at >= ?2 LIMIT 1",
            params![note_id, day_start],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// daily: keep 30 days; shrink_guard: ≤3 per note and ≤200 rows / 100 MB globally (LRU);
/// manual: never pruned.
pub fn prune(conn: &Connection) -> IpcResult<()> {
    let now = now_ms();
    conn.execute(
        "DELETE FROM ydoc_versions WHERE label = 'daily' AND created_at < ?1",
        [now - DAILY_KEEP_MS],
    )?;
    conn.execute(
        "DELETE FROM ydoc_versions WHERE label = 'shrink_guard' AND id IN (
            SELECT id FROM (
              SELECT id, row_number() OVER (PARTITION BY note_id ORDER BY created_at DESC) AS rn
              FROM ydoc_versions WHERE label = 'shrink_guard'
            ) WHERE rn > ?1)",
        [SHRINK_GUARD_PER_NOTE],
    )?;
    loop {
        let (rows, bytes): (i64, i64) = conn.query_row(
            "SELECT count(*), COALESCE(sum(byte_size), 0) FROM ydoc_versions WHERE label = 'shrink_guard'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if rows <= SHRINK_GUARD_MAX_ROWS && bytes <= SHRINK_GUARD_MAX_BYTES {
            break;
        }
        let deleted = conn.execute(
            "DELETE FROM ydoc_versions WHERE id = (
                SELECT id FROM ydoc_versions WHERE label = 'shrink_guard' ORDER BY created_at ASC LIMIT 1)",
            [],
        )?;
        if deleted == 0 {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, TEST_KEY};

    #[test]
    fn save_list_prune() {
        let db = Db::open_in_memory(TEST_KEY).unwrap();
        let c = db.conn();
        let id = save(c, "n", b"abc", "manual").unwrap();
        assert_eq!(get(c, &id).unwrap(), b"abc");
        for _ in 0..5 {
            save(c, "n", b"sg", "shrink_guard").unwrap();
        }
        assert!(save(c, "n", b"x", "weird").is_err());
        prune(c).unwrap();
        let l = list(c, "n").unwrap();
        assert_eq!(l.iter().filter(|v| v.label == "shrink_guard").count(), 3);
        assert_eq!(l.iter().filter(|v| v.label == "manual").count(), 1);
        assert!(!has_daily_today(c, "n", now_ms()).unwrap());
        save(c, "n", b"d", "daily").unwrap();
        assert!(has_daily_today(c, "n", now_ms()).unwrap());
        c.execute("UPDATE ydoc_versions SET created_at = 1 WHERE label = 'daily'", []).unwrap();
        prune(c).unwrap();
        assert!(list(c, "n").unwrap().iter().all(|v| v.label != "daily"));
    }
}
