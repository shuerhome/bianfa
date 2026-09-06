//! `plum.sqlite` reader. Always works on a copy of the trio (`plum.sqlite`, `-wal`, `-shm`)
//! opened `?mode=ro`; columns are read by name (18/19-column drift).

use super::text::{parse_server_version, parse_text_field, parse_window_position, ticks_to_ms};
use super::{PlumAttachment, PlumExportNote};
use crate::colors::NoteColor;
use crate::error::{IpcError, IpcResult};
use crate::util::{ms_to_iso, title_of};
use rusqlite::{Connection, OpenFlags};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Copies `plum.sqlite(-wal/-shm)` and `media/` into `dest_dir`; returns the copied DB path.
pub fn archive(src: &Path, dest_dir: &Path) -> IpcResult<PathBuf> {
    std::fs::create_dir_all(dest_dir)?;
    let dst = dest_dir.join("plum.sqlite");
    for suffix in ["", "-wal", "-shm"] {
        let mut from = src.as_os_str().to_owned();
        from.push(suffix);
        let from = PathBuf::from(from);
        if from.exists() {
            let mut to = dst.as_os_str().to_owned();
            to.push(suffix);
            std::fs::copy(&from, PathBuf::from(to))?;
        }
    }
    if let Some(parent) = src.parent() {
        let media = parent.join("media");
        if media.is_dir() {
            copy_dir(&media, &dest_dir.join("media"))?;
        }
    }
    Ok(dst)
}

fn copy_dir(from: &Path, to: &Path) -> IpcResult<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn open_ro(path: &Path) -> IpcResult<Connection> {
    let uri = format!(
        "file:{}?mode=ro",
        path.to_string_lossy().replace('\\', "/").replace('?', "%3F")
    );
    Ok(Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?)
}

fn table_columns(conn: &Connection, table: &str) -> HashSet<String> {
    let mut set = HashSet::new();
    if let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info(\"{table}\")")) {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(1)) {
            for name in rows.flatten() {
                set.insert(name);
            }
        }
    }
    set
}

fn tables(conn: &Connection) -> HashSet<String> {
    let mut set = HashSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for name in rows.flatten() {
                set.insert(name);
            }
        }
    }
    set
}

