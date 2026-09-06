//! Legacy `StickyNotes.snt` (Win7 – Win10 < 1607): a CFBF compound file. Every storage that
//! holds a stream `3` (UTF-16LE plain text) or `0` (RTF) is one note; storage ctime/mtime give
//! the timestamps. A broken storage never aborts the batch.

use super::text::rtf_to_text;
use super::PlumExportNote;
use crate::colors::NoteColor;
use crate::error::IpcResult;
use crate::util::{ms_to_iso, title_of};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn ms_of(t: SystemTime) -> Option<i64> {
    let d = t.duration_since(UNIX_EPOCH).ok()?;
    let ms = d.as_millis() as i64;
    // CFB epoch-zero timestamps mean "unset".
    if ms <= 0 {
        None
    } else {
        Some(ms)
    }
}

fn note_storages<F: Read + std::io::Seek>(
    cfb: &cfb::CompoundFile<F>,
) -> Vec<(PathBuf, SystemTime, SystemTime)> {
    cfb.walk()
        .filter(|e| e.is_storage() && !e.is_root())
        .filter(|e| {
            let p = e.path().to_path_buf();
            cfb.is_stream(p.join("3")) || cfb.is_stream(p.join("0"))
        })
        .map(|e| (e.path().to_path_buf(), e.created(), e.modified()))
        .collect()
}

pub fn count(path: &Path) -> IpcResult<i64> {
    let cfb = cfb::open(path)?;
    Ok(note_storages(&cfb).len() as i64)
}

fn read_stream<F: Read + std::io::Seek>(
    cfb: &mut cfb::CompoundFile<F>,
    p: &Path,
) -> Option<Vec<u8>> {
    let mut s = cfb.open_stream(p).ok()?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn utf16le(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect();
    String::from_utf16_lossy(&units)
        .trim_end_matches('\0')
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

pub fn parse(path: &Path) -> IpcResult<Vec<PlumExportNote>> {
    let mut cfb = cfb::open(path)?;
    let storages = note_storages(&cfb);
    let mut notes = Vec::new();
    for (sp, created, modified) in storages {
        let name = sp
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| sp.to_string_lossy().into_owned());
        let plain = read_stream(&mut cfb, &sp.join("3")).map(|b| utf16le(&b));
        let (text, degraded, source) = match plain {
            Some(t) if !t.trim().is_empty() => (t, false, "Text"),
            _ => match read_stream(&mut cfb, &sp.join("0")) {
                Some(rtf) => (rtf_to_text(&String::from_utf8_lossy(&rtf)), true, "Rtf"),
                None => continue,
            },
        };
        let created_ms = ms_of(created);
        let updated_ms = ms_of(modified).or(created_ms);
        notes.push(PlumExportNote {
            external_id: name,
            source: "StickyNotes.snt".into(),
            title: title_of(&text),
            markdown: text.clone(),
            text,
            color: NoteColor::Citron.as_str().into(),
            original_theme: None,
            pinned: false,
            is_open: true,
            window: None,
            created_at: created_ms.and_then(ms_to_iso),
            updated_at: updated_ms.and_then(ms_to_iso),
            created_at_ms: created_ms,
            updated_at_ms: updated_ms,
            attachments: Vec::new(),
            has_ink: false,
            content_source: source.into(),
            import_degraded: degraded,
        });
    }
    notes.sort_by_key(|n| std::cmp::Reverse(n.updated_at_ms));
    Ok(notes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn synthetic_snt() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("StickyNotes.snt");
        {
            let mut c = cfb::create(&p).unwrap();
            c.create_storage("/{A}").unwrap();
            let mut s = c.create_stream("/{A}/3").unwrap();
            let text: Vec<u8> = "你好\r\n第二行"
                .encode_utf16()
                .flat_map(|u| u.to_le_bytes())
                .collect();
            s.write_all(&text).unwrap();
            drop(s);
            c.create_storage("/{B}").unwrap();
            let mut s = c.create_stream("/{B}/0").unwrap();
            s.write_all(br"{\rtf1\ansi Only RTF\par here}").unwrap();
            drop(s);
            c.create_storage("/Metafiles").unwrap();
            c.flush().unwrap();
        }
        assert_eq!(count(&p).unwrap(), 2);
        let notes = parse(&p).unwrap();
        assert_eq!(notes.len(), 2);
        let a = notes.iter().find(|n| n.external_id == "{A}").unwrap();
        assert_eq!(a.text, "你好\n第二行");
        assert_eq!(a.title, "你好");
        assert!(!a.import_degraded);
        let b = notes.iter().find(|n| n.external_id == "{B}").unwrap();
        assert_eq!(b.text, "Only RTF\nhere");
        assert!(b.import_degraded);
    }
}
