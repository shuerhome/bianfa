//! Windows Sticky Notes import (05 §7.4, 02 §7): `plum.sqlite` (UWP) and legacy
//! `StickyNotes.snt` (CFBF). Rust only parses and archives; the Y.Doc is built in JS.

pub mod plum;
pub mod snt;
pub mod text;

use crate::error::{IpcError, IpcResult};
use crate::util::now_ms;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const PLUM_PACKAGE: &str = "Microsoft.MicrosoftStickyNotes_8wekyb3d8bbwe";
pub const SOURCE_PLUM: &str = "plum";
pub const SOURCE_SNT: &str = "snt";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlumAttachment {
    pub path: String,
    pub mime: Option<String>,
}

/// One note as produced by `tools/export_sticky_notes.py` (snake_case JSON, ISO timestamps),
/// plus `created_at_ms` / `updated_at_ms` for convenience.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlumExportNote {
    pub external_id: String,
    pub source: String,
    pub title: String,
    pub markdown: String,
    pub text: String,
    pub color: String,
    pub original_theme: Option<String>,
    pub pinned: bool,
    pub is_open: bool,
    pub window: Option<text::WindowPos>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub created_at_ms: Option<i64>,
    pub updated_at_ms: Option<i64>,
    pub attachments: Vec<PlumAttachment>,
    pub has_ink: bool,
    pub content_source: String,
    pub import_degraded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub kind: String,
    pub path: String,
    pub count: i64,
    pub sticky_notes_running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub notes: Vec<PlumExportNote>,
    pub archived_to: String,
}

/// Kind of a user-selected or auto-detected source file.
pub fn kind_of(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    if name.ends_with(".snt") {
        Some(SOURCE_SNT)
    } else if name.ends_with(".sqlite") || name.ends_with(".db") {
        Some(SOURCE_PLUM)
    } else {
        None
    }
}

/// Default locations on Windows (`%LOCALAPPDATA%` / `%APPDATA%`).
pub fn default_candidates() -> Vec<(&'static str, PathBuf)> {
    let mut v = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        v.push((
            SOURCE_PLUM,
            PathBuf::from(local)
                .join("Packages")
                .join(PLUM_PACKAGE)
                .join("LocalState")
                .join("plum.sqlite"),
        ));
    }
    if let Some(roaming) = std::env::var_os("APPDATA") {
        v.push((
            SOURCE_SNT,
            PathBuf::from(roaming)
                .join("Microsoft")
                .join("Sticky Notes")
                .join("StickyNotes.snt"),
        ));
    }
    v
}

/// Is the UWP Sticky Notes process alive? (Windows only; best effort via `tasklist`.)
pub fn sticky_notes_running() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq Microsoft.Notes.exe", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(o) = out {
            let s = String::from_utf8_lossy(&o.stdout).to_ascii_lowercase();
            return s.contains("microsoft.notes.exe");
        }
        false
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Scans default locations; `count` opens a read-only copy so it never touches the live DB.
pub fn scan(scratch_dir: &Path) -> Vec<ImportSource> {
    let running = sticky_notes_running();
    let mut out = Vec::new();
    for (kind, path) in default_candidates() {
        if !path.exists() {
            continue;
        }
        let count = match kind {
            SOURCE_PLUM => plum::count(&path, scratch_dir).unwrap_or(0),
            _ => snt::count(&path).unwrap_or(0),
        };
        out.push(ImportSource {
            kind: kind.to_string(),
            path: path.to_string_lossy().into_owned(),
            count,
            sticky_notes_running: running,
        });
    }
    out
}

/// Copies the source (plum trio + media/, or the .snt) into `imports/<timestamp>/` and parses
/// the archived copy read-only.
pub fn preview(path: &Path, imports_dir: &Path) -> IpcResult<ImportPreview> {
    if !path.exists() {
        return Err(IpcError::not_found(format!("{} not found", path.display())));
    }
    let kind = kind_of(path).ok_or_else(|| IpcError::invalid("unsupported import file"))?;
    let archive = imports_dir.join(now_ms().to_string());
    std::fs::create_dir_all(&archive)?;
    let notes = match kind {
        SOURCE_PLUM => {
            let copy = plum::archive(path, &archive)?;
            plum::parse(&copy)?
        }
        _ => {
            let copy = archive.join(path.file_name().unwrap_or_default());
            std::fs::copy(path, &copy)?;
            snt::parse(&copy)?
        }
    };
    Ok(ImportPreview {
        notes,
        archived_to: archive.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(kind_of(Path::new("C:/x/plum.sqlite")), Some(SOURCE_PLUM));
        assert_eq!(kind_of(Path::new("/x/StickyNotes.snt")), Some(SOURCE_SNT));
        assert_eq!(kind_of(Path::new("/x/notes.txt")), None);
    }
}
