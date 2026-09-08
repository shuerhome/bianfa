//! Window model (05 §2): note windows (`note-<uuid>` / prewarmed `note-pool-<n>`), the `main`,
//! `settings`, `login` singletons and the hidden `sync` host. Geometry is persisted in
//! `note_window_state` (physical pixels) and restored with a monitor sanity check.

pub mod pin;

use super::events;
use super::state::AppState;
use crate::colors::NoteColor;
use crate::db::{notes, window_state};
use crate::error::{IpcError, IpcResult};
use crate::model::WindowState;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tauri::webview::Color;
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

pub const MAIN: &str = "main";
pub const SETTINGS: &str = "settings";
pub const LOGIN: &str = "login";
pub const SYNC: &str = "sync";

pub const NOTE_DEFAULT: (f64, f64) = (220.0, 220.0);
pub const NOTE_MIN: (f64, f64) = (180.0, 140.0);
/// 便笺能被拉到多大就到此为止。
///
/// 没有上限时正文会被拉成一行几百个字，读起来要来回甩头——便笺是「扫一眼」的东西，
/// 不是文档窗口。760 逻辑像素在正文字号下大约 60–70 个汉字一行，接近排版上舒适的
/// 行长上限；高度给得很宽松（清单类便笺确实会很长），真正需要收住的只有宽度。
pub const NOTE_MAX: (f64, f64) = (760.0, 2000.0);
pub const NOTE_TITLEBAR_H: f64 = 28.0;
pub const MAIN_DEFAULT: (f64, f64) = (1120.0, 760.0);
pub const MAIN_MIN: (f64, f64) = (640.0, 480.0);
pub const SETTINGS_DEFAULT: (f64, f64) = (840.0, 620.0);
pub const SETTINGS_MIN: (f64, f64) = (680.0, 520.0);
pub const LOGIN_SIZE: (f64, f64) = (420.0, 360.0);

/// Soft cap → tray warning, hard cap → refuse (05 §2.3 / 18-裁决4(e)).
pub const VISIBLE_SOFT_CAP: usize = 24;
pub const VISIBLE_HARD_CAP: usize = 40;
pub const HIDE_AUTO_CLOSE: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct NoteWindows {
    by_note: HashMap<String, String>,
    by_label: HashMap<String, String>,
    pool: Option<String>,
    pool_counter: u32,
    colors: HashMap<String, NoteColor>,
    collapsed: HashSet<String>,
    pending_focus: HashSet<String>,
    hidden_since: Option<Instant>,
    hidden_labels: HashSet<String>,
}

impl NoteWindows {
    pub fn label_for(&self, note_id: &str) -> Option<&String> {
        self.by_note.get(note_id)
    }
    pub fn note_for(&self, label: &str) -> Option<&String> {
        self.by_label.get(label)
    }
    pub fn open_count(&self) -> usize {
        self.by_note.len()
    }
    pub fn labels(&self) -> Vec<String> {
        self.by_label.keys().cloned().collect()
    }
}

pub fn is_note_label(label: &str) -> bool {
    label.starts_with("note-")
}

fn with_registry<T>(app: &AppHandle, f: impl FnOnce(&mut NoteWindows) -> T) -> T {
    let state = app.state::<AppState>();
    let mut guard = state
        .windows
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut guard)
}

pub fn label_for(app: &AppHandle, note_id: &str) -> Option<String> {
    with_registry(app, |r| r.label_for(note_id).cloned())
}

pub fn note_id_for(app: &AppHandle, label: &str) -> Option<String> {
    with_registry(app, |r| r.note_for(label).cloned())
}

pub fn note_window(app: &AppHandle, note_id: &str) -> Option<WebviewWindow> {
    label_for(app, note_id).and_then(|l| app.get_webview_window(&l))
}

fn require_note_window(app: &AppHandle, note_id: &str) -> IpcResult<WebviewWindow> {
    note_window(app, note_id)
        .ok_or_else(|| IpcError::not_found(format!("no window open for note {note_id}")))
}

fn ui_scale(app: &AppHandle) -> f64 {
    app.state::<AppState>().settings().ui_scale_factor()
}

