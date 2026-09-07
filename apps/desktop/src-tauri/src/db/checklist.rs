//! `checklist_items` — local mirror of every note's `taskItem` blocks, backing the todos page.
//!
//! Derived data only: rows are rebuilt from the JS projection each time it is persisted
//! (`notes::create` / `notes::append_update` / `import_commit`), and deleted together with the
//! note (physical delete and tombstone purge). Rust never parses the document itself.

use crate::colors::NoteColor;
use crate::error::IpcResult;
use crate::model::{ChecklistItem, TodoCounts, TodoItem};
use crate::util::{first_line, now_ms};
use rusqlite::{params, Connection, Row};
use std::collections::HashMap;

pub const DEFAULT_LIMIT: i64 = 500;
pub const MAX_LIMIT: i64 = 5000;
/// Same cap as `@bianfa/shared` `TITLE_MAX_CHARS`.
pub const TITLE_MAX_CHARS: usize = 120;

/// Replaces the note's rows with `items` (delete + insert; callers run inside a transaction).
///
/// `updated_at` is preserved for rows whose `text` and `checked` did not change, so
/// `itemUpdatedAt` means "when this item was last edited or toggled", not "when the note was
/// last saved". Duplicate `block_id`s in one projection do not fail the write: the last wins.
pub fn replace_for_note(
    conn: &Connection,
    note_id: &str,
    items: &[ChecklistItem],
) -> IpcResult<()> {
    let now = now_ms();
    let mut previous: HashMap<String, (String, bool, i64)> = HashMap::new();
    if !items.is_empty() {
        let mut stmt = conn.prepare_cached(
            "SELECT block_id, text, checked, updated_at FROM checklist_items WHERE note_id = ?1",
        )?;
        let rows = stmt.query_map([note_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, i64>(3)?,
                ),
            ))
        })?;
        for row in rows {
            let (block_id, prev) = row?;
            previous.insert(block_id, prev);
        }
    }
    conn.execute("DELETE FROM checklist_items WHERE note_id = ?1", [note_id])?;
    if items.is_empty() {
        return Ok(());
    }
    let mut insert = conn.prepare_cached(
        "INSERT INTO checklist_items (note_id, block_id, text, checked, ordinal, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(note_id, block_id) DO UPDATE SET text = excluded.text,
             checked = excluded.checked, ordinal = excluded.ordinal, updated_at = excluded.updated_at",
    )?;
    for it in items {
        let updated_at = previous
            .get(&it.block_id)
            .filter(|(text, checked, _)| *text == it.text && *checked == it.checked)
            .map(|(_, _, at)| *at)
            .unwrap_or(now);
        insert.execute(params![
            note_id,
            it.block_id,
            it.text,
            it.checked,
            it.ordinal,
            updated_at
        ])?;
    }
    Ok(())
}

pub fn delete_for_note(conn: &Connection, note_id: &str) -> IpcResult<()> {
    conn.execute("DELETE FROM checklist_items WHERE note_id = ?1", [note_id])?;
    Ok(())
}

const TODO_COLUMNS: &str = "c.note_id, n.content_text, n.color, n.workspace_id, c.block_id, c.text,
    c.checked, c.ordinal, n.updated_at, c.updated_at";

/// Trashed and purged notes never contribute todos.
const VISIBLE: &str = "FROM checklist_items c JOIN notes n ON n.id = c.note_id
    WHERE n.deleted_at IS NULL AND n.purged = 0";

fn row_to_todo(r: &Row<'_>) -> rusqlite::Result<TodoItem> {
    let content_text: String = r.get(1)?;
    Ok(TodoItem {
        note_id: r.get(0)?,
        note_title: first_line(&content_text, TITLE_MAX_CHARS),
        note_color: NoteColor::parse(&r.get::<_, String>(2)?),
        workspace_id: r.get(3)?,
        block_id: r.get(4)?,
        text: r.get(5)?,
        checked: r.get(6)?,
        ordinal: r.get(7)?,
        note_updated_at: r.get(8)?,
        item_updated_at: r.get(9)?,
    })
}

fn push_workspace_filter(
    sql: &mut String,
    args: &mut Vec<Box<dyn rusqlite::ToSql>>,
    workspace_id: Option<&str>,
) {
    if let Some(ws) = workspace_id {
        sql.push_str(" AND n.workspace_id = ?");
        args.push(Box::new(ws.to_string()));
    }
}

/// Open items first, then most recently edited note first, then document order.
/// `workspace_id = None` means every note in the local database.
pub fn list(
    conn: &Connection,
    include_done: bool,
    workspace_id: Option<&str>,
    limit: Option<i64>,
) -> IpcResult<Vec<TodoItem>> {
    let limit = match limit {
        Some(l) if l > 0 => l.min(MAX_LIMIT),
        _ => DEFAULT_LIMIT,
    };
    let mut sql = format!("SELECT {TODO_COLUMNS} {VISIBLE}");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if !include_done {
        sql.push_str(" AND c.checked = 0");
    }
    push_workspace_filter(&mut sql, &mut args, workspace_id);
    sql.push_str(" ORDER BY c.checked ASC, n.updated_at DESC, c.note_id, c.ordinal ASC LIMIT ?");
    args.push(Box::new(limit));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), row_to_todo)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn counts(conn: &Connection, workspace_id: Option<&str>) -> IpcResult<TodoCounts> {
    let mut sql = format!(
        "SELECT COALESCE(SUM(c.checked = 0), 0), COALESCE(SUM(c.checked <> 0), 0) {VISIBLE}"
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    push_workspace_filter(&mut sql, &mut args, workspace_id);
    let (open, done) = conn.query_row(&sql, rusqlite::params_from_iter(args.iter()), |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
    })?;
    Ok(TodoCounts { open, done })
}
