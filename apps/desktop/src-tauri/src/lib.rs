//! bianfa desktop shell.
//!
//! Module map (see README.md):
//! - `error`, `model`, `util`, `colors` — IPC types shared by every command.
//! - `db` — SQLCipher store (schema, notes, window state, versions, sync state, attachments).
//! - `import` — Windows Sticky Notes parsers (`plum.sqlite`, `.snt`).
//! - `app` (feature `app`) — the Tauri runtime: windows, tray, hotkey, auth, updater, protocol.
//!
//! The `app` feature is on by default; host unit tests on Linux use `--no-default-features`.

pub mod colors;
pub mod db;
pub mod error;
pub mod import;
pub mod model;
pub mod util;

#[cfg(feature = "app")]
pub mod app;

#[cfg(feature = "app")]
pub use app::run;
