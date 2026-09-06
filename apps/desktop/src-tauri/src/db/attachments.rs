//! `attachments` rows + local note references.

use crate::error::IpcResult;
use crate::model::AttachmentRow;
use rusqlite::{params, Connection, OptionalExtension, Row};

fn row(r: &Row<'_>) -> rusqlite::Result<AttachmentRow> {
    Ok(AttachmentRow {
        id: r.get(0)?,
        content_hash: r.get(1)?,
        byte_size: r.get(2)?,
        mime: r.get(3)?,
        width: r.get(4)?,
        height: r.get(5)?,
        blurhash: r.get(6)?,
        local_path: r.get(7)?,
        upload_state: r.get(8)?,
        created_at: r.get(9)?,
    })
}

const COLS: &str = "id, content_hash, byte_size, mime, width, height, blurhash, local_path, upload_state, created_at";

pub fn insert(conn: &Connection, a: &AttachmentRow) -> IpcResult<()> {
    conn.execute(
        &format!(
            "INSERT INTO attachments ({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
        ),
        params![
            a.id,
            a.content_hash,
            a.byte_size,
            a.mime,
            a.width,
            a.height,
            a.blurhash,
            a.local_path,
            a.upload_state,
            a.created_at
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> IpcResult<Option<AttachmentRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM attachments WHERE id = ?1"),
            [id],
            row,
        )
        .optional()?)
}

pub fn find_by_hash(conn: &Connection, hash: &[u8]) -> IpcResult<Option<AttachmentRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM attachments WHERE content_hash = ?1 LIMIT 1"),
            [hash],
            row,
        )
        .optional()?)
}

pub fn link(conn: &Connection, note_id: &str, attachment_id: &str) -> IpcResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO note_attachments (note_id, attachment_id) VALUES (?1, ?2)",
        params![note_id, attachment_id],
    )?;
    Ok(())
}

/// `local` (never uploaded) → `committed` (server acknowledged) — see `app::attachments::upload`.
pub fn set_upload_state(conn: &Connection, id: &str, state: &str) -> IpcResult<()> {
    conn.execute(
        "UPDATE attachments SET upload_state = ?2 WHERE id = ?1",
        params![id, state],
    )?;
    Ok(())
}

/// Attachments still waiting for upload, oldest first (only kinds the server accepts).
pub fn pending_upload(conn: &Connection, mimes: &[&str]) -> IpcResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id, mime FROM attachments WHERE upload_state = 'local' ORDER BY created_at, id",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = Vec::new();
    for (id, mime) in rows.flatten() {
        if mimes.contains(&mime.as_str()) {
            out.push(id);
        }
    }
    Ok(out)
}

/// The (most recently edited) note referencing the attachment and that note's workspace —
/// `POST /v1/attachments/presign` needs a `workspace_id`.
pub fn note_for(
    conn: &Connection,
    attachment_id: &str,
) -> IpcResult<Option<(String, Option<String>)>> {
    Ok(conn
        .query_row(
            "SELECT n.id, n.workspace_id FROM note_attachments na JOIN notes n ON n.id = na.note_id
             WHERE na.attachment_id = ?1 ORDER BY n.updated_at DESC LIMIT 1",
            [attachment_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, TEST_KEY};

    fn att(id: &str, mime: &str, created_at: i64) -> AttachmentRow {
        AttachmentRow {
            id: id.into(),
            content_hash: vec![1; 32],
            byte_size: 3,
            mime: mime.into(),
            width: Some(1),
            height: Some(1),
            blurhash: None,
            local_path: format!("attachments/{id}.bin"),
            upload_state: "local".into(),
            created_at,
        }
    }

    #[test]
    fn pending_upload_state_and_note_lookup() {
        let db = Db::open_in_memory(TEST_KEY).unwrap();
        let c = db.conn();
        insert(c, &att("a-png", "image/png", 2)).unwrap();
        insert(c, &att("a-pdf", "application/pdf", 1)).unwrap();
        insert(c, &att("a-old", "image/webp", 0)).unwrap();
        assert_eq!(
            pending_upload(c, &["image/png", "image/webp"]).unwrap(),
            vec!["a-old".to_string(), "a-png".to_string()]
        );
        set_upload_state(c, "a-old", "committed").unwrap();
        assert_eq!(
            pending_upload(c, &["image/png", "image/webp"]).unwrap(),
            vec!["a-png".to_string()]
        );
        assert_eq!(get(c, "a-old").unwrap().unwrap().upload_state, "committed");

        assert!(note_for(c, "a-png").unwrap().is_none());
        c.execute(
            "INSERT INTO notes (id, workspace_id, head_seq, created_at, updated_at) VALUES ('n1', NULL, 1, 1, 1), ('n2', 'ws-team', 1, 1, 5)",
            [],
        )
        .unwrap();
        link(c, "n1", "a-png").unwrap();
        link(c, "n2", "a-png").unwrap();
        assert_eq!(
            note_for(c, "a-png").unwrap(),
            Some(("n2".to_string(), Some("ws-team".to_string())))
        );
    }
}