pub fn paper_color(app: &AppHandle, color: NoteColor) -> Color {
    let (r, g, b) = color.paper_rgb(super::theme::is_dark(app));
    Color(r, g, b, 255)
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

fn rect_center_inside(rect: &Rect, m: &Monitor) -> bool {
    let cx = rect.x as i64 + rect.w as i64 / 2;
    let cy = rect.y as i64 + rect.h as i64 / 2;
    let wa = m.work_area();
    let (mx, my) = (wa.position.x as i64, wa.position.y as i64);
    let (mw, mh) = (wa.size.width as i64, wa.size.height as i64);
    cx >= mx && cx < mx + mw && cy >= my && cy < my + mh
}

/// Centre of the primary (or first) monitor's work area for a window of `w`×`h` physical px.
fn centered_on_primary(app: &AppHandle, w: u32, h: u32) -> (i32, i32) {
    let m = app.primary_monitor().ok().flatten().or_else(|| {
        app.available_monitors()
            .ok()
            .and_then(|v| v.into_iter().next())
    });
    match m {
        Some(m) => {
            let wa = m.work_area();
            (
                wa.position.x + (wa.size.width as i32 - w as i32).max(0) / 2,
                wa.position.y + (wa.size.height as i32 - h as i32).max(0) / 2,
            )
        }
        None => (80, 80),
    }
}

/// Restores a saved rect, clamping to the primary display when its centre is off every
/// monitor (05 §2.4). `home_*` is left untouched by the caller.
pub fn sanitize_rect(app: &AppHandle, rect: Rect) -> Rect {
    let monitors = app.available_monitors().unwrap_or_default();
    if monitors.iter().any(|m| rect_center_inside(&rect, m)) {
        return rect;
    }
    let (x, y) = centered_on_primary(app, rect.w, rect.h);
    Rect { x, y, ..rect }
}

pub fn monitor_key(m: &Monitor) -> String {
    let raw = format!(
        "{}|{}x{}|{},{}",
        m.name().map(|s| s.as_str()).unwrap_or("?"),
        m.size().width,
        m.size().height,
        m.position().x,
        m.position().y
    );
    crate::util::sha256_hex(raw.as_bytes())[..16].to_string()
}

fn max_note_size(app: &AppHandle, m: Option<&Monitor>) -> LogicalSize<f64> {
    let (sw, sh) = match m {
        Some(m) => (
            m.size().width as f64 / m.scale_factor(),
            m.size().height as f64 / m.scale_factor(),
        ),
        None => (1920.0, 1080.0),
    };
    let _ = app;
    LogicalSize::new((sw * 0.5).min(720.0), (sh * 0.8).min(900.0))
}

fn apply_note_constraints(app: &AppHandle, win: &WebviewWindow) {
    let s = ui_scale(app);
    let _ = win.set_min_size(Some(LogicalSize::new(NOTE_MIN.0 * s, NOTE_MIN.1 * s)));
    let m = win.current_monitor().ok().flatten();
    let _ = win.set_max_size(Some(max_note_size(app, m.as_ref())));
}

/// Cursor position + (16,16) logical, flipped inside the monitor under the cursor (05 §4.2).
fn rect_at_cursor(app: &AppHandle, w: u32, h: u32) -> Option<Rect> {
    let cur = app.cursor_position().ok()?;
    let m = app.monitor_from_point(cur.x, cur.y).ok().flatten()?;
    let off = (16.0 * m.scale_factor()) as i32;
    let wa = m.work_area();
    let mut x = cur.x as i32 + off;
    let mut y = cur.y as i32 + off;
    if x + w as i32 > wa.position.x + wa.size.width as i32 {
        x = cur.x as i32 - off - w as i32;
    }
    if y + h as i32 > wa.position.y + wa.size.height as i32 {
        y = cur.y as i32 - off - h as i32;
    }
    Some(Rect {
        x: x.max(wa.position.x),
        y: y.max(wa.position.y),
        w,
        h,
    })
}

fn cascade_rect(app: &AppHandle, w: u32, h: u32) -> Rect {
    let n = with_registry(app, |r| r.open_count()) as i32;
    let (x, y) = centered_on_primary(app, w, h);
    let step = 24 * (n % 12);
    Rect {
        x: x + step,
        y: y + step,
        w,
        h,
    }
}

// ---------------------------------------------------------------------------------------------
// Note windows
// ---------------------------------------------------------------------------------------------

fn build_note_window(
    app: &AppHandle,
    label: &str,
    url: &str,
    color: NoteColor,
) -> tauri::Result<WebviewWindow> {
    let s = ui_scale(app);
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("便笺 · bianfa")
        .inner_size(NOTE_DEFAULT.0 * s, NOTE_DEFAULT.1 * s)
        .min_inner_size(NOTE_MIN.0 * s, NOTE_MIN.1 * s)
        .max_inner_size(NOTE_MAX.0 * s, NOTE_MAX.1 * s)
        .decorations(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .shadow(true)
        .accept_first_mouse(true)
        // Windows note windows are opaque (ClearType, 05 §2.2 red line); macOS uses CSS corners.
        .transparent(cfg!(target_os = "macos"))
        .background_color(paper_color(app, color))
        .build()
}

pub fn note_url(note_id: &str, fresh: bool, color: Option<NoteColor>) -> String {
    let mut url = format!("note.html?id={note_id}");
    if fresh {
        url.push_str("&fresh=1");
    }
    if let Some(c) = color {
        url.push_str("&color=");
        url.push_str(c.as_str());
    }
    url
}

#[derive(Default, Clone)]
pub struct OpenOpts {
    pub focus: bool,
    pub fresh: bool,
    pub at_cursor: bool,
    pub color: Option<NoteColor>,
}

/// Opens (or focuses) the window for `note_id`. Uses the prewarmed window when available,
/// restores geometry/z-mode/collapse from `note_window_state`, marks `is_open = 1`.
pub fn open_note(app: &AppHandle, note_id: &str, opts: OpenOpts) -> IpcResult<String> {
    if let Some(win) = note_window(app, note_id) {
        let _ = win.show();
        if opts.focus {
            let _ = win.set_focus();
        }
        with_registry(app, |r| {
            r.hidden_labels.remove(win.label());
        });
        return Ok(win.label().to_string());
    }
    let open_count = with_registry(app, |r| r.open_count());
    if open_count >= VISIBLE_HARD_CAP {
        return Err(IpcError::invalid(format!(
            "too many open notes ({VISIBLE_HARD_CAP}); use the list instead"
        )));
    }

    let state = app.state::<AppState>();
    let saved: Option<WindowState> = if opts.fresh {
        None
    } else {
        state.with_db(|c| window_state::get(c, note_id))?
    };
    let color = opts
        .color
        .or_else(|| {
            state
                .with_db(|c| notes::get(c, note_id))
                .ok()
                .map(|n| n.item.color)
        })
        .unwrap_or_default();
    let url = note_url(note_id, opts.fresh, opts.color);

    // Take the prewarmed window or build a fresh one.
    let pooled = with_registry(app, |r| r.pool.take());
    let win = match pooled.and_then(|l| app.get_webview_window(&l)) {
        Some(w) => {
            // Same origin as the pool page (dev server or tauri://localhost), new query.
            let base = w.url()?;
            w.navigate(base.join(&url)?)?;
            let _ = w.set_background_color(Some(paper_color(app, color)));
            w
        }
        None => {
            let label = format!("note-{note_id}");
            build_note_window(app, &label, &url, color)?
        }
    };
    let label = win.label().to_string();
    with_registry(app, |r| {
        r.by_note.insert(note_id.to_string(), label.clone());
        r.by_label.insert(label.clone(), note_id.to_string());
        r.colors.insert(label.clone(), color);
        if opts.focus {
            r.pending_focus.insert(label.clone());
        }
        if saved.as_ref().map(|s| s.collapsed).unwrap_or(false) {
            r.collapsed.insert(label.clone());
        } else {
            r.collapsed.remove(&label);
        }
    });

    // Geometry.
    let scale = win.scale_factor().unwrap_or(1.0);
    let s = ui_scale(app);
    let default_w = (NOTE_DEFAULT.0 * s * scale) as u32;
    let default_h = (NOTE_DEFAULT.1 * s * scale) as u32;
    let rect = match saved.as_ref() {
        Some(st) if st.x.is_some() && st.y.is_some() && st.w.is_some() && st.h.is_some() => {
            sanitize_rect(
                app,
                Rect {
                    x: st.x.unwrap_or(0) as i32,
                    y: st.y.unwrap_or(0) as i32,
                    w: (st.w.unwrap_or(default_w as i64) as u32).max(1),
                    h: (st.h.unwrap_or(default_h as i64) as u32).max(1),
                },
            )
        }
        _ => {
            if opts.at_cursor {
                rect_at_cursor(app, default_w, default_h)
                    .unwrap_or_else(|| cascade_rect(app, default_w, default_h))
            } else {
                cascade_rect(app, default_w, default_h)
            }
        }
    };
    let _ = win.set_position(PhysicalPosition::new(rect.x, rect.y));
    apply_note_constraints(app, &win);
    let collapsed = saved.as_ref().map(|s| s.collapsed).unwrap_or(false);
    if collapsed {
        let bar = (NOTE_TITLEBAR_H * s * scale) as u32;
        let _ = win.set_size(PhysicalSize::new(rect.w, bar.max(1)));
    } else {
        let _ = win.set_size(PhysicalSize::new(rect.w, rect.h));
    }
    let z = saved.as_ref().map(|s| s.z_mode).unwrap_or(0);
    if z != 0 {
        if let Err(e) = pin::apply(app, &win, z) {
            log::warn!("apply z-mode {z} failed: {e}");
        }
    }

    // Persist is_open = 1 (fresh notes get their row once JS calls note_create).
    if !opts.fresh {
        let _ = events::mutate(
            app,
            "local",
            &["note_window_state"],
            vec![note_id.to_string()],
            |tx| window_state::set_is_open(tx, note_id, true),
        );
    }
    // The window shows itself on PageLoadEvent::Finished (see on_page_load); a freshly created
    // window that already loaded (pool navigate is async too) is covered by that hook.
    schedule_prewarm(app);
    Ok(label)
}

/// `note_new`: allocate an id and open `note.html?id=<id>&fresh=1`; JS creates the doc.
pub fn new_note(app: &AppHandle, at_cursor: bool, color: Option<NoteColor>) -> IpcResult<String> {
    let id = crate::util::uuid_v7();
    open_note(
        app,
        &id,
        OpenOpts {
            focus: true,
            fresh: true,
            at_cursor,
            color,
        },
    )?;
    Ok(id)
}

pub fn close_note(app: &AppHandle, note_id: &str) -> IpcResult<()> {
    let state = app.state::<AppState>();
    if state.with_db(|c| notes::exists(c, note_id))? {
        events::mutate(
            app,
            "local",
            &["note_window_state"],
            vec![note_id.to_string()],
            |tx| window_state::set_is_open(tx, note_id, false),
        )?;
    }
    if let Some(win) = note_window(app, note_id) {
        save_window_geometry(app, win.label());
        win.close()?;
    }
    Ok(())
}

pub fn set_z_mode(app: &AppHandle, note_id: &str, z_mode: i64) -> IpcResult<()> {
    if !(0..=2).contains(&z_mode) {
        return Err(IpcError::invalid("zMode must be 0, 1 or 2"));
    }
    events::mutate(
        app,
        "local",
        &["note_window_state", "notes"],
        vec![note_id.to_string()],
        |tx| {
            window_state::set_z_mode(tx, note_id, z_mode)?;
            notes::set_z_mode(tx, note_id, z_mode)
        },
    )?;
    if let Some(win) = note_window(app, note_id) {
        pin::apply(app, &win, z_mode)?;
    }
    Ok(())
}

pub fn set_collapsed(app: &AppHandle, note_id: &str, collapsed: bool) -> IpcResult<()> {
    let win = require_note_window(app, note_id)?;
    let scale = win.scale_factor().unwrap_or(1.0);
    let s = ui_scale(app);
    let size = win.inner_size()?;
    let saved = app
        .state::<AppState>()
        .with_db(|c| window_state::get(c, note_id))?;
    with_registry(app, |r| {
        if collapsed {
            r.collapsed.insert(win.label().to_string());
        } else {
            r.collapsed.remove(win.label());
        }
    });
    if collapsed {
        // Remember the expanded height before shrinking to the title bar.
        let _ = events::mutate(
            app,
            "local",
            &["note_window_state"],
            vec![note_id.to_string()],
            |tx| {
                if let Ok(pos) = win.outer_position() {
                    window_state::save_geometry(
                        tx,
                        note_id,
                        &window_state::Geometry {
                            x: pos.x as i64,
                            y: pos.y as i64,
                            w: size.width as i64,
                            h: size.height as i64,
                            monitor_key: None,
                            scale: Some(scale),
                        },
                    )?;
                }
                window_state::set_collapsed(tx, note_id, true)
            },
        );
        let bar = (NOTE_TITLEBAR_H * s * scale) as u32;
        let _ = win.set_min_size(Some(LogicalSize::new(NOTE_MIN.0 * s, NOTE_TITLEBAR_H * s)));
        win.set_size(PhysicalSize::new(size.width, bar.max(1)))?;
    } else {
        events::mutate(
            app,
            "local",
            &["note_window_state"],
            vec![note_id.to_string()],
            |tx| window_state::set_collapsed(tx, note_id, false),
        )?;
        let h = saved
            .and_then(|st| st.h)
            .map(|h| h as u32)
            .unwrap_or((NOTE_DEFAULT.1 * s * scale) as u32);
        apply_note_constraints(app, &win);
        win.set_size(PhysicalSize::new(size.width, h.max(1)))?;
    }
    Ok(())
}

pub fn set_color(app: &AppHandle, note_id: &str, color: NoteColor) -> IpcResult<()> {
    let win = require_note_window(app, note_id)?;
    with_registry(app, |r| {
        r.colors.insert(win.label().to_string(), color);
    });
    win.set_background_color(Some(paper_color(app, color)))?;
    Ok(())
}

pub fn repaint_note_backgrounds(app: &AppHandle, dark: bool) {
    let entries: Vec<(String, NoteColor)> = with_registry(app, |r| {
        r.colors.iter().map(|(l, c)| (l.clone(), *c)).collect()
    });
    for (label, color) in entries {
        if let Some(w) = app.get_webview_window(&label) {
            let (r, g, b) = color.paper_rgb(dark);
            let _ = w.set_background_color(Some(Color(r, g, b, 255)));
        }
    }
    let dark_theme = if dark {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    };
    let _ = dark_theme;
}

/// Reads the live geometry and stores it (physical px + monitor key + scale).
pub fn save_window_geometry(app: &AppHandle, label: &str) {
    let Some(note_id) = note_id_for(app, label) else {
        return;
    };
    let Some(win) = app.get_webview_window(label) else {
        return;
    };
    let (Ok(pos), Ok(size), Ok(scale)) =
        (win.outer_position(), win.inner_size(), win.scale_factor())
    else {
        return;
    };
    if size.width == 0 || size.height == 0 {
        return;
    }
    let collapsed = with_registry(app, |r| r.collapsed.contains(label));
    let mkey = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| monitor_key(&m));
    let state = app.state::<AppState>();
    let known = state
        .with_db(|c| notes::exists(c, &note_id))
        .unwrap_or(false);
    if !known {
        return; // fresh note that was never created
    }
    let prev_h = if collapsed {
        state
            .with_db(|c| window_state::get(c, &note_id))
            .ok()
            .flatten()
            .and_then(|s| s.h)
    } else {
        None
    };
    let g = window_state::Geometry {
        x: pos.x as i64,
        y: pos.y as i64,
        w: size.width as i64,
        h: prev_h.unwrap_or(size.height as i64),
        monitor_key: mkey,
        scale: Some(scale),
    };
    let _ = state.with_tx(|tx| window_state::save_geometry(tx, &note_id, &g));
}

pub fn show_all(app: &AppHandle) -> IpcResult<()> {
    let (labels, hidden_since) = with_registry(app, |r| {
        r.hidden_since = None;
        r.hidden_labels.clear();
        (r.labels(), r.hidden_since)
    });
    let _ = hidden_since;
    for l in labels {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.show();
        }
    }
    // Re-open notes that were auto-closed after the 10-minute hide window.
    let ids = app
        .state::<AppState>()
        .with_db(|c| window_state::open_note_ids(c, VISIBLE_HARD_CAP as i64))?;
    for id in ids {
        if note_window(app, &id).is_none() {
            let _ = open_note(app, &id, OpenOpts::default());
        }
    }
    Ok(())
}

