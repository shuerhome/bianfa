//! z-mode application (05 §3): 0 normal / 1 always-on-top / 2 pinned-to-desktop.
//! Platform code lives in `pin_windows` / `pin_macos`; other targets return `unsupported`.

use crate::error::{IpcError, IpcResult};
use tauri::{AppHandle, WebviewWindow};

#[cfg(target_os = "windows")]
#[path = "pin_windows.rs"]
pub mod platform;

#[cfg(target_os = "macos")]
#[path = "pin_macos.rs"]
pub mod platform;

/// One-time platform setup (probe window + WinEvent hook on Windows). Must run on the main thread.
pub fn setup(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    platform::setup(app);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

pub fn apply(app: &AppHandle, win: &WebviewWindow, z_mode: i64) -> IpcResult<()> {
    match z_mode {
        0 => {
            win.set_always_on_top(false)?;
            #[cfg(target_os = "windows")]
            platform::leave_docked(app, win)?;
            #[cfg(target_os = "macos")]
            platform::set_normal(app, win)?;
            Ok(())
        }
        1 => {
            #[cfg(target_os = "windows")]
            platform::leave_docked(app, win)?;
            win.set_always_on_top(true)?;
            #[cfg(target_os = "macos")]
            platform::set_floating(app, win)?;
            Ok(())
        }
        2 => {
            win.set_always_on_top(false)?;
            #[cfg(target_os = "windows")]
            {
                platform::enter_docked(app, win)?;
                Ok(())
            }
            #[cfg(target_os = "macos")]
            {
                platform::set_desktop(app, win)?;
                Ok(())
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                let _ = app;
                Err(IpcError::unsupported(
                    "pin-to-desktop is not available on this platform",
                ))
            }
        }
        _ => Err(IpcError::invalid("zMode must be 0, 1 or 2")),
    }
}

/// Focus changes drive the Windows dock state machine and the macOS read-only fallback.
pub fn on_focus(app: &AppHandle, label: &str, focused: bool) {
    #[cfg(target_os = "windows")]
    platform::on_focus(app, label, focused);
    #[cfg(target_os = "macos")]
    platform::on_focus(app, label, focused);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, label, focused);
    }
}

/// macOS read-only fallback (05 §3.3): temporarily lift a desktop-pinned note to level 0 for
/// editing; `editing = false` puts it back.
pub fn desktop_edit(app: &AppHandle, win: &WebviewWindow, editing: bool) -> IpcResult<()> {
    #[cfg(target_os = "macos")]
    {
        platform::desktop_edit(app, win, editing)
    }
    // Windows notes are always editable while docked (05 §3.2 Editing state).
    #[cfg(target_os = "windows")]
    {
        let _ = (app, win, editing);
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, win, editing);
        Err(IpcError::unsupported(
            "pin-to-desktop is not available on this platform",
        ))
    }
}

/// Window destroyed → drop its dock bookkeeping.
pub fn forget(app: &AppHandle, label: &str) {
    #[cfg(target_os = "windows")]
    platform::forget(app, label);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, label);
    }
}

/// 3-second maintenance tick (Windows: re-sink lifted docked windows).
pub fn tick(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    platform::tick(app);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}