/// Number of non-deleted notes (uses a scratch copy; never opens the live DB).
pub fn count(src: &Path, scratch_dir: &Path) -> IpcResult<i64> {
    let dir = scratch_dir.join(format!(".scan-{}", crate::util::uuid_v4()));
    let result = (|| {
        let copy = archive_db_only(src, &dir)?;
        let conn = open_ro(&copy)?;
        let cols = table_columns(&conn, "Note");
        if !cols.contains("Id") {
            return Err(IpcError::invalid("no Note table"));
        }
        let sql = if cols.contains("DeletedAt") {
            "SELECT count(*) FROM \"Note\" WHERE \"DeletedAt\" IS NULL"
        } else {
            "SELECT count(*) FROM \"Note\""
        };
        Ok(conn.query_row(sql, [], |r| r.get::<_, i64>(0))?)
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn archive_db_only(src: &Path, dest_dir: &Path) -> IpcResult<PathBuf> {
    std::fs::create_dir_all(dest_dir)?;
    let dst = dest_dir.join("plum.sqlite");
    for suffix in ["", "-wal", "-shm"] {
        let mut from = src.as_os_str().to_owned();
        from.push(suffix);
        let from = PathBuf::from(from);
        if from.exists() {
            let mut to = dst.as_os_str().to_owned();
            to.push(suffix);
            std::fs::copy(&from, PathBuf::from(to))?;
        }
    }
    Ok(dst)
}

/// Parses an (archived) plum.sqlite into export notes, newest first.
pub fn parse(db_path: &Path) -> IpcResult<Vec<PlumExportNote>> {
    let conn = open_ro(db_path)?;
    let tabs = tables(&conn);
    let cols = table_columns(&conn, "Note");
    if !cols.contains("Id") {
        return Err(IpcError::invalid("not a plum.sqlite: missing Note table"));
    }
    let col = |name: &str| -> String {
        if cols.contains(name) {
            format!("\"{name}\"")
        } else {
            "NULL".to_string()
        }
    };
    let sql = format!(
        "SELECT \"Id\", {}, {}, {}, {}, {}, {}, {}, {}, {} FROM \"Note\"",
        col("Text"),
        col("LastServerVersion"),
        col("Theme"),
        col("IsOpen"),
        col("IsAlwaysOnTop"),
        col("WindowPosition"),
        col("CreatedAt"),
        col("UpdatedAt"),
        col("DeletedAt"),
    );

    let mut media: HashMap<String, Vec<PlumAttachment>> = HashMap::new();
    if tabs.contains("Media") {
        let mc = table_columns(&conn, "Media");
        if mc.contains("ParentId") && mc.contains("LocalFileRelativePath") {
            let mime = if mc.contains("MimeType") { "\"MimeType\"" } else { "NULL" };
            let mut stmt = conn.prepare(&format!(
                "SELECT \"ParentId\", \"LocalFileRelativePath\", {mime} FROM \"Media\""
            ))?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })?;
            for (pid, path, mime) in rows.flatten() {
                if let (Some(pid), Some(path)) = (pid, path) {
                    media.entry(pid).or_default().push(PlumAttachment { path, mime });
                }
            }
        }
    }
    let mut ink: HashSet<String> = HashSet::new();
    if tabs.contains("Stroke") && table_columns(&conn, "Stroke").contains("ParentId") {
        let mut stmt = conn.prepare("SELECT DISTINCT \"ParentId\" FROM \"Stroke\"")?;
        for id in stmt.query_map([], |r| r.get::<_, Option<String>>(0))?.flatten().flatten() {
            ink.insert(id);
        }
    }

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| {
        Ok(RawRow {
            id: r.get::<_, Option<String>>(0)?,
            text: r.get::<_, Option<String>>(1)?,
            server: r.get::<_, Option<String>>(2)?,
            theme: r.get::<_, Option<String>>(3)?,
            is_open: r.get::<_, Option<i64>>(4)?,
            pinned: r.get::<_, Option<i64>>(5)?,
            winpos: r.get::<_, Option<String>>(6)?,
            created: r.get::<_, Option<i64>>(7)?,
            updated: r.get::<_, Option<i64>>(8)?,
            deleted: r.get::<_, Option<i64>>(9)?,
        })
    })?;

    let mut notes = Vec::new();
    for row in rows {
        // A single bad row must not abort the batch (05 §7.4 item 6).
        let Ok(row) = row else { continue };
        let Some(id) = row.id else { continue };
        if row.deleted.is_some() {
            continue;
        }
        let (markdown, text, degraded, content_source) =
            match parse_server_version(row.server.as_deref()) {
                Some(body) => (body.clone(), body, false, "LastServerVersion"),
                None => {
                    let p = parse_text_field(row.text.as_deref());
                    (p.markdown, p.plain, p.degraded, "Text")
                }
            };
        let created_ms = ticks_to_ms(row.created);
        let updated_ms = ticks_to_ms(row.updated);
        notes.push(PlumExportNote {
            title: title_of(&text),
            external_id: id.clone(),
            source: "plum.sqlite".into(),
            markdown,
            text,
            color: NoteColor::from_plum_theme(row.theme.as_deref().unwrap_or(""))
                .as_str()
                .into(),
            original_theme: row.theme,
            pinned: row.pinned.unwrap_or(0) != 0,
            is_open: row.is_open.unwrap_or(0) != 0,
            window: parse_window_position(row.winpos.as_deref()),
            created_at: created_ms.and_then(ms_to_iso),
            updated_at: updated_ms.and_then(ms_to_iso),
            created_at_ms: created_ms,
            updated_at_ms: updated_ms,
            attachments: media.remove(&id).unwrap_or_default(),
            has_ink: ink.contains(&id),
            content_source: content_source.into(),
            import_degraded: degraded,
        });
    }
    notes.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    Ok(notes)
}

struct RawRow {
    id: Option<String>,
    text: Option<String>,
    server: Option<String>,
    theme: Option<String>,
    is_open: Option<i64>,
    pinned: Option<i64>,
    winpos: Option<String>,
    created: Option<i64>,
    updated: Option<i64>,
    deleted: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticks(ms: i64) -> i64 {
        (ms + super::super::text::TICKS_EPOCH_OFFSET_MS) * 10_000
    }

