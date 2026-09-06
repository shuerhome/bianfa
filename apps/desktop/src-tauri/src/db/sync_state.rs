//! Per-note sync bookkeeping (03-sync amendment).

use crate::error::IpcResult;
use crate::model::SyncErrorItem;
use crate::util::now_ms;
use rusqlite::{params, Connection};

pub fn set_local_seq(conn: &Connection, note_id: &str, seq: i64) -> IpcResult<()> {
    conn.execute(
        "INSERT INTO sync_state (note_id, local_seq) VALUES (?1, ?2)
         ON CONFLICT(note_id) DO UPDATE SET local_seq = excluded.local_seq",
        params![note_id, seq],
    )?;
    Ok(())
}

pub fn set_acked(conn: &Connection, note_id: &str, acked_seq: i64) -> IpcResult<()> {
    conn.execute(
        "INSERT INTO sync_state (note_id, local_seq, acked_seq, last_synced_at, err_code, last_error)
         VALUES (?1, ?2, ?2, ?3, NULL, NULL)
         ON CONFLICT(note_id) DO UPDATE SET acked_seq = excluded.acked_seq,
             last_synced_at = excluded.last_synced_at, err_code = NULL, last_error = NULL",
        params![note_id, acked_seq, now_ms()],
    )?;
    Ok(())
}

pub fn set_error(
    conn: &Connection,
    note_id: &str,
    err_code: Option<&str>,
    message: Option<&str>,
) -> IpcResult<()> {
    conn.execute(
        "INSERT INTO sync_state (note_id, local_seq, err_code, last_error)
         VALUES (?1, COALESCE((SELECT head_seq FROM notes WHERE id = ?1), 0), ?2, ?3)
         ON CONFLICT(note_id) DO UPDATE SET err_code = excluded.err_code, last_error = excluded.last_error",
        params![note_id, err_code, if err_code.is_some() { message } else { None }],
    )?;
    Ok(())
}

pub fn errors(conn: &Connection) -> IpcResult<Vec<SyncErrorItem>> {
    let mut stmt = conn.prepare(
        "SELECT s.note_id, s.err_code, s.last_error, COALESCE(n.updated_at, 0)
         FROM sync_state s LEFT JOIN notes n ON n.id = s.note_id
         WHERE s.err_code IS NOT NULL ORDER BY n.updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SyncErrorItem {
            note_id: r.get(0)?,
            err_code: r.get(1)?,
            message: r.get(2)?,
            at: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, TEST_KEY};

    #[test]
    fn errors_roundtrip() {
        let db = Db::open_in_memory(TEST_KEY).unwrap();
        let c = db.conn();
        set_local_seq(c, "n", 3).unwrap();
        set_error(c, "n", Some("E_AUTH"), Some("nope")).unwrap();
        let e = errors(c).unwrap();
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].err_code, "E_AUTH");
        set_error(c, "n", None, None).unwrap();
        assert!(errors(c).unwrap().is_empty());
        set_acked(c, "n", 3).unwrap();
        let acked: i64 = c
            .query_row(
                "SELECT acked_seq FROM sync_state WHERE note_id='n'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(acked, 3);
    }
}
