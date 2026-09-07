//! Note queries: projections in `notes`, CRDT bytes in `ydoc_updates` / `ydoc_snapshots`.
//! Rust only merges v2 updates (`yrs::merge_updates_v2`); it never builds a `Doc` (01-S4).

use super::{checklist, sync_state, versions, TRASH_RETENTION_MS, UPDATE_HISTORY_MS};
use crate::colors::NoteColor;
use crate::error::{IpcError, IpcResult};
use crate::model::{
    NoteDocBundle, NoteListItem, NoteProjection, NoteRecord, PendingSync, SearchFilters,
    UpdatesSince,
};
use crate::util::{b64_encode, excerpt, now_ms, title_of};
use rusqlite::{params, Connection, OptionalExtension, Row};

const LIST_COLUMNS: &str =
    "n.id, n.content_text, n.color, n.z_mode, n.created_at, n.updated_at, n.deleted_at,
    n.workspace_id, n.head_seq, n.body_html, n.schema_version,
    COALESCE(w.is_open, 0), COALESCE(s.acked_seq, 0)";

const LIST_JOINS: &str = "FROM notes n
    LEFT JOIN note_window_state w ON w.note_id = n.id
    LEFT JOIN sync_state s ON s.note_id = n.id";

const ORDER: &str = "ORDER BY (n.z_mode = 1) DESC, n.updated_at DESC";

fn row_to_record(r: &Row<'_>) -> rusqlite::Result<NoteRecord> {
    let content_text: String = r.get(1)?;
    let head_seq: i64 = r.get(8)?;
    let acked: i64 = r.get(12)?;
    let z_mode: i64 = r.get(3)?;
    let is_open: i64 = r.get(11)?;
    Ok(NoteRecord {
        item: NoteListItem {
            id: r.get(0)?,
            title: title_of(&content_text),
            excerpt: excerpt(&content_text, 120),
            color: NoteColor::parse(&r.get::<_, String>(2)?),
            z_mode,
            pinned: z_mode == 1,
            created_at: r.get(4)?,
            updated_at: r.get(5)?,
            deleted_at: r.get(6)?,
            is_open: is_open != 0,
            synced: head_seq <= acked,
            workspace_id: r.get(7)?,
        },
        body_html: r.get(9)?,
        schema_version: r.get(10)?,
        head_seq,
        content_text,
    })
}

/// `workspace`: `None` = no filter, `Some(None)` = local-only (NULL), `Some(Some(id))` = equal.
pub fn list(
    conn: &Connection,
    include_trashed: bool,
    workspace: Option<Option<&str>>,
) -> IpcResult<Vec<NoteListItem>> {
    let mut sql = format!("SELECT {LIST_COLUMNS} {LIST_JOINS} WHERE n.purged = 0");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if !include_trashed {
        sql.push_str(" AND n.deleted_at IS NULL");
    }
    match workspace {
        None => {}
        Some(None) => sql.push_str(" AND n.workspace_id IS NULL"),
        Some(Some(ws)) => {
            sql.push_str(" AND n.workspace_id = ?");
            args.push(Box::new(ws.to_string()));
        }
    }
    sql.push(' ');
    sql.push_str(ORDER);
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), row_to_record)?;
    Ok(rows
        .map(|r| r.map(|rec| rec.item))
        .collect::<Result<_, _>>()?)
}

fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Turns a whitespace-separated bigram list into a safe FTS5 query (`"ab" "bc"` → implicit AND).
pub fn fts_query(bigram_query: &str) -> String {
    bigram_query
        .split_whitespace()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn search(
    conn: &Connection,
    q: &str,
    bigram_query: Option<&str>,
    include_trashed: bool,
    limit: i64,
    filters: &SearchFilters,
) -> IpcResult<Vec<NoteListItem>> {
    let limit = if limit <= 0 { 200 } else { limit.min(1000) };
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let mut sql = String::new();
    let fts = bigram_query.map(fts_query).filter(|s| !s.is_empty());
    if let Some(fts) = fts {
        sql.push_str(&format!(
            "SELECT {LIST_COLUMNS} FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
             LEFT JOIN note_window_state w ON w.note_id = n.id
             LEFT JOIN sync_state s ON s.note_id = n.id
             WHERE notes_fts MATCH ? AND n.purged = 0"
        ));
        args.push(Box::new(fts));
    } else {
        sql.push_str(&format!(
            "SELECT {LIST_COLUMNS} {LIST_JOINS} WHERE n.purged = 0 AND n.content_text LIKE ? ESCAPE '\\'"
        ));
        args.push(Box::new(format!("%{}%", escape_like(q))));
    }
    match filters.trashed {
        Some(true) => sql.push_str(" AND n.deleted_at IS NOT NULL"),
        Some(false) => sql.push_str(" AND n.deleted_at IS NULL"),
        None if !include_trashed => sql.push_str(" AND n.deleted_at IS NULL"),
        None => {}
    }
    if let Some(p) = filters.pinned {
        sql.push_str(if p {
            " AND n.z_mode = 1"
        } else {
            " AND n.z_mode <> 1"
        });
    }
    if let Some(c) = filters.color {
        sql.push_str(" AND n.color = ?");
        args.push(Box::new(c.as_str().to_string()));
    }
    sql.push(' ');
    sql.push_str(ORDER);
    sql.push_str(" LIMIT ?");
    args.push(Box::new(limit));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), row_to_record)?;
    Ok(rows
        .map(|r| r.map(|rec| rec.item))
        .collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: &str) -> IpcResult<NoteRecord> {
    let sql = format!("SELECT {LIST_COLUMNS} {LIST_JOINS} WHERE n.id = ?1");
    conn.query_row(&sql, [id], row_to_record)
        .optional()?
        .ok_or_else(|| IpcError::not_found(format!("note {id} not found")))
}

pub fn exists(conn: &Connection, id: &str) -> IpcResult<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM notes WHERE id = ?1", [id], |_| Ok(()))
        .optional()?
        .is_some())
}

pub fn purge_after_for(deleted_at: Option<i64>) -> Option<i64> {
    deleted_at.map(|d| d + TRASH_RETENTION_MS)
}

