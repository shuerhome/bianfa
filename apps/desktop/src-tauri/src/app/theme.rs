//! System / effective theme (05 §2.5). Rust re-paints note backgrounds and emits one
//! `theme-changed` per switch.

use super::events;
use super::state::AppState;
use tauri::{AppHandle, Manager, Theme};

pub fn system_theme(app: &AppHandle) -> Theme {
    for (_, w) in app.webview_windows() {
        if let Ok(t) = w.theme() {
            return t;
        }
    }
    Theme::Light
}

pub fn theme_name(t: Theme) -> &'static str {
    match t {
        Theme::Dark => "dark",
        _ => "light",
    }
}

pub fn effective(app: &AppHandle) -> Theme {
    let s = app.state::<AppState>().settings();
    match s.theme.as_str() {
        "dark" => Theme::Dark,
        "light" => Theme::Light,
        _ => system_theme(app),
    }
}

pub fn is_dark(app: &AppHandle) -> bool {
    matches!(effective(app), Theme::Dark)
}

/// Applies the preference (`system`/`light`/`dark`) to all windows and re-paints note papers.
pub fn apply(app: &AppHandle) {
    let s = app.state::<AppState>().settings();
    let forced = match s.theme.as_str() {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None,
    };
    app.set_theme(forced);
    on_changed(app);
}

/// Called after the OS theme flips (WindowEvent::ThemeChanged) or the preference changes.
pub fn on_changed(app: &AppHandle) {
    let eff = effective(app);
    super::windows::repaint_note_backgrounds(app, matches!(eff, Theme::Dark));
    events::emit(
        app,
        events::THEME_CHANGED,
        serde_json::json!({ "effective": theme_name(eff) }),
    );
}

static LAST_THEME_EMIT: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// Every window reports `ThemeChanged`; collapse the burst into one repaint + one event.
pub fn debounced_on_changed(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    let now = crate::util::now_ms();
    let last = LAST_THEME_EMIT.load(Ordering::Relaxed);
    if now - last < 200 {
        return;
    }
    LAST_THEME_EMIT.store(now, Ordering::Relaxed);
    on_changed(app);
}