pub fn hide_all(app: &AppHandle) -> IpcResult<()> {
    let labels = with_registry(app, |r| {
        r.hidden_since = Some(Instant::now());
        r.labels()
    });
    for l in labels {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.hide();
            with_registry(app, |r| {
                r.hidden_labels.insert(l.clone());
            });
        }
    }
    Ok(())
}

/// Hidden-for-10-minutes → `close()` (05 §2.3; keeps `is_open = 1` so Show All restores them).
pub fn hidden_tick(app: &AppHandle) {
    let expired = with_registry(
        app,
        |r| matches!(r.hidden_since, Some(t) if t.elapsed() >= HIDE_AUTO_CLOSE),
    );
    if !expired {
        return;
    }
    let labels = with_registry(app, |r| {
        r.hidden_since = None;
        r.hidden_labels.drain().collect::<Vec<_>>()
    });
    for l in labels {
        if let Some(w) = app.get_webview_window(&l) {
            if w.is_visible().unwrap_or(true) {
                continue;
            }
            save_window_geometry(app, &l);
            let _ = w.close();
        }
    }
}

/// One hidden, pre-created note window so the hotkey path hits ≤200 ms (05 §4.2).
pub fn prewarm(app: &AppHandle) {
    let has = with_registry(app, |r| r.pool.is_some());
    if has {
        return;
    }
    let n = with_registry(app, |r| {
        r.pool_counter += 1;
        r.pool_counter
    });
    let label = format!("note-pool-{n}");
    match build_note_window(app, &label, "note.html?pool=1", NoteColor::Graphite) {
        Ok(_) => with_registry(app, |r| r.pool = Some(label)),
        Err(e) => log::warn!("prewarm failed: {e}"),
    }
}

