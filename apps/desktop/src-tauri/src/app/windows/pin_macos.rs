//! macOS levels (05 §3.1 / §3.3). Window level for "pinned to desktop" is looked up at runtime
//! (`CGWindowLevelForKey(kCGDesktopIconWindowLevelKey) + 1`), never hard-coded.

use super::super::state::AppState;
use crate::error::{IpcError, IpcResult};
use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewWindow};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowLevelForKey(key: i32) -> i32;
}

const K_CG_DESKTOP_ICON_WINDOW_LEVEL_KEY: i32 = 18;
const NS_NORMAL_WINDOW_LEVEL: isize = 0;
const NS_FLOATING_WINDOW_LEVEL: isize = 3;

/// Labels currently pinned to the desktop (for the read-only fallback focus handling).
static DESKTOP_PINNED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn pinned() -> std::sync::MutexGuard<'static, Option<HashSet<String>>> {
    DESKTOP_PINNED
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

pub fn desktop_level() -> isize {
    // SAFETY: plain C call with no side effects.
    (unsafe { CGWindowLevelForKey(K_CG_DESKTOP_ICON_WINDOW_LEVEL_KEY) }) as isize + 1
}

fn apply_level(app: &AppHandle, win: &WebviewWindow, level: isize, behavior: NSWindowCollectionBehavior) -> IpcResult<()> {
    let w = win.clone();
    app.run_on_main_thread(move || {
        if let Ok(ptr) = w.ns_window() {
            // SAFETY: `ns_window` returns a live NSWindow*; we are on the main thread.
            let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
            ns.setLevel(level);
            ns.setCollectionBehavior(behavior);
        }
    })
    .map_err(|e| IpcError::internal(e.to_string()))
}

pub fn set_normal(app: &AppHandle, win: &WebviewWindow) -> IpcResult<()> {
    pinned().get_or_insert_with(HashSet::new).remove(win.label());
    apply_level(app, win, NS_NORMAL_WINDOW_LEVEL, NSWindowCollectionBehavior::Default)
}

/// Always-on-top: floating level + joins all spaces / stays over full-screen apps.
pub fn set_floating(app: &AppHandle, win: &WebviewWindow) -> IpcResult<()> {
    pinned().get_or_insert_with(HashSet::new).remove(win.label());
    apply_level(
        app,
        win,
        NS_FLOATING_WINDOW_LEVEL,
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::FullScreenAuxiliary,
    )
}

/// Pinned to desktop: just above desktop icons, stationary (Mission Control / "show desktop"
/// leave it alone), ignored by ⌘` cycling.
pub fn set_desktop(app: &AppHandle, win: &WebviewWindow) -> IpcResult<()> {
    pinned().get_or_insert_with(HashSet::new).insert(win.label().to_string());
    apply_level(
        app,
        win,
        desktop_level(),
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    )
}

pub fn desktop_edit(app: &AppHandle, win: &WebviewWindow, editing: bool) -> IpcResult<()> {
    if editing {
        apply_level(
            app,
            win,
            NS_NORMAL_WINDOW_LEVEL,
            NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::Stationary,
        )?;
        let _ = win.set_focus();
        Ok(())
    } else {
        set_desktop(app, win)
    }
}

/// With `desktopPinReadonly`, losing focus drops a temporarily-lifted note back to desktop level.
pub fn on_focus(app: &AppHandle, label: &str, focused: bool) {
    if focused {
        return;
    }
    let is_pinned = pinned()
        .as_ref()
        .map(|s| s.contains(label))
        .unwrap_or(false);
    if !is_pinned {
        return;
    }
    let readonly = app.state::<AppState>().settings().desktop_pin_readonly;
    if readonly {
        if let Some(w) = app.get_webview_window(label) {
            let _ = set_desktop(app, &w);
        }
    }
}
