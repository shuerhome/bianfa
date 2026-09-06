//! In-app updates (05 §5): custom headers for the rollout worker, hourly checks, tray hint.

use super::state::AppState;
use super::{events, tray};
use crate::error::{IpcError, IpcResult};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

pub async fn check(app: &AppHandle, manual: bool) -> IpcResult<UpdateCheck> {
    let state = app.state::<AppState>();
    if state.network_blocked.load(Ordering::Relaxed) {
        return Ok(UpdateCheck {
            available: false,
            version: None,
            notes: None,
        });
    }
    // updater 公钥仍是占位符（尚未 `tauri signer generate`）→ 功能关闭，静默返回「无更新」，不打日志刷屏
    let pubkey_placeholder = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .is_none_or(|k| k.is_empty() || k.starts_with("REPLACE_"));
    if pubkey_placeholder {
        return Ok(UpdateCheck {
            available: false,
            version: None,
            notes: None,
        });
    }
    let channel = state.settings().channel;
    let updater = app
        .updater_builder()
        .header("X-Bianfa-Install-Id", state.install_id.as_str())?
        .header("X-Bianfa-Channel", channel.as_str())?
        .timeout(Duration::from_secs(30))
        .build()?;
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let notes = update.body.clone();
            if let Ok(mut g) = state.pending_update.lock() {
                *g = Some(update);
            }
            events::emit(
                app,
                events::UPDATE_AVAILABLE,
                serde_json::json!({ "version": version, "notes": notes }),
            );
            tray::refresh(app);
            Ok(UpdateCheck {
                available: true,
                version: Some(version),
                notes,
            })
        }
        // 204 / up-to-date / not in rollout all come back as `None`: stay silent.
        Ok(None) => Ok(UpdateCheck {
            available: false,
            version: None,
            notes: None,
        }),
        Err(e) => {
            if manual {
                Err(IpcError::network(format!("update check failed: {e}")))
            } else {
                log::warn!("background update check: {e}");
                Ok(UpdateCheck {
                    available: false,
                    version: None,
                    notes: None,
                })
            }
        }
    }
}

/// Downloads + installs the pending update, then restarts (Windows passive mode exits the app).
pub async fn install(app: &AppHandle) -> IpcResult<()> {
    let state = app.state::<AppState>();
    let pending = state.pending_update.lock().ok().and_then(|g| g.clone());
    let update = match pending {
        Some(u) => u,
        None => match check(app, true).await? {
            UpdateCheck {
                available: true, ..
            } => state
                .pending_update
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .ok_or_else(|| IpcError::not_found("no update available"))?,
            _ => return Err(IpcError::not_found("no update available")),
        },
    };
    super::shutdown(app);
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await?;
    app.restart();
}

/// First check 30 s after launch (off the cold-start path), then hourly.
pub fn schedule(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            let _ = check(&app, false).await;
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });
}