fn write_projection(conn: &Connection, id: &str, p: &NoteProjection) -> IpcResult<()> {
    conn.execute(
        "UPDATE notes SET content = ?2, content_text = ?3, content_bigram = ?4, body_html = ?5,
             color = ?6, z_mode = ?7, schema_version = ?8, created_at = ?9, updated_at = ?10,
             deleted_at = ?11, purge_after = ?12
         WHERE id = ?1",
        params![
            id,
            serde_json::to_string(&p.content)?,
            p.content_text,
            p.content_bigram,
            p.body_html,
            p.color.as_str(),
            p.z_mode,
            p.schema_version,
            p.created_at,
            p.updated_at,
            p.deleted_at,
            purge_after_for(p.deleted_at),
        ],
    )?;
    conn.execute("DELETE FROM note_attachments WHERE note_id = ?1", [id])?;
    for a in &p.attachment_ids {
        conn.execute(
            "INSERT OR IGNORE INTO note_attachments (note_id, attachment_id) VALUES (?1, ?2)",
            params![id, a],
        )?;
    }
    checklist::replace_for_note(conn, id, &p.checklist)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn create(
    conn: &Connection,
    id: &str,
    update_v2: &[u8],
    p: &NoteProjection,
    workspace_id: Option<&str>,
    import_source: Option<&str>,
    import_external_id: Option<&str>,
    origin: &str,
) -> IpcResult<NoteRecord> {
    if exists(conn, id)? {
        return Err(IpcError::invalid(format!("note {id} already exists")));
    }
    let now = now_ms();
    conn.execute(
        "INSERT INTO notes (id, workspace_id, import_source, import_external_id, head_seq, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
        params![id, workspace_id, import_source, import_external_id, now],
    )?;
    write_projection(conn, id, p)?;
    conn.execute(
        "INSERT INTO ydoc_updates (note_id, seq, update_v2, origin, created_at) VALUES (?1, 1, ?2, ?3, ?4)",
        params![id, update_v2, origin, now],
    )?;
    sync_state::set_local_seq(conn, id, 1)?;
    get(conn, id)
}

pub fn load_doc(conn: &Connection, id: &str) -> IpcResult<NoteDocBundle> {
    let head_seq: i64 = conn
        .query_row("SELECT head_seq FROM notes WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?
        .ok_or_else(|| IpcError::not_found(format!("note {id} not found")))?;
    let snapshot: Option<(i64, Vec<u8>)> = conn
        .query_row(
            "SELECT upto_seq, state_v2 FROM ydoc_snapshots WHERE note_id = ?1 ORDER BY upto_seq DESC LIMIT 1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (upto, snap_b64) = match snapshot {
        Some((seq, bytes)) => (seq, Some(b64_encode(&bytes))),
        None => (0, None),
    };
    let updates = updates_since(conn, id, upto)?;
    Ok(NoteDocBundle {
        snapshot_b64: snap_b64,
        snapshot_upto_seq: upto,
        updates_b64: updates.updates_b64,
        head_seq,
    })
}

pub fn updates_since(conn: &Connection, id: &str, after_seq: i64) -> IpcResult<UpdatesSince> {
    let head_seq: i64 = conn
        .query_row("SELECT head_seq FROM notes WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?
        .ok_or_else(|| IpcError::not_found(format!("note {id} not found")))?;
    let mut stmt = conn.prepare(
        "SELECT update_v2 FROM ydoc_updates WHERE note_id = ?1 AND seq > ?2 ORDER BY seq",
    )?;
    let updates = stmt
        .query_map(params![id, after_seq], |r| r.get::<_, Vec<u8>>(0))?
        .map(|r| r.map(|b| b64_encode(&b)))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(UpdatesSince {
        updates_b64: updates,
        head_seq,
    })
}

/// Appends one update; with a projection also refreshes the projection columns.
/// Also writes the first `daily` version of the (UTC) day (03-sync amendment).
pub fn append_update(
    conn: &Connection,
    id: &str,
    update_v2: &[u8],
    origin: &str,
    projection: Option<&NoteProjection>,
) -> IpcResult<i64> {
    let head_seq: i64 = conn
        .query_row("SELECT head_seq FROM notes WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?
        .ok_or_else(|| IpcError::not_found(format!("note {id} not found")))?;
    let seq = head_seq + 1;
    let now = now_ms();
    conn.execute(
        "INSERT INTO ydoc_updates (note_id, seq, update_v2, origin, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, seq, update_v2, origin, now],
    )?;
    conn.execute(
        "UPDATE notes SET head_seq = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, seq, now],
    )?;
    if let Some(p) = projection {
        write_projection(conn, id, p)?;
    }
    sync_state::set_local_seq(conn, id, seq)?;
    if !versions::has_daily_today(conn, id, now)? {
        if let Ok(state) = full_state(conn, id) {
            versions::save(conn, id, &state, "daily")?;
            versions::prune(conn)?;
        }
    }
    Ok(seq)
}

/// Snapshot + all later updates merged into one v2 update (no `Doc` construction).
pub fn full_state(conn: &Connection, id: &str) -> IpcResult<Vec<u8>> {
    let snapshot: Option<(i64, Vec<u8>)> = conn
        .query_row(
            "SELECT upto_seq, state_v2 FROM ydoc_snapshots WHERE note_id = ?1 ORDER BY upto_seq DESC LIMIT 1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (upto, mut parts) = match snapshot {
        Some((seq, bytes)) => (seq, vec![bytes]),
        None => (0, Vec::new()),
    };
    let mut stmt = conn.prepare(
        "SELECT update_v2 FROM ydoc_updates WHERE note_id = ?1 AND seq > ?2 ORDER BY seq",
    )?;
    for u in stmt.query_map(params![id, upto], |r| r.get::<_, Vec<u8>>(0))? {
        parts.push(u?);
    }
    if parts.is_empty() {
        return Err(IpcError::not_found(format!(
            "note {id} has no document data"
        )));
    }
    if parts.len() == 1 {
        return Ok(parts.pop().unwrap_or_default());
    }
    Ok(yrs::merge_updates_v2(parts)?)
}

pub fn write_snapshot(
    conn: &Connection,
    id: &str,
    state_v2: &[u8],
    sv: &[u8],
    upto_seq: i64,
) -> IpcResult<()> {
    if !exists(conn, id)? {
        return Err(IpcError::not_found(format!("note {id} not found")));
    }
    let now = now_ms();
    conn.execute(
        "INSERT INTO ydoc_snapshots (note_id, upto_seq, state_v2, sv, is_daily, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)
         ON CONFLICT(note_id, upto_seq) DO UPDATE SET state_v2 = excluded.state_v2, sv = excluded.sv, created_at = excluded.created_at",
        params![id, upto_seq, state_v2, sv, now],
    )?;
    // Keep only the newest snapshot; daily history lives in ydoc_versions.
    conn.execute(
        "DELETE FROM ydoc_snapshots WHERE note_id = ?1 AND upto_seq < ?2",
        params![id, upto_seq],
    )?;
    // 7 days of full update history stay available for diffing/undo (05 §7.2).
    conn.execute(
        "DELETE FROM ydoc_updates WHERE note_id = ?1 AND seq <= ?2 AND created_at < ?3",
        params![id, upto_seq, now - UPDATE_HISTORY_MS],
    )?;
    Ok(())
}

/// Merges snapshot + updates with `yrs::merge_updates_v2` into a new snapshot at `head_seq`.
pub fn compact(conn: &Connection, id: &str) -> IpcResult<i64> {
    let head_seq: i64 = conn
        .query_row("SELECT head_seq FROM notes WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?
        .ok_or_else(|| IpcError::not_found(format!("note {id} not found")))?;
    let state = full_state(conn, id)?;
    let sv = yrs::encode_state_vector_from_update_v2(&state)?;
    write_snapshot(conn, id, &state, &sv, head_seq)?;
    Ok(head_seq)
}

pub fn delete_physical(conn: &Connection, id: &str) -> IpcResult<()> {
    for sql in [
        "DELETE FROM ydoc_updates WHERE note_id = ?1",
        "DELETE FROM ydoc_snapshots WHERE note_id = ?1",
        "DELETE FROM ydoc_versions WHERE note_id = ?1",
        "DELETE FROM note_window_state WHERE note_id = ?1",
        "DELETE FROM sync_state WHERE note_id = ?1",
        "DELETE FROM note_attachments WHERE note_id = ?1",
        "DELETE FROM notes WHERE id = ?1",
    ] {
        conn.execute(sql, [id])?;
    }
    checklist::delete_for_note(conn, id)?;
    Ok(())
}

/// `synced=0 && content_text.trim()=='' && no attachments` → physical delete.
pub fn discard_if_empty(conn: &Connection, id: &str) -> IpcResult<bool> {
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT synced, content_text FROM notes WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((synced, text)) = row else {
        return Ok(false);
    };
    let acked: i64 = conn
        .query_row(
            "SELECT COALESCE(acked_seq, 0) FROM sync_state WHERE note_id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    let attachments: i64 = conn.query_row(
        "SELECT count(*) FROM note_attachments WHERE note_id = ?1",
        [id],
        |r| r.get(0),
    )?;
    if synced == 0 && acked == 0 && text.trim().is_empty() && attachments == 0 {
        delete_physical(conn, id)?;
        return Ok(true);
    }
    Ok(false)
}

pub fn set_synced(conn: &Connection, id: &str, head_seq: i64) -> IpcResult<()> {
    if !exists(conn, id)? {
        return Err(IpcError::not_found(format!("note {id} not found")));
    }
    sync_state::set_acked(conn, id, head_seq)?;
    conn.execute("UPDATE notes SET synced = 1 WHERE id = ?1", [id])?;
    Ok(())
}

pub fn pending_sync(conn: &Connection) -> IpcResult<Vec<PendingSync>> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.head_seq FROM notes n LEFT JOIN sync_state s ON s.note_id = n.id
         WHERE n.purged = 0 AND n.head_seq > COALESCE(s.acked_seq, 0) ORDER BY n.updated_at",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PendingSync {
            note_id: r.get(0)?,
            head_seq: r.get(1)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Clears the body but keeps the tombstone row (so the deletion still syncs).
fn purge_tombstone(conn: &Connection, id: &str) -> IpcResult<()> {
    conn.execute(
        "UPDATE notes SET content = '{\"type\":\"doc\",\"content\":[]}', content_text = '', content_bigram = '',
             body_html = '', purged = 1 WHERE id = ?1",
        [id],
    )?;
    for sql in [
        "DELETE FROM ydoc_updates WHERE note_id = ?1",
        "DELETE FROM ydoc_snapshots WHERE note_id = ?1",
        "DELETE FROM ydoc_versions WHERE note_id = ?1",
        "DELETE FROM note_window_state WHERE note_id = ?1",
        "DELETE FROM note_attachments WHERE note_id = ?1",
    ] {
        conn.execute(sql, [id])?;
    }
    checklist::delete_for_note(conn, id)?;
    Ok(())
}

fn purge_or_delete(conn: &Connection, id: &str, synced: i64) -> IpcResult<()> {
    if synced == 0 {
        delete_physical(conn, id)
    } else {
        purge_tombstone(conn, id)
    }
}

pub fn trash_empty(conn: &Connection) -> IpcResult<i64> {
    let ids: Vec<(String, i64)> = conn
        .prepare("SELECT id, synced FROM notes WHERE deleted_at IS NOT NULL AND purged = 0")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (id, synced) in &ids {
        purge_or_delete(conn, id, *synced)?;
    }
    Ok(ids.len() as i64)
}

pub fn purge_expired(conn: &Connection) -> IpcResult<i64> {
    let now = now_ms();
    let ids: Vec<(String, i64)> = conn
        .prepare(
            "SELECT id, synced FROM notes WHERE deleted_at IS NOT NULL AND purged = 0
             AND purge_after IS NOT NULL AND purge_after < ?1",
        )?
        .query_map([now], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (id, synced) in &ids {
        purge_or_delete(conn, id, *synced)?;
    }
    Ok(ids.len() as i64)
}

/// Mirrors a z-mode change into the projection so list ordering updates immediately
/// (05 §3.4: `notes.pinned = (z_mode==1)` is a mirror; JS writes the authoritative meta later).
pub fn set_z_mode(conn: &Connection, id: &str, z_mode: i64) -> IpcResult<()> {
    conn.execute(
        "UPDATE notes SET z_mode = ?2 WHERE id = ?1",
        params![id, z_mode],
    )?;
    Ok(())
}

pub fn find_by_import(
    conn: &Connection,
    source: &str,
    external_id: &str,
) -> IpcResult<Option<(String, i64)>> {
    Ok(conn
        .query_row(
            "SELECT id, updated_at FROM notes WHERE import_source = ?1 AND import_external_id = ?2",
            params![source, external_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::db::{Db, TEST_KEY};

    pub(crate) fn proj(text: &str, deleted: Option<i64>) -> NoteProjection {
        NoteProjection {
            content: serde_json::json!({"type":"doc","content":[]}),
            content_text: text.to_string(),
            content_bigram: crate::import::text::bigram_shingles(text),
            body_html: format!("<p>{text}</p>"),
            color: NoteColor::Citron,
            z_mode: 0,
            created_at: 1000,
            updated_at: 2000,
            deleted_at: deleted,
            schema_version: 1,
            attachment_ids: vec![],
            checklist: vec![],
        }
    }

    /// A tiny valid v2 update: encodes an empty Y.Doc state (no structs, no delete set).
    /// v2 encoding of an empty update = [0 clients][0 delete-set clients] with v2 varints.
    pub(crate) fn empty_update_v2() -> Vec<u8> {
        yrs::merge_updates_v2(Vec::<Vec<u8>>::new()).unwrap()
    }

    #[test]
    fn create_list_search_get() {
        let db = Db::open_in_memory(TEST_KEY).unwrap();
        let c = db.conn();
        let u = empty_update_v2();
        create(
            c,
            "n1",
            &u,
            &proj("你好世界", None),
            None,
            None,
            None,
            "local",
        )
        .unwrap();
        create(
            c,
            "n2",
            &u,
            &proj("hello world", None),
            None,
            None,
            None,
            "local",
        )
        .unwrap();
        create(
            c,
            "n3",
            &u,
            &proj("trashed", Some(5000)),
            None,
            None,
            None,
            "local",
        )
        .unwrap();
        let all = list(c, false, None).unwrap();
        assert_eq!(all.len(), 2);
        assert!(!all[0].synced);
        assert_eq!(list(c, true, None).unwrap().len(), 3);
        let rec = get(c, "n1").unwrap();
        assert_eq!(rec.item.title, "你好世界");
        assert_eq!(rec.head_seq, 1);
        assert!(get(c, "nope").is_err());
        // bigram FTS
        let hits = search(
            c,
            "好世",
            Some(&crate::import::text::bigram_shingles("好世")),
            false,
            50,
            &SearchFilters::default(),
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "n1");
        // LIKE path, single char
        let hits = search(c, "w", None, false, 50, &SearchFilters::default()).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "n2");
        // trashed filter
        let f = SearchFilters {
            trashed: Some(true),
            ..Default::default()
        };
        let hits = search(c, "trash", None, false, 50, &f).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn append_snapshot_compact_and_pending() {
        let db = Db::open_in_memory(TEST_KEY).unwrap();
        let c = db.conn();
        let u = empty_update_v2();
        create(c, "n1", &u, &proj("a", None), None, None, None, "local").unwrap();
        let seq = append_update(c, "n1", &u, "local", Some(&proj("ab", None))).unwrap();
        assert_eq!(seq, 2);
        let bundle = load_doc(c, "n1").unwrap();
        assert!(bundle.snapshot_b64.is_none());
        assert_eq!(bundle.updates_b64.len(), 2);
        assert_eq!(bundle.head_seq, 2);
        // daily version written on first append of the day
        assert_eq!(versions::list(c, "n1").unwrap().len(), 1);
        let upto = compact(c, "n1").unwrap();
        assert_eq!(upto, 2);
        let bundle = load_doc(c, "n1").unwrap();
        assert!(bundle.snapshot_b64.is_some());
        assert_eq!(bundle.snapshot_upto_seq, 2);
        // updates newer than 7 days are retained after compaction
        assert_eq!(bundle.updates_b64.len(), 0);
        assert_eq!(updates_since(c, "n1", 1).unwrap().updates_b64.len(), 1);
        let pend = pending_sync(c).unwrap();
        assert_eq!(pend.len(), 1);
        set_synced(c, "n1", 2).unwrap();
        assert!(pending_sync(c).unwrap().is_empty());
        assert!(get(c, "n1").unwrap().item.synced);
    }

    #[test]
    fn discard_trash_and_purge() {
        let db = Db::open_in_memory(TEST_KEY).unwrap();
        let c = db.conn();
        let u = empty_update_v2();
        create(c, "e", &u, &proj("   ", None), None, None, None, "local").unwrap();
        assert!(discard_if_empty(c, "e").unwrap());
        assert!(!exists(c, "e").unwrap());
        create(c, "t1", &u, &proj("x", Some(1)), None, None, None, "local").unwrap();
        create(c, "t2", &u, &proj("y", Some(1)), None, None, None, "local").unwrap();
        set_synced(c, "t2", 1).unwrap();
        assert_eq!(purge_expired(c).unwrap(), 2);
        assert!(!exists(c, "t1").unwrap());
        let t2 = get(c, "t2").unwrap();
        assert_eq!(t2.content_text, "");
        assert!(list(c, true, None).unwrap().is_empty());
        create(
            c,
            "t3",
            &u,
            &proj("z", Some(now_ms())),
            None,
            None,
            None,
            "local",
        )
        .unwrap();
        assert_eq!(purge_expired(c).unwrap(), 0);
        assert_eq!(trash_empty(c).unwrap(), 1);
    }

    #[test]
    fn fts_query_quoting() {
        assert_eq!(fts_query("ab b\"c"), "\"ab\" \"b\"\"c\"");
    }

    fn items(checked: [bool; 3]) -> Vec<crate::model::ChecklistItem> {
        ["买牛奶", "买鸡蛋", "买面包"]
            .iter()
            .zip(["b1", "b2", "b3"])
            .zip(checked)
            .enumerate()
            .map(
                |(i, ((text, block_id), checked))| crate::model::ChecklistItem {
                    block_id: block_id.to_string(),
                    text: text.to_string(),
                    checked,
                    ordinal: i as i64,
                },
            )
            .collect()
    }

    #[test]
    fn checklist_mirror_list_toggle_counts_and_purge() {
        let db = Db::open_in_memory(TEST_KEY).unwrap();
        let c = db.conn();
        let u = empty_update_v2();
        let mut p = proj("周末采购\n[ ] 买牛奶\n[ ] 买鸡蛋\n[ ] 买面包", None);
        p.checklist = items([false, false, false]);
        create(c, "n1", &u, &p, None, None, None, "local").unwrap();

        let todos = checklist::list(c, false, None, None).unwrap();
        assert_eq!(todos.len(), 3);
        assert_eq!(todos[0].note_id, "n1");
        assert_eq!(todos[0].note_title, "周末采购");
        assert_eq!(todos[0].note_color, NoteColor::Citron);
        assert_eq!(todos[0].workspace_id, None);
        assert_eq!(
            todos.iter().map(|t| t.ordinal).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert!(todos.iter().all(|t| !t.checked && t.item_updated_at > 0));
        let n = checklist::counts(c, None).unwrap();
        assert_eq!((n.open, n.done), (3, 0));

        // Toggle by re-appending the projection with the middle item checked: unchanged items keep
        // their timestamp, the toggled one is bumped.
        c.execute("UPDATE checklist_items SET updated_at = 1", [])
            .unwrap();
        let mut toggled = p.clone();
        toggled.checklist[1].checked = true;
        append_update(c, "n1", &u, "local", Some(&toggled)).unwrap();
        let open = checklist::list(c, false, None, None).unwrap();
        assert_eq!(
            open.iter().map(|t| t.block_id.as_str()).collect::<Vec<_>>(),
            vec!["b1", "b3"]
        );
        assert!(open.iter().all(|t| t.item_updated_at == 1));
        let all = checklist::list(c, true, None, None).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[2].block_id, "b2");
        assert!(all[2].checked && all[2].item_updated_at > 1);
        let n = checklist::counts(c, None).unwrap();
        assert_eq!((n.open, n.done), (2, 1));
        assert_eq!(checklist::list(c, true, None, Some(1)).unwrap().len(), 1);

        // A removed item disappears; a duplicated block id does not fail the write (last wins).
        let mut shrunk = toggled.clone();
        shrunk.checklist.remove(0);
        shrunk.checklist.push(crate::model::ChecklistItem {
            block_id: "b3".into(),
            text: "买全麦面包".into(),
            checked: false,
            ordinal: 9,
        });
        append_update(c, "n1", &u, "local", Some(&shrunk)).unwrap();
        let all = checklist::list(c, true, None, None).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(
            (all[0].block_id.as_str(), all[0].text.as_str()),
            ("b3", "买全麦面包")
        );

        // Workspace filter; open items of the most recently edited note come first.
        let mut p2 = proj("团队待办\n[ ] 发版", None);
        p2.updated_at = 3000;
        p2.checklist = vec![crate::model::ChecklistItem {
            block_id: "t1".into(),
            text: "发版".into(),
            checked: false,
            ordinal: 0,
        }];
        create(c, "n2", &u, &p2, Some("ws1"), None, None, "local").unwrap();
        let ws = checklist::list(c, true, Some("ws1"), None).unwrap();
        assert_eq!(ws.len(), 1);
        assert_eq!(ws[0].workspace_id.as_deref(), Some("ws1"));
        let n = checklist::counts(c, Some("ws1")).unwrap();
        assert_eq!((n.open, n.done), (1, 0));
        let open = checklist::list(c, false, None, None).unwrap();
        assert_eq!(open[0].note_id, "n2");
        assert_eq!(open[1].note_id, "n1");
        assert!(open[0].note_updated_at >= open[1].note_updated_at);

        // Trashed notes drop out of the list but keep their rows until purged.
        let mut trashed = shrunk.clone();
        trashed.deleted_at = Some(1);
        append_update(c, "n1", &u, "local", Some(&trashed)).unwrap();
        assert!(checklist::list(c, true, None, None)
            .unwrap()
            .iter()
            .all(|t| t.note_id == "n2"));
        let rows: i64 = c
            .query_row(
                "SELECT count(*) FROM checklist_items WHERE note_id = 'n1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 2);

        // Purge: unsynced → physical delete, synced → tombstone; both clear the rows.
        let mut t2 = p2.clone();
        t2.deleted_at = Some(1);
        append_update(c, "n2", &u, "local", Some(&t2)).unwrap();
        set_synced(c, "n2", 2).unwrap();
        assert_eq!(trash_empty(c).unwrap(), 2);
        assert!(!exists(c, "n1").unwrap());
        assert!(get(c, "n2").unwrap().content_text.is_empty());
        let rows: i64 = c
            .query_row("SELECT count(*) FROM checklist_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
        let n = checklist::counts(c, None).unwrap();
        assert_eq!((n.open, n.done), (0, 0));
    }
}
