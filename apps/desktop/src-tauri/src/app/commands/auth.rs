//! 07 §2.4 account + network. No command ever returns a token.

use crate::app::auth;
use crate::app::state::AppState;
use crate::error::IpcResult;
use crate::model::{ApiResponse, AuthStatus};
use tauri::{AppHandle, State};

#[tauri::command]
pub fn auth_status(state: State<'_, AppState>) -> IpcResult<AuthStatus> {
    Ok(state.auth.status())
}

#[tauri::command]
pub fn auth_login_start(app: AppHandle) -> IpcResult<auth::LoginStart> {
    auth::login_start(&app)
}

#[tauri::command]
pub async fn auth_login_device_start(app: AppHandle) -> IpcResult<auth::DeviceStart> {
    auth::login_device_start(&app).await
}

#[tauri::command]
pub fn auth_login_cancel(app: AppHandle) -> IpcResult<()> {
    auth::login_cancel(&app);
    Ok(())
}

#[tauri::command]
pub async fn auth_logout(app: AppHandle, wipe_local: Option<bool>) -> IpcResult<()> {
    auth::logout(&app).await?;
    if wipe_local.unwrap_or(false) {
        crate::app::wipe_local(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn auth_sync_token(app: AppHandle) -> IpcResult<auth::SyncToken> {
    auth::sync_token(&app).await
}

#[tauri::command]
pub async fn api_request(
    app: AppHandle,
    method: String,
    path: String,
    json_body: Option<serde_json::Value>,
    timeout_ms: Option<u64>,
) -> IpcResult<ApiResponse> {
    auth::api_request(&app, &method, &path, json_body, timeout_ms).await
}
