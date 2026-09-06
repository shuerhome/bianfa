//! `note_window_state` — window geometry is local-only and never synced (01-C14).

use crate::error::IpcResult;
use crate::model::WindowState;
use crate::util::now_ms;
use rusqlite::{params, Connection, OptionalExtension, Row};

fn row_to_state(r: &Row<'_>) -> rusqlite::Result<WindowState> {
    Ok(WindowState {
        note_id: r.get(0)?,
        x: r.get(1)?,
        y: r.get(2)?,
        w: r.get(3)?,
        h: r.get(4)?,
        monitor_key: r.get(5)?,
        scale: r.get(6)?,
        home_display_id: r.get(7)?,
        home_bounds: r.get(8)?,
        z_mode: r.get(9)?,
        collapsed: r.get::<_, i64>(10)? != 0,
        is_open: r.get::<_, i64>(11)? != 0,
        updated_at: r.get(12)?,
    })
}

const COLS: &str = "note_id, x, y, w, h, monitor_key, scale, home_display_id, home_bounds, z_mode, collapsed, is_open, updated_at";

pub fn get(conn: &Connection, note_id: &str) -> IpcResult<Option<WindowState>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM note_window_state WHERE note_id = ?1"),
            [note_id],
            row_to_state,
        )
        .optional()?)
}

fn ensure(conn: &Connection, note_id: &str) -> IpcResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO note_window_state (note_id, updated_at) VALUES (?1, ?2)",
        params![note_id, now_ms()],
    )?;
    Ok(())
}

pub struct Geometry {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    pub monitor_key: Option<String>,
    pub scale: Option<f64>,
}

pub fn save_geometry(conn: &Connection, note_id: &str, g: &Geometry) -> IpcResult<()> {
    ensure(conn, note_id)?;
    conn.execute(
        "UPDATE note_window_state SET x = ?2, y = ?3, w = ?4, h = ?5,
             monitor_key = COALESCE(?6, monitor_key), scale = COALESCE(?7, scale),
             home_display_id = COALESCE(home_display_id, ?6),
             home_bounds = COALESCE(home_bounds, ?8),
             updated_at = ?9
         WHERE note_id = ?1",
        params![
            note_id,
            g.x,
            g.y,
            g.w,
            g.h,
            g.monitor_key,
            g.scale,
            format!("{},{},{},{}", g.x, g.y, g.w, g.h),
            now_ms()
        ],
    )?;
    Ok(())
}

pub fn set_z_mode(conn: &Connection, note_id: &str, z_mode: i64) -> IpcResult<()> {
    ensure(conn, note_id)?;
    conn.execute(
        "UPDATE note_window_state SET z_mode = ?2, updated_at = ?3 WHERE note_id = ?1",
        params![note_id, z_mode, now_ms()],
    )?;
    Ok(())
}

pub fn set_collapsed(conn: &Connection, note_id: &str, collapsed: bool) -> IpcResult<()> {
    ensure(conn, note_id)?;
    conn.execute(
        "UPDATE note_window_state SET collapsed = ?2, updated_at = ?3 WHERE note_id = ?1",
        params![note_id, collapsed as i64, now_ms()],
    )?;
    Ok(())
}

pub fn set_is_open(conn: &Connection, note_id: &str, is_open: bool) -> IpcResult<()> {
    ensure(conn, note_id)?;
    conn.execute(
        "UPDATE note_window_state SET is_open = ?2, updated_at = ?3 WHERE note_id = ?1",
        params![note_id, is_open as i64, now_ms()],
    )?;
    Ok(())
}

/// Notes to restore at launch: `is_open=1`, newest first, hard cap 40 (05 §2.3).
pub fn open_note_ids(conn: &Connection, limit: i64) -> IpcResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT w.note_id FROM note_window_state w JOIN notes n ON n.id = w.note_id
         WHERE w.is_open = 1 AND n.deleted_at IS NULL AND n.purged = 0
         ORDER BY n.updated_at DESC LIMIT ?1",
    )?;
    let ids = stmt.query_map([limit], |r| r.get::<_, String>(0))?;
    Ok(ids.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::notes::tests::{empty_update_v2, proj};
    use crate::db::{Db, TEST_KEY};

    #[test]
    fn roundtrip() {
        let db = Db::open_in_memory(TEST_KEY).unwrap();
        let c = db.conn();
        crate::db::notes::create(
            c,
            "n1",
            &empty_update_v2(),
            &proj("t", None),
            None,
            None,
            None,
            "local",
        )
        .unwrap();
        assert!(get(c, "n1").unwrap().is_none());
        save_geometry(
            c,
            "n1",
            &Geometry {
                x: 10,
                y: 20,
                w: 300,
                h: 200,
                monitor_key: Some("m1".into()),
                scale: Some(1.5),
            },
        )
        .unwrap();
        set_z_mode(c, "n1", 2).unwrap();
        set_collapsed(c, "n1", true).unwrap();
        let s = get(c, "n1").unwrap().unwrap();
        assert_eq!(
            (s.x, s.y, s.w, s.h),
            (Some(10), Some(20), Some(300), Some(200))
        );
        assert_eq!(s.home_display_id.as_deref(), Some("m1"));
        assert_eq!(s.home_bounds.as_deref(), Some("10,20,300,200"));
        assert_eq!(s.z_mode, 2);
        assert!(s.collapsed && s.is_open);
        // home_* is not overwritten by later moves (17-#48)
        save_geometry(
            c,
            "n1",
            &Geometry {
                x: 1,
                y: 2,
                w: 3,
                h: 4,
                monitor_key: Some("m2".into()),
                scale: None,
            },
        )
        .unwrap();
        let s = get(c, "n1").unwrap().unwrap();
        assert_eq!(s.home_display_id.as_deref(), Some("m1"));
        assert_eq!(s.monitor_key.as_deref(), Some("m2"));
        assert_eq!(open_note_ids(c, 40).unwrap(), vec!["n1".to_string()]);
        set_is_open(c, "n1", false).unwrap();
        assert!(open_note_ids(c, 40).unwrap().is_empty());
    }
}