fn schedule_prewarm(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(600)).await;
        let inner = app.clone();
        let _ = app.run_on_main_thread(move || prewarm(&inner));
    });
}

/// Restores `is_open = 1` notes at launch (hard cap 40, newest first).
pub fn restore_open_notes(app: &AppHandle) -> usize {
    let ids = app
        .state::<AppState>()
        .with_db(|c| window_state::open_note_ids(c, VISIBLE_HARD_CAP as i64))
        .unwrap_or_default();
    let mut n = 0;
    for id in ids {
        match open_note(app, &id, OpenOpts::default()) {
            Ok(_) => n += 1,
            Err(e) => log::warn!("restore {id}: {e}"),
        }
    }
    n
}

/// Deep link / tray: open or focus a note and tell its window.
pub fn focus_note(app: &AppHandle, note_id: &str) -> IpcResult<()> {
    let exists = app
        .state::<AppState>()
        .with_db(|c| notes::exists(c, note_id))?;
    if !exists {
        return Err(IpcError::not_found(format!("note {note_id} not found")));
    }
    let label = open_note(
        app,
        note_id,
        OpenOpts {
            focus: true,
            ..Default::default()
        },
    )?;
    events::emit_to(
        app,
        &label,
        events::NOTE_FOCUS_REQUEST,
        serde_json::json!({ "noteId": note_id }),
    );
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Singleton windows
// ---------------------------------------------------------------------------------------------

fn singleton(
    app: &AppHandle,
    label: &str,
    url: String,
    size: (f64, f64),
    min: Option<(f64, f64)>,
    resizable: bool,
) -> IpcResult<WebviewWindow> {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return Ok(w);
    }
    let s = ui_scale(app);
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title("bianfa")
        .inner_size(size.0 * s, size.1 * s)
        .resizable(resizable)
        .visible(true)
        .center();
    if let Some(m) = min {
        b = b.min_inner_size(m.0 * s, m.1 * s);
    }
    #[cfg(target_os = "macos")]
    {
        b = b
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    Ok(b.build()?)
}

pub fn open_main(app: &AppHandle, section: Option<&str>) -> IpcResult<()> {
    let mut url = "index.html".to_string();
    if let Some(s) = section {
        url.push_str("#/");
        url.push_str(s);
    }
    let w = singleton(app, MAIN, url, MAIN_DEFAULT, Some(MAIN_MIN), true)?;
    if let Some(s) = section {
        events::emit_to(
            app,
            MAIN,
            "main:navigate",
            serde_json::json!({ "section": s }),
        );
    }
    let _ = w.set_focus();
    Ok(())
}

pub fn open_settings(app: &AppHandle, section: Option<&str>) -> IpcResult<()> {
    let mut url = "settings.html".to_string();
    if let Some(s) = section {
        url.push('#');
        url.push_str(s);
    }
    singleton(
        app,
        SETTINGS,
        url,
        SETTINGS_DEFAULT,
        Some(SETTINGS_MIN),
        true,
    )?;
    if let Some(s) = section {
        events::emit_to(
            app,
            SETTINGS,
            "settings:navigate",
            serde_json::json!({ "section": s }),
        );
    }
    Ok(())
}

pub fn open_login(app: &AppHandle) -> IpcResult<()> {
    singleton(
        app,
        LOGIN,
        "settings.html#login".into(),
        LOGIN_SIZE,
        None,
        false,
    )?;
    Ok(())
}

/// Hidden sync host (`sync.html`): the only window that opens WebSockets (03-sync).
pub fn ensure_sync_window(app: &AppHandle) -> IpcResult<()> {
    if app.get_webview_window(SYNC).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, SYNC, WebviewUrl::App("sync.html".into()))
        .title("bianfa sync")
        .inner_size(320.0, 200.0)
        .visible(false)
        .decorations(false)
        .skip_taskbar(true)
        .focused(false)
        .build()?;
    Ok(())
}

