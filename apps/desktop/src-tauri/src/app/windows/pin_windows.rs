//! Pin-to-desktop on Windows — "plan B" (05 §3.2, 01-C4): the note stays a normal top-level
//! window (never `SetParent`ed into WorkerW, so keyboard + IME keep working) and is sunk with
//! `HWND_BOTTOM`. A hidden probe window at the very bottom of the z-order tells us whether
//! Win+D / "Show desktop" lifted the desktop host above us; a WinEvent foreground hook and a
//! 3 s timer re-sink windows that got lifted.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindow};
use windows::core::{s, w, PCWSTR};
use windows::Win32::Foundation::{HINSTANCE, HMODULE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::RemoteDesktop::WTSRegisterSessionNotification;
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, EnumWindows, FindWindowExW, GetClassNameW, GetShellWindow,
    GetWindow, GetWindowLongPtrW, IsWindowVisible, RegisterClassW, RegisterWindowMessageW,
    SetWindowLongPtrW, SetWindowPos, EVENT_SYSTEM_FOREGROUND, GWL_EXSTYLE, GW_HWNDNEXT,
    HWND_BOTTOM, HWND_NOTOPMOST, HWND_TOP, HWND_TOPMOST, PBT_APMRESUMEAUTOMATIC,
    SET_WINDOW_POS_FLAGS, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
    SWP_NOSENDCHANGING, SWP_NOSIZE, WINDOW_EX_STYLE, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WNDCLASSW,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_POPUP, WTS_CONSOLE_CONNECT, WTS_SESSION_UNLOCK,
};

const PROBE_CLASS: PCWSTR = w!("BianfaZProbe");
const NOTIFY_FOR_THIS_SESSION: u32 = 0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Dock {
    Docked,
    Editing,
    ShowDesktop,
}

#[derive(Default)]
struct Registry {
    /// hwnd (as isize) → state, for every desktop-pinned note.
    docked: HashMap<isize, Dock>,
    /// label → hwnd, so window events can find the hwnd after the window is gone.
    labels: HashMap<String, isize>,
    probe: isize,
    host: isize,
    hook: isize,
    taskbar_created_msg: u32,
    show_desktop: bool,
    initialized: bool,
}

static REG: Mutex<Option<Registry>> = Mutex::new(None);

fn reg() -> std::sync::MutexGuard<'static, Option<Registry>> {
    let mut g = REG.lock().unwrap_or_else(|p| p.into_inner());
    if g.is_none() {
        *g = Some(Registry::default());
    }
    g
}

fn hwnd(v: isize) -> HWND {
    HWND(v as *mut core::ffi::c_void)
}

/// Rainmeter's ZPOS_FLAGS.
const SINK_FLAGS: SET_WINDOW_POS_FLAGS = SET_WINDOW_POS_FLAGS(
    SWP_NOMOVE.0 | SWP_NOSIZE.0 | SWP_NOOWNERZORDER.0 | SWP_NOACTIVATE.0 | SWP_NOSENDCHANGING.0,
);

fn sink(h: isize) {
    // SAFETY: plain Win32 call on a window handle we own.
    let _ = unsafe { SetWindowPos(hwnd(h), Some(HWND_BOTTOM), 0, 0, 0, 0, SINK_FLAGS) };
}

fn set_topmost(h: isize, on: bool) {
    let after = if on { HWND_TOPMOST } else { HWND_NOTOPMOST };
    let _ = unsafe { SetWindowPos(hwnd(h), Some(after), 0, 0, 0, 0, SINK_FLAGS) };
}

fn add_ex_style(h: isize, style: WINDOW_EX_STYLE, on: bool) {
    unsafe {
        let ex = GetWindowLongPtrW(hwnd(h), GWL_EXSTYLE) as u32;
        let next = if on { ex | style.0 } else { ex & !style.0 };
        if next != ex {
            SetWindowLongPtrW(hwnd(h), GWL_EXSTYLE, next as isize);
        }
    }
}