    fn build(path: &Path, extra_col: bool) {
        let c = Connection::open(path).unwrap();
        let extra = if extra_col { ", \"PendingInsightsScan\" integer" } else { "" };
        c.execute_batch(&format!(
            "CREATE TABLE \"Note\"(\"Text\" varchar, \"WindowPosition\" varchar, \"IsOpen\" integer, \"IsAlwaysOnTop\" integer,
             \"CreationNoteIdAnchor\" varchar, \"Theme\" varchar, \"IsFutureNote\" integer, \"RemoteId\" varchar,
             \"ChangeKey\" varchar, \"LastServerVersion\" varchar, \"RemoteSchemaVersion\" integer,
             \"IsRemoteDataInvalid\" integer, \"Type\" varchar, \"Id\" varchar primary key not null,
             \"ParentId\" varchar, \"CreatedAt\" bigint, \"DeletedAt\" bigint, \"UpdatedAt\" bigint{extra});
             CREATE TABLE \"Media\"(\"Id\" varchar primary key,\"ParentId\" varchar,\"MimeType\" varchar,\"LocalFileRelativePath\" varchar,\"CreatedAt\" bigint,\"UpdatedAt\" bigint);
             CREATE TABLE \"Stroke\"(\"Id\" varchar primary key,\"ParentId\" varchar);"
        ))
        .unwrap();
        let server_json = r#"{"document":{"blocks":[{"content":[{"text":"服务器续费"},{"text":"Hostinger KVM 4 到期 11/20"}]}]}}"#;
        let rows: Vec<(&str, Option<&str>, i64, i64, &str, Option<&str>, &str, i64, Option<i64>, i64)> = vec![
            (r"\id=8f14e45f-ceea-467a-9b0a-1c2d3e4f5a6b 周三 14:00 \b产品评审\b0\par确认 OKLCH 色板 v2.3\par\i下周补 macOS 验证\i0",
             Some("ManagedPosition=DeviceId:{DISPLAY1};Position=340,180;Size=320,320"), 1, 1, "Yellow", None, "n-001", ticks(1756000000000), None, ticks(1756800000000)),
            (r"\id=aaaa1111-2222-3333-4444-555566667777 取快递\par丰巢 8-2211，取件码 4471",
             Some("ManagedPosition=DeviceId:{DISPLAY2};Position=-1600,-240;Size=180,140"), 1, 0, "Pink", None, "n-002", ticks(1755000000000), None, ticks(1755500000000)),
            (r"\id=bbbb 这段应该被忽略", Some("ManagedPosition=DeviceId:{DISPLAY1};Position=900,120;Size=220,260"), 0, 0, "Blue", Some(server_json), "n-003", ticks(1754000000000), None, ticks(1756100000000)),
            (r"\id=cccc 这条已删除", None, 0, 0, "Green", None, "n-004", ticks(1753000000000), Some(ticks(1756000000000)), ticks(1756000000000)),
            (r"\id=dddd 买菜\par\zzz西红柿 2 斤\par\strike已买\strike0 牛奶", None, 1, 0, "Teal", None, "n-005", ticks(1752000000000), None, ticks(1752500000000)),
        ];
        for (text, pos, open, top, theme, server, id, created, deleted, updated) in rows {
            if extra_col {
                c.execute("INSERT INTO \"Note\" (\"Text\",\"WindowPosition\",\"IsOpen\",\"IsAlwaysOnTop\",\"Theme\",\"LastServerVersion\",\"Id\",\"CreatedAt\",\"DeletedAt\",\"UpdatedAt\",\"PendingInsightsScan\") VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0)",
                    rusqlite::params![text, pos, open, top, theme, server, id, created, deleted, updated]).unwrap();
            } else {
                c.execute("INSERT INTO \"Note\" (\"Text\",\"WindowPosition\",\"IsOpen\",\"IsAlwaysOnTop\",\"Theme\",\"LastServerVersion\",\"Id\",\"CreatedAt\",\"DeletedAt\",\"UpdatedAt\") VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                    rusqlite::params![text, pos, open, top, theme, server, id, created, deleted, updated]).unwrap();
            }
        }
        c.execute("INSERT INTO \"Media\" VALUES ('m1','n-001','image/png','media/abc123.png',0,0)", []).unwrap();
        c.execute("INSERT INTO \"Stroke\" VALUES ('s1','n-002')", []).unwrap();
    }

    fn run_case(extra_col: bool) {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("plum.sqlite");
        build(&db, extra_col);
        std::fs::create_dir_all(dir.path().join("media")).unwrap();
        std::fs::write(dir.path().join("media/abc123.png"), b"png").unwrap();
        assert_eq!(count(&db, dir.path()).unwrap(), 4);
        let out = dir.path().join("out");
        let copy = archive(&db, &out).unwrap();
        assert!(out.join("media/abc123.png").exists());
        let notes = parse(&copy).unwrap();
        let by = |id: &str| notes.iter().find(|n| n.external_id == id).unwrap();
        assert_eq!(notes.len(), 4);
        assert_eq!(by("n-001").markdown, "周三 14:00 **产品评审**\n确认 OKLCH 色板 v2.3\n*下周补 macOS 验证*");
        assert!(notes.iter().all(|n| !n.markdown.contains("\\id=")));
        assert_eq!(by("n-005").markdown, "买菜\n西红柿 2 斤\n~~已买~~牛奶");
        assert!(by("n-005").import_degraded);
        let w = by("n-002").window.clone().unwrap();
        assert_eq!((w.x, w.y, w.w, w.h), (Some(-1600), Some(-240), Some(180), Some(140)));
        assert_eq!(w.display_id.as_deref(), Some("{DISPLAY2}"));
        assert_eq!(by("n-003").content_source, "LastServerVersion");
        assert!(by("n-003").text.contains("服务器续费") && !by("n-003").text.contains("应该被忽略"));
        assert!(notes.iter().all(|n| n.external_id != "n-004"));
        assert!(by("n-001").pinned && !by("n-002").pinned);
        assert_eq!(by("n-001").color, "citron");
        assert_eq!(by("n-005").color, "citron");
        assert!(by("n-001").created_at.as_deref().unwrap().starts_with("2025-"));
        assert_eq!(by("n-001").attachments[0].path, "media/abc123.png");
        assert!(by("n-002").has_ink && !by("n-001").has_ink);
        assert_eq!(by("n-001").title, "周三 14:00 产品评审");
        // newest first
        assert_eq!(notes[0].external_id, "n-001");
        assert!(by("n-001").is_open && !by("n-003").is_open);
    }

    #[test]
    fn eighteen_and_nineteen_columns() {
        run_case(false);
        run_case(true);
    }
}