pub fn destroy_sync_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(SYNC) {
        let _ = w.destroy();
    }
}

// ---------------------------------------------------------------------------------------------
// Runtime hooks
// ---------------------------------------------------------------------------------------------

pub fn on_page_load(webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    if payload.event() != PageLoadEvent::Finished {
        return;
    }
    let app = webview.app_handle().clone();
    let label = webview.label().to_string();
    if !is_note_label(&label) {
        return;
    }
    let (mapped, focus, hidden) = with_registry(&app, |r| {
        (
            r.by_label.contains_key(&label),
            r.pending_focus.remove(&label),
            r.hidden_since.is_some(),
        )
    });
    if !mapped || hidden {
        return; // pool window or hide-all in effect
    }
    // The page shows itself after its first paint (`getCurrentWindow().show()`); this is only a
    // safety net for a broken page, plus focus routing once the window is actually visible.
    tauri::async_runtime::spawn(async move {
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let Some(w) = app.get_webview_window(&label) else {
                return;
            };
            if w.is_visible().unwrap_or(false) {
                if focus {
                    let _ = w.set_focus();
                }
                return;
            }
        }
        let still_hidden_all = with_registry(&app, |r| r.hidden_since.is_some());
        if still_hidden_all {
            return;
        }
        if let Some(w) = app.get_webview_window(&label) {
            log::warn!("{label} never showed itself; forcing show()");
            let _ = w.show();
            if focus {
                let _ = w.set_focus();
            }
        }
    });
}

pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    match event {
        WindowEvent::CloseRequested { .. } => {
            if is_note_label(&label) {
                save_window_geometry(&app, &label);
            }
        }
        WindowEvent::Destroyed => {
            if is_note_label(&label) {
                pin::forget(&app, &label);
                let was_pool = with_registry(&app, |r| {
                    if let Some(id) = r.by_label.remove(&label) {
                        r.by_note.remove(&id);
                    }
                    r.colors.remove(&label);
                    r.collapsed.remove(&label);
                    r.pending_focus.remove(&label);
                    r.hidden_labels.remove(&label);
                    if r.pool.as_deref() == Some(label.as_str()) {
                        r.pool = None;
                        true
                    } else {
                        false
                    }
                });
                if was_pool {
                    schedule_prewarm(&app);
                }
                super::tray::refresh(&app);
            }
        }
        WindowEvent::Focused(focused) => {
            if is_note_label(&label) {
                pin::on_focus(&app, &label, *focused);
            }
        }
        WindowEvent::ScaleFactorChanged { .. } => {
            if is_note_label(&label) {
                if let Some(w) = app.get_webview_window(&label) {
                    apply_note_constraints(&app, &w);
                }
                save_window_geometry(&app, &label);
            }
        }
        WindowEvent::ThemeChanged(_) => {
            let follow_system = app.state::<AppState>().settings().theme == "system";
            if follow_system {
                super::theme::debounced_on_changed(&app);
            }
        }
        _ => {}
    }
}
