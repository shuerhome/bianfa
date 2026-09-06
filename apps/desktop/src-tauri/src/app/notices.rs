//! Kill-switch / service notices (`GET /v1/notice`, 04 §7.8, 05 §5.3). Signed with a second,
//! independent Ed25519 key compiled into the binary; a placeholder key disables verification
//! and the feature (returns `null`).

use super::state::AppState;
use super::{events, settings};
use crate::error::IpcResult;
use crate::model::Notice;
use crate::util::{b64_decode, b64url_decode};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Base64 (32 bytes) Ed25519 public key. Placeholder ⇒ notices are ignored entirely.
pub const NOTICE_PUBKEY_B64: &str = "<REPLACE_ME:notice-pubkey>";

fn verify(payload: &[u8], sig: &[u8]) -> bool {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let Ok(key_bytes) = b64_decode(NOTICE_PUBKEY_B64) else {
        return false;
    };
    let Ok(key_arr) = <[u8; 32]>::try_from(key_bytes.as_slice()) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&key_arr) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(sig) else {
        return false;
    };
    key.verify(payload, &sig).is_ok()
}

fn version_affected(range: Option<&str>, current: &str) -> bool {
    let Some(range) = range.filter(|r| !r.trim().is_empty() && r.trim() != "*") else {
        return true;
    };
    match (semver::VersionReq::parse(range), semver::Version::parse(current)) {
        (Ok(req), Ok(v)) => req.matches(&v),
        _ => false,
    }
}

fn platform_affected(platforms: &[String]) -> bool {
    if platforms.is_empty() {
        return true;
    }
    let os = std::env::consts::OS;
    platforms.iter().any(|p| {
        let p = p.to_ascii_lowercase();
        p == os || (p == "darwin" && os == "macos") || p == "all"
    })
}

/// Fetches, verifies and filters the notice. Network failures fail open (return `None`).
pub async fn fetch(app: &AppHandle) -> IpcResult<Option<Notice>> {
    if NOTICE_PUBKEY_B64.starts_with('<') {
        return Ok(None);
    }
    let state = app.state::<AppState>();
    let url = format!("{}/v1/notice", state.settings().api_base_url.trim_end_matches('/'));
    let resp = match state.http.get(&url).timeout(Duration::from_secs(15)).send().await {
        Ok(r) => r,
        Err(e) => {
            log::info!("notice fetch failed (fail-open): {e}");
            return Ok(None);
        }
    };
    if resp.status().as_u16() != 200 {
        return Ok(None);
    }
    let v: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let (Some(payload_b64), Some(sig_b64)) = (v["payload"].as_str(), v["sig"].as_str()) else {
        return Ok(None);
    };
    let Ok(payload) = b64url_decode(payload_b64).or_else(|_| b64_decode(payload_b64)) else {
        return Ok(None);
    };
    let Ok(sig) = b64_decode(sig_b64).or_else(|_| b64url_decode(sig_b64)) else {
        return Ok(None);
    };
    if !verify(&payload, &sig) && !verify(payload_b64.as_bytes(), &sig) {
        log::warn!("notice signature invalid; ignored");
        return Ok(None);
    }
    let Ok(notice) = serde_json::from_slice::<Notice>(&payload) else {
        return Ok(None);
    };
    let current = app.package_info().version.to_string();
    if !platform_affected(&notice.platforms) || !version_affected(notice.affected_versions.as_deref(), &current) {
        return Ok(None);
    }
    let acked = state.settings().acked_notice_ids.contains(&notice.id);
    let block = notice.action == "block";
    state.network_blocked.store(block, Ordering::Relaxed);
    if acked && !block {
        return Ok(None);
    }
    if let Ok(mut g) = state.notice.lock() {
        *g = Some(notice.clone());
    }
    events::emit(app, events::NOTICE, notice.clone());
    Ok(Some(notice))
}

pub fn current(app: &AppHandle) -> Option<Notice> {
    app.state::<AppState>().notice.lock().ok().and_then(|g| g.clone())
}

pub fn ack(app: &AppHandle, id: &str) -> IpcResult<()> {
    let state = app.state::<AppState>();
    let mut s = state.settings();
    if !s.acked_notice_ids.iter().any(|x| x == id) {
        s.acked_notice_ids.push(id.to_string());
        settings::save(&state.paths, &s)?;
        state.set_settings(s);
    }
    if let Ok(mut g) = state.notice.lock() {
        if g.as_ref().map(|n| n.id == id && n.action != "block").unwrap_or(false) {
            *g = None;
        }
    }
    Ok(())
}

/// Startup + every 6 h.
pub fn schedule(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let _ = fetch(&app).await;
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}
