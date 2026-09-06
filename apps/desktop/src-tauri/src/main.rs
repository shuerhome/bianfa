// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "app")]
fn main() {
    bianfa_desktop_lib::run();
}

#[cfg(not(feature = "app"))]
fn main() {
    eprintln!("bianfa-desktop was built without the `app` feature (tests-only build).");
}