fn class_name(h: HWND) -> String {
    let mut buf = [0u16; 64];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

unsafe extern "system" fn enum_workerw(h: HWND, lparam: LPARAM) -> windows::core::BOOL {
    if class_name(h) == "WorkerW"
        && FindWindowExW(Some(h), None, w!("SHELLDLL_DefView"), PCWSTR::null()).is_ok()
    {
        *(lparam.0 as *mut isize) = h.0 as isize;
        return windows::core::BOOL(0);
    }
    windows::core::BOOL(1)
}

/// The window hosting the desktop icons: `GetShellWindow()` on 24H2+, otherwise the WorkerW
/// that hosts `SHELLDLL_DefView`. Re-resolved after `TaskbarCreated` (Explorer restart).
fn desktop_icons_host() -> isize {
    unsafe {
        let is_24h2 = GetModuleHandleW(w!("user32.dll"))
            .ok()
            .and_then(|m| GetProcAddress(m, s!("GetCurrentMonitorTopologyId")))
            .is_some();
        let shell = GetShellWindow();
        if is_24h2 {
            return shell.0 as isize;
        }
        let mut found: isize = 0;
        let _ = EnumWindows(Some(enum_workerw), LPARAM(&mut found as *mut isize as isize));
        if found != 0 {
            return found;
        }
        if FindWindowExW(Some(shell), None, w!("SHELLDLL_DefView"), PCWSTR::null()).is_ok() {
            return shell.0 as isize;
        }
        shell.0 as isize
    }
}

/// The probe sits below everything; if it is found *after* the host in z-order, the host was
/// raised above it ⇒ Win+D / show-desktop is active.
fn is_show_desktop(host: isize) -> bool {
    if host == 0 {
        return false;
    }
    unsafe {
        IsWindowVisible(hwnd(host)).as_bool()
            && FindWindowExW(None, Some(hwnd(host)), PROBE_CLASS, PCWSTR::null()).is_ok()
    }
}

fn update_show_desktop(show: bool) {
    let mut g = reg();
    let r = g.as_mut().expect("registry");
    if show == r.show_desktop {
        return;
    }
    r.show_desktop = show;
    let handles: Vec<isize> = r.docked.keys().copied().collect();
    for h in handles {
        if show {
            set_topmost(h, true);
            r.docked.insert(h, Dock::ShowDesktop);
        } else {
            set_topmost(h, false);
            sink(h);
            r.docked.insert(h, Dock::Docked);
        }
    }
}

unsafe extern "system" fn on_foreground(
    _hook: HWINEVENTHOOK,
    _event: u32,
    h: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    let host = reg().as_ref().map(|r| r.host).unwrap_or(0);
    let mut show = false;
    // Eat the 24H2 show-desktop animation race (05 §3.2).
    for _ in 0..5 {
        if is_show_desktop(host) {
            show = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    let fg = h.0 as isize;
    {
        let mut g = reg();
        if let Some(r) = g.as_mut() {
            if r.docked.contains_key(&fg) && !show {
                r.docked.insert(fg, Dock::Editing);
            }
        }
    }
    update_show_desktop(show);
}

unsafe extern "system" fn probe_wndproc(h: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let taskbar_created = reg().as_ref().map(|r| r.taskbar_created_msg).unwrap_or(0);
    match msg {
        WM_WTSSESSION_CHANGE => {
            let code = wparam.0 as u32;
            if code == WTS_SESSION_UNLOCK || code == WTS_CONSOLE_CONNECT {
                sink_all();
            }
        }
        WM_POWERBROADCAST => {
            if wparam.0 as u32 == PBT_APMRESUMEAUTOMATIC {
                sink_all();
            }
        }
        m if m != 0 && m == taskbar_created => {
            let host = desktop_icons_host();
            if let Some(r) = reg().as_mut() {
                r.host = host;
            }
            sink_all();
        }
        _ => {}
    }
    DefWindowProcW(h, msg, wparam, lparam)
}

fn sink_all() {
    let handles: Vec<isize> = reg()
        .as_ref()
        .map(|r| r.docked.keys().copied().collect())
        .unwrap_or_default();
    for h in handles {
        sink(h);
    }
    if let Some(r) = reg().as_mut() {
        for v in r.docked.values_mut() {
            *v = Dock::Docked;
        }
        r.show_desktop = false;
    }
}

unsafe fn init() {
    if reg().as_ref().map(|r| r.initialized).unwrap_or(false) {
        return;
    }
    let hinst: HINSTANCE = GetModuleHandleW(None)
        .map(|m: HMODULE| HINSTANCE(m.0))
        .unwrap_or_default();
    let class = WNDCLASSW {
        lpfnWndProc: Some(probe_wndproc),
        hInstance: hinst,
        lpszClassName: PROBE_CLASS,
        ..Default::default()
    };
    RegisterClassW(&class);
    let probe = CreateWindowExW(
        WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        PROBE_CLASS,
        PROBE_CLASS,
        WS_POPUP,
        0,
        0,
        1,
        1,
        None,
        None,
        Some(hinst),
        None,
    )
    .map(|h| h.0 as isize)
    .unwrap_or(0);
    if probe != 0 {
        let _ = SetWindowPos(
            hwnd(probe),
            Some(HWND_BOTTOM),
            0,
            0,
            0,
            0,
            SET_WINDOW_POS_FLAGS(SINK_FLAGS.0 | SWP_HIDEWINDOW.0),
        );
        let _ = WTSRegisterSessionNotification(hwnd(probe), NOTIFY_FOR_THIS_SESSION);
    }
    let hook = SetWinEventHook(
        EVENT_SYSTEM_FOREGROUND,
        EVENT_SYSTEM_FOREGROUND,
        None,
        Some(on_foreground),
        0,
        0,
        WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
    );
    let taskbar_created_msg = RegisterWindowMessageW(w!("TaskbarCreated"));
    let host = desktop_icons_host();
    if let Some(r) = reg().as_mut() {
        r.probe = probe;
        r.hook = hook.0 as isize;
        r.host = host;
        r.taskbar_created_msg = taskbar_created_msg;
        r.initialized = true;
    }
    log::info!("pin-to-desktop probe ready (probe={probe:#x}, host={host:#x})");
}

/// Must be called on the main thread (the hook needs its message loop).
pub fn setup(app: &AppHandle) {
    let _ = app.run_on_main_thread(|| unsafe { init() });
}

fn hwnd_of(win: &WebviewWindow) -> Option<isize> {
    win.hwnd().ok().map(|h| h.0 as isize)
}

pub fn enter_docked(app: &AppHandle, win: &WebviewWindow) -> crate::error::IpcResult<()> {
    setup(app);
    let Some(h) = hwnd_of(win) else {
        return Err(crate::error::IpcError::internal("window has no HWND"));
    };
    // Tool-window style keeps it out of Alt-Tab; never WS_EX_NOACTIVATE (would lose keyboard).
    add_ex_style(h, WS_EX_TOOLWINDOW, true);
    sink(h);
    if let Some(r) = reg().as_mut() {
        r.docked.insert(h, Dock::Docked);
        r.labels.insert(win.label().to_string(), h);
    }
    Ok(())
}

pub fn leave_docked(app: &AppHandle, win: &WebviewWindow) -> crate::error::IpcResult<()> {
    let _ = app;
    let Some(h) = hwnd_of(win) else {
        return Ok(());
    };
    let was = reg().as_mut().and_then(|r| {
        r.labels.remove(win.label());
        r.docked.remove(&h)
    });
    if was.is_some() {
        unsafe {
            let _ = SetWindowPos(hwnd(h), Some(HWND_NOTOPMOST), 0, 0, 0, 0, SINK_FLAGS);
            let _ = SetWindowPos(hwnd(h), Some(HWND_TOP), 0, 0, 0, 0, SINK_FLAGS);
        }
    }
    Ok(())
}

pub fn forget(app: &AppHandle, label: &str) {
    let _ = app;
    if let Some(r) = reg().as_mut() {
        if let Some(h) = r.labels.remove(label) {
            r.docked.remove(&h);
        }
    }
}

/// Focus lost on a docked note → 200 ms debounce → sink (05 §3.2 Editing → Docked).
pub fn on_focus(app: &AppHandle, label: &str, focused: bool) {
    let h = match reg().as_ref().and_then(|r| r.labels.get(label).copied()) {
        Some(h) => h,
        None => return,
    };
    if focused {
        if let Some(r) = reg().as_mut() {
            if !r.show_desktop {
                r.docked.insert(h, Dock::Editing);
            }
        }
        return;
    }
    let app = app.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let _ = app.run_on_main_thread(move || {
            let still_unfocused = app
                .get_webview_window(&label)
                .map(|w| !w.is_focused().unwrap_or(false))
                .unwrap_or(false);
            let mut g = reg();
            let Some(r) = g.as_mut() else { return };
            if still_unfocused && !r.show_desktop && r.docked.contains_key(&h) {
                sink(h);
                r.docked.insert(h, Dock::Docked);
            }
        });
    });
}

/// A docked window is "lifted" when a visible, non-tool, foreign top-level window sits below it.
fn is_lifted(h: isize) -> bool {
    let (docked, host, probe) = {
        let g = reg();
        let r = g.as_ref().expect("registry");
        (r.docked.keys().copied().collect::<Vec<_>>(), r.host, r.probe)
    };
    unsafe {
        let mut cur = hwnd(h);
        for _ in 0..256 {
            let Ok(next) = GetWindow(cur, GW_HWNDNEXT) else { break };
            if next.0.is_null() {
                break;
            }
            cur = next;
            let v = next.0 as isize;
            if v == host || v == probe || docked.contains(&v) {
                continue;
            }
            if !IsWindowVisible(next).as_bool() {
                continue;
            }
            let ex = GetWindowLongPtrW(next, GWL_EXSTYLE) as u32;
            if ex & WS_EX_TOOLWINDOW.0 != 0 {
                continue;
            }
            let cls = class_name(next);
            if matches!(cls.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
                continue;
            }
            return true;
        }
    }
    false
}

/// 3 s timer: re-sink docked windows that were lifted while idle.
pub fn tick(app: &AppHandle) {
    let _ = app;
    let candidates: Vec<isize> = reg()
        .as_ref()
        .map(|r| {
            if r.show_desktop {
                Vec::new()
            } else {
                r.docked
                    .iter()
                    .filter(|(_, s)| **s == Dock::Docked)
                    .map(|(h, _)| *h)
                    .collect()
            }
        })
        .unwrap_or_default();
    for h in candidates {
        if unsafe { IsWindowVisible(hwnd(h)).as_bool() } && is_lifted(h) {
            sink(h);
        }
    }
}
