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
        &format!("INSERT INTO attachments ({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"),
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
        .query_row(&format!("SELECT {COLS} FROM attachments WHERE id = ?1"), [id], row)
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
