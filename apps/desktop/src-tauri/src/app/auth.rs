//! Desktop login (04 §2): loopback + PKCE as the main path, device authorization as the
//! fallback, refresh with a single-flight lock, and the `api_request` proxy. Tokens never reach
//! the WebView: the refresh token lives in the keyring, the access token only in memory.
//!
//! Every grant (authorization_code / device_code / refresh_token) is redeemed at
//! `POST /api/auth/oauth2/token` with the extra `device_id / device_name / platform /
//! app_version` fields; the server answers 403 `device_limit_reached` on the Free plan's
//! device cap. After any token issuance: `POST /v1/claim` (idempotent) → `GET /v1/me`.

use super::events;
use super::keys::{self, SecretStore};
use super::state::AppState;
use super::windows;
use crate::api::{
    self, ClaimResponse, DeviceCodeResponse, MeResponse, OAuthError, SyncTokenResponse,
    TokenResponse,
};
use crate::error::{IpcError, IpcResult};
use crate::model::{ApiResponse, AuthStatus, AuthUser};
use crate::util::{b64url_encode, now_ms, random_bytes};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

pub use crate::api::paths;
pub use crate::api::{CLIENT_ID, SCOPE};

/// Error code surfaced to the WebView when the Free plan's device cap is hit.
pub const DEVICE_LIMIT_CODE: &str = "device_limit_reached";
/// 20 s "copy link", 60 s device-code hint, 120 s hard timeout (04 §2.2 ruling).
pub const LOGIN_HINT_AFTER: Duration = Duration::from_secs(20);
pub const LOGIN_FALLBACK_AFTER: Duration = Duration::from_secs(60);
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
struct Inner {
    access_token: Option<String>,
    access_expires_at: i64,
    logged_in: bool,
    user: Option<AuthUser>,
    personal_workspace_id: Option<String>,
    active_organization_id: Option<String>,
    plan: Option<String>,
}

pub struct AuthState {
    inner: RwLock<Inner>,
    device_id: String,
    refresh_lock: tokio::sync::Mutex<()>,
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

/// `profile.json`: the last `/v1/me` snapshot (no tokens) so the UI has a name before the
/// startup refresh completes, plus whether `/v1/claim` already ran for this account.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Profile {
    user: Option<AuthUser>,
    personal_workspace_id: Option<String>,
    active_organization_id: Option<String>,
    plan: Option<String>,
    /// `local_user_id` (= install id) that was claimed, and for which server user.
    claimed_local_user_id: Option<String>,
    claimed_user_id: Option<String>,
}

impl AuthState {
    pub fn new(device_id: String) -> Self {
        Self {
            inner: RwLock::new(Inner::default()),
            device_id,
            refresh_lock: tokio::sync::Mutex::new(()),
            cancel: Mutex::new(None),
        }
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn status(&self) -> AuthStatus {
        let g = self.inner.read().unwrap_or_else(|p| p.into_inner());
        AuthStatus {
            logged_in: g.logged_in,
            user: g.user.clone(),
            device_id: self.device_id.clone(),
            personal_workspace_id: g.personal_workspace_id.clone(),
            active_organization_id: g.active_organization_id.clone(),
            plan: g.plan.clone(),
        }
    }

    fn write(&self, f: impl FnOnce(&mut Inner)) {
        let mut g = self.inner.write().unwrap_or_else(|p| p.into_inner());
        f(&mut g);
    }

    fn access_token_if_fresh(&self) -> Option<String> {
        let g = self.inner.read().unwrap_or_else(|p| p.into_inner());
        match &g.access_token {
            Some(t) if g.access_expires_at - 30_000 > now_ms() => Some(t.clone()),
            _ => None,
        }
    }

    fn take_cancel(&self) -> Option<Arc<AtomicBool>> {
        self.cancel.lock().ok().and_then(|mut g| g.take())
    }

    fn set_cancel(&self, flag: Arc<AtomicBool>) {
        if let Ok(mut g) = self.cancel.lock() {
            if let Some(old) = g.replace(flag) {
                old.store(true, Ordering::SeqCst);
            }
        }
    }
}

fn api_base(app: &AppHandle) -> String {
    app.state::<AppState>()
        .settings()
        .api_base_url
        .trim_end_matches('/')
        .to_string()
}

fn profile_path(app: &AppHandle) -> std::path::PathBuf {
    app.state::<AppState>().paths.profile_file.clone()
}

fn load_profile(app: &AppHandle) -> Profile {
    std::fs::read_to_string(profile_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_profile(app: &AppHandle, p: &Profile) {
    if let Ok(s) = serde_json::to_string(p) {
        let _ = std::fs::write(profile_path(app), s);
    }
}

/// Startup: a stored refresh token means "logged in"; refresh + `/v1/me` run in the background.
pub fn init(app: &AppHandle) {
    let state = app.state::<AppState>();
    let has_refresh = state
        .secrets
        .get(keys::REFRESH_TOKEN)
        .ok()
        .flatten()
        .is_some();
    let profile = load_profile(app);
    state.auth.write(|i| {
        i.logged_in = has_refresh;
        i.user = profile.user.clone();
        i.personal_workspace_id = profile.personal_workspace_id.clone();
        i.active_organization_id = profile.active_organization_id.clone();
        i.plan = profile.plan.clone();
    });
    if has_refresh {
        let _ = windows::ensure_sync_window(app);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            match ensure_access_token(&app).await {
                Ok(Some(_)) => {
                    if let Err(e) = claim_and_fetch_me(&app).await {
                        log::warn!("startup profile refresh failed: {e}");
                    }
                    events::emit(
                        &app,
                        events::AUTH_CHANGED,
                        app.state::<AppState>().auth.status(),
                    );
                }
                Ok(None) => {}
                Err(e) => log::warn!("startup token refresh failed: {e}"),
            }
        });
    }
}

fn device_fields(app: &AppHandle) -> Vec<(&'static str, String)> {
    let state = app.state::<AppState>();
    vec![
        ("device_id", state.auth.device_id().to_string()),
        ("device_name", device_name()),
        (
            "platform",
            api::platform_name(std::env::consts::OS).to_string(),
        ),
        ("app_version", app.package_info().version.to_string()),
    ]
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "bianfa desktop".into())
}

async fn store_tokens(app: &AppHandle, tokens: TokenResponse) -> IpcResult<()> {
    let state = app.state::<AppState>();
    if let Some(rt) = &tokens.refresh_token {
        state.secrets.set(keys::REFRESH_TOKEN, rt)?;
    }
    let ttl = tokens.expires_in.unwrap_or(900).max(30) * 1000;
    state.auth.write(|i| {
        i.access_token = Some(tokens.access_token.clone());
        i.access_expires_at = now_ms() + ttl;
        i.logged_in = true;
    });
    Ok(())
}

/// Refreshes once at a time; concurrent callers wait and reuse the result.
pub async fn ensure_access_token(app: &AppHandle) -> IpcResult<Option<String>> {
    let state = app.state::<AppState>();
    if let Some(t) = state.auth.access_token_if_fresh() {
        return Ok(Some(t));
    }
    let _guard = state.auth.refresh_lock.lock().await;
    if let Some(t) = state.auth.access_token_if_fresh() {
        return Ok(Some(t));
    }
    let Some(refresh) = state.secrets.get(keys::REFRESH_TOKEN)? else {
        return Ok(None);
    };
    let mut form: Vec<(&str, String)> = vec![
        ("grant_type", "refresh_token".into()),
        ("refresh_token", refresh),
        ("client_id", CLIENT_ID.into()),
    ];
    form.extend(device_fields(app));
    match token_request(app, &form).await? {
        Ok(tokens) => {
            let access = tokens.access_token.clone();
            store_tokens(app, tokens).await?;
            Ok(Some(access))
        }
        Err((status, err)) if status == 400 && err.is("invalid_grant") => {
            // Refresh family is dead: drop the credential, keep local data untouched (04 §2.4).
            log::warn!("refresh token rejected (invalid_grant); local mode until next login");
            state.secrets.delete(keys::REFRESH_TOKEN)?;
            state.auth.write(|i| {
                i.access_token = None;
                i.logged_in = false;
            });
            events::emit(app, events::AUTH_CHANGED, state.auth.status());
            Err(IpcError::auth(
                "会话已过期，请重新登录 · session expired; please sign in again",
            ))
        }
        Err((status, err)) => Err(IpcError::auth(format!(
            "token refresh failed ({status}): {}",
            err.error_description.unwrap_or(err.error)
        ))),
    }
}

/// One `POST /api/auth/oauth2/token` (form-encoded, like the server tests). `Ok(Err(..))` is
/// an OAuth-level failure the caller interprets; `Err` is transport / parse failure.
async fn token_request(
    app: &AppHandle,
    form: &[(&str, String)],
) -> IpcResult<Result<TokenResponse, (u16, OAuthError)>> {
    let state = app.state::<AppState>();
    let resp = state
        .http
        .post(format!("{}{}", api_base(app), paths::TOKEN))
        .form(form)
        .timeout(Duration::from_secs(30))
        .send()
        .await?;
    let status = resp.status().as_u16();
    let text = resp.text().await?;
    if (200..300).contains(&status) {
        return Ok(Ok(serde_json::from_str(&text)?));
    }
    Ok(Err((status, OAuthError::parse(&text))))
}

/// Maps a rejected code / device-code exchange to the error the login UI shows.
fn login_failure(status: u16, err: &OAuthError) -> IpcError {
    let message = err.message(status);
    if err.is(DEVICE_LIMIT_CODE) {
        IpcError::new(DEVICE_LIMIT_CODE, message)
            .with_details(serde_json::json!({ "limit": err.limit.unwrap_or(2), "status": status }))
    } else {
        IpcError::auth(message)
            .with_details(serde_json::json!({ "error": err.error, "status": status }))
    }
}

/// `POST /v1/claim { local_user_id }` (idempotent; binds this installation's local user id to
/// the account and guarantees the personal workspace). Remembered in `profile.json` so the
/// startup path does not repeat it.
async fn claim(app: &AppHandle) -> IpcResult<ClaimResponse> {
    let install_id = app.state::<AppState>().install_id.clone();
    let r = api_request(
        app,
        "POST",
        paths::CLAIM,
        Some(serde_json::json!({ "local_user_id": install_id })),
        Some(15_000),
        None,
    )
    .await?;
    if r.status != 200 {
        let body = api::ApiErrorBody::parse(&r.body_text);
        return Err(IpcError::new(
            &body.code(r.status),
            format!("/v1/claim returned {}", r.status),
        ));
    }
    let claimed: ClaimResponse = serde_json::from_str(&r.body_text)?;
    app.state::<AppState>().auth.write(|i| {
        i.personal_workspace_id = Some(claimed.personal_workspace_id.clone());
        i.logged_in = true;
    });
    Ok(claimed)
}

/// `GET /v1/me` → `AuthStatus` (+ `profile.json`).
async fn fetch_me(app: &AppHandle) -> IpcResult<MeResponse> {
    let r = api_request(app, "GET", paths::ME, None, Some(15_000), None).await?;
    if r.status != 200 {
        return Err(IpcError::auth(format!("/v1/me returned {}", r.status)));
    }
    let me: MeResponse = serde_json::from_str(&r.body_text)?;
    let state = app.state::<AppState>();
    let status = me.to_status(state.auth.device_id());
    state.auth.write(|i| {
        i.user = status.user.clone();
        i.personal_workspace_id = status.personal_workspace_id.clone();
        i.active_organization_id = status.active_organization_id.clone();
        i.plan = status.plan.clone();
        i.logged_in = true;
    });
    Ok(me)
}

/// claim (once per account) → `/v1/me`; persists the profile snapshot.
async fn claim_and_fetch_me(app: &AppHandle) -> IpcResult<()> {
    let install_id = app.state::<AppState>().install_id.clone();
    let mut profile = load_profile(app);
    let mut claimed_now = false;
    if profile.claimed_local_user_id.as_deref() != Some(install_id.as_str()) {
        match claim(app).await {
            Ok(c) => {
                claimed_now = true;
                log::info!(
                    "claim ok (personal workspace {}, claimed_before={})",
                    c.personal_workspace_id,
                    c.claimed_before
                );
            }
            // `claimed_by_other` (409) is permanent for this install id; everything else is retried
            // on the next login / startup.
            Err(e) if e.code == "claimed_by_other" => {
                log::warn!("local user id already claimed by another account");
                claimed_now = true;
            }
            Err(e) => log::warn!("claim failed (will retry): {e}"),
        }
    }
    let me = fetch_me(app).await?;
    let status = app.state::<AppState>().auth.status();
    let same_user = profile.claimed_user_id.as_deref() == Some(me.user.id.as_str());
    if claimed_now || same_user {
        profile.claimed_local_user_id = Some(install_id);
        profile.claimed_user_id = Some(me.user.id.clone());
    } else {
        profile.claimed_local_user_id = None;
        profile.claimed_user_id = None;
    }
    profile.user = status.user;
    profile.personal_workspace_id = status.personal_workspace_id;
    profile.active_organization_id = status.active_organization_id;
    profile.plan = status.plan;
    save_profile(app, &profile);
    Ok(())
}

async fn finish_login(app: &AppHandle, tokens: TokenResponse) -> IpcResult<()> {
    store_tokens(app, tokens).await?;
    // A different account than last time: forget the old claim marker before claiming.
    let _ = std::fs::remove_file(profile_path(app));
    if let Err(e) = claim_and_fetch_me(app).await {
        log::warn!("claim + /v1/me after login: {e}");
    }
    let state = app.state::<AppState>();
    events::emit(app, events::AUTH_CHANGED, state.auth.status());
    events::login_progress(app, "done", None);
    let _ = windows::ensure_sync_window(app);
    // Bring the app back to the foreground (04 §2.2 step ⑤).
    for label in [windows::LOGIN, windows::SETTINGS, windows::MAIN] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.set_focus();
            break;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Loopback + PKCE
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    pub auth_url: String,
    pub state: String,
}

const CALLBACK_HTML_OK: &str = "<!doctype html><meta charset=utf-8><title>bianfa</title><body style=\"font:16px system-ui;padding:48px;text-align:center\"><h2>✓ 登录成功</h2><p>可以关闭本页了 · You can close this page.</p></body>";
const CALLBACK_HTML_ERR: &str = "<!doctype html><meta charset=utf-8><title>bianfa</title><body style=\"font:16px system-ui;padding:48px;text-align:center\"><h2>登录未完成</h2><p>请回到 bianfa 重试 · Please return to bianfa and try again.</p></body>";

fn http_reply(stream: &mut std::net::TcpStream, status: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

/// Accepts exactly one valid callback (state must match) or stops on cancel/timeout.
fn loopback_serve(
    listener: TcpListener,
    expected_state: String,
    cancel: Arc<AtomicBool>,
    tx: tokio::sync::oneshot::Sender<Result<String, String>>,
) {
    let started = Instant::now();
    let _ = listener.set_nonblocking(true);
    let mut result: Option<Result<String, String>> = None;
    while result.is_none() {
        if cancel.load(Ordering::SeqCst) || started.elapsed() > LOGIN_TIMEOUT {
            break;
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                let mut buf = Vec::with_capacity(2048);
                let mut chunk = [0u8; 1024];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 16 * 1024 {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let head = String::from_utf8_lossy(&buf);
                let path = head
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/");
                let parsed = url::Url::parse(&format!("http://127.0.0.1{path}")).ok();
                let params: HashMap<String, String> = parsed
                    .as_ref()
                    .map(|u| {
                        u.query_pairs()
                            .map(|(k, v)| (k.into_owned(), v.into_owned()))
                            .collect()
                    })
                    .unwrap_or_default();
                let path_ok = parsed.as_ref().map(|u| u.path() == "/cb").unwrap_or(false);
                if !path_ok || params.get("state") != Some(&expected_state) {
                    http_reply(&mut stream, "400 Bad Request", CALLBACK_HTML_ERR);
                    continue; // ignore and keep listening
                }
                if let Some(err) = params.get("error") {
                    http_reply(&mut stream, "200 OK", CALLBACK_HTML_ERR);
                    result = Some(Err(err.clone()));
                } else if let Some(code) = params.get("code") {
                    http_reply(&mut stream, "200 OK", CALLBACK_HTML_OK);
                    result = Some(Ok(code.clone()));
                } else {
                    http_reply(&mut stream, "400 Bad Request", CALLBACK_HTML_ERR);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
    if let Some(r) = result {
        let _ = tx.send(r);
    }
    // Dropping the listener closes the port.
}

pub fn login_start(app: &AppHandle) -> IpcResult<LoginStart> {
    let state = app.state::<AppState>();
    if state.network_blocked.load(Ordering::Relaxed) {
        return Err(IpcError::unsupported(
            "network features are disabled by a service notice",
        ));
    }
    let verifier = b64url_encode(&random_bytes(48));
    let challenge = b64url_encode(&<sha2::Sha256 as sha2::Digest>::digest(verifier.as_bytes()));
    let csrf_state = b64url_encode(&random_bytes(24));
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/cb");
    let mut auth_url = url::Url::parse(&format!("{}{}", api_base(app), paths::AUTHORIZE))?;
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &csrf_state)
        .append_pair("scope", SCOPE);
    let auth_url = auth_url.to_string();

    let cancel = Arc::new(AtomicBool::new(false));
    state.auth.set_cancel(cancel.clone());
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    {
        let st = csrf_state.clone();
        let cancel = cancel.clone();
        std::thread::Builder::new()
            .name("bianfa-loopback".into())
            .spawn(move || loopback_serve(listener, st, cancel, tx))
            .map_err(|e| IpcError::io(e.to_string()))?;
    }
    if let Err(e) = app.opener().open_url(auth_url.clone(), None::<&str>) {
        log::warn!("open browser failed: {e}");
    }
    events::login_progress(app, "waiting", None);

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut rx = rx;
        let stages: [(Duration, &str); 3] = [
            (LOGIN_HINT_AFTER, "timeout-soon"),
            (LOGIN_FALLBACK_AFTER, "device-fallback"),
            (LOGIN_TIMEOUT, "failed"),
        ];
        let started = Instant::now();
        let mut outcome: Option<Result<String, String>> = None;
        for (at, phase) in stages {
            let remaining = at.saturating_sub(started.elapsed());
            match tokio::time::timeout(remaining, &mut rx).await {
                Ok(Ok(r)) => {
                    outcome = Some(r);
                    break;
                }
                Ok(Err(_)) => {
                    outcome = Some(Err("cancelled".into()));
                    break;
                }
                Err(_) => {
                    if cancel.load(Ordering::SeqCst) {
                        outcome = Some(Err("cancelled".into()));
                        break;
                    }
                    events::login_progress(&app2, phase, None);
                }
            }
        }
        cancel.store(true, Ordering::SeqCst);
        match outcome {
            Some(Ok(code)) => {
                let mut form: Vec<(&str, String)> = vec![
                    ("grant_type", "authorization_code".into()),
                    ("code", code),
                    ("code_verifier", verifier),
                    ("client_id", CLIENT_ID.into()),
                    ("redirect_uri", redirect_uri),
                ];
                form.extend(device_fields(&app2));
                let res: IpcResult<()> = async {
                    match token_request(&app2, &form).await? {
                        Ok(tokens) => finish_login(&app2, tokens).await,
                        Err((status, err)) => Err(login_failure(status, &err)),
                    }
                }
                .await;
                if let Err(e) = res {
                    log::warn!("login failed: {e}");
                    events::login_progress(&app2, "failed", Some(e.message));
                }
            }
            Some(Err(e)) if e == "cancelled" => {}
            Some(Err(e)) => events::login_progress(&app2, "failed", Some(e)),
            None => {}
        }
    });
    Ok(LoginStart {
        auth_url,
        state: csrf_state,
    })
}

// ---------------------------------------------------------------------------------------------
// Device authorization grant
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub user_code: String,
    pub verification_url: String,
    pub expires_in: i64,
}

pub async fn login_device_start(app: &AppHandle) -> IpcResult<DeviceStart> {
    let state = app.state::<AppState>();
    if state.network_blocked.load(Ordering::Relaxed) {
        return Err(IpcError::unsupported(
            "network features are disabled by a service notice",
        ));
    }
    let resp = state
        .http
        .post(format!("{}{}", api_base(app), paths::DEVICE_CODE))
        .json(&serde_json::json!({ "client_id": CLIENT_ID, "scope": SCOPE }))
        .timeout(Duration::from_secs(30))
        .send()
        .await?;
    let status = resp.status().as_u16();
    let text = resp.text().await?;
    if !(200..300).contains(&status) {
        let err = OAuthError::parse(&text);
        return Err(IpcError::auth(format!(
            "device code request failed ({status}): {}",
            err.error_description.unwrap_or(err.error)
        )));
    }
    let dc: DeviceCodeResponse = serde_json::from_str(&text)?;
    let cancel = Arc::new(AtomicBool::new(false));
    state.auth.set_cancel(cancel.clone());
    events::login_progress(app, "waiting", None);

    let app2 = app.clone();
    let device_code = dc.device_code.clone();
    let mut interval = dc.interval.max(1) as u64;
    let expires = Duration::from_secs(dc.expires_in.max(30) as u64);
    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_secs(interval)).await;
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            if started.elapsed() > expires {
                let expired = OAuthError {
                    error: "expired_token".into(),
                    ..OAuthError::default()
                };
                events::login_progress(&app2, "failed", Some(expired.message(400)));
                return;
            }
            // RFC 8628 §3.4: the device code is redeemed at the regular token endpoint.
            let mut form: Vec<(&str, String)> = vec![
                ("grant_type", api::DEVICE_CODE_GRANT.into()),
                ("device_code", device_code.clone()),
                ("client_id", CLIENT_ID.into()),
            ];
            form.extend(device_fields(&app2));
            let outcome = match token_request(&app2, &form).await {
                Ok(o) => o,
                Err(e) => {
                    log::warn!("device poll: {e}");
                    continue;
                }
            };
            match outcome {
                Ok(tokens) => {
                    if let Err(e) = finish_login(&app2, tokens).await {
                        events::login_progress(&app2, "failed", Some(e.message));
                    }
                    return;
                }
                // RFC 8628 §3.5
                Err((_, err)) if err.is("authorization_pending") => {}
                Err((_, err)) if err.is("slow_down") => interval += 5,
                Err((status, err)) => {
                    // expired_token / access_denied / device_limit_reached / anything else
                    let e = login_failure(status, &err);
                    log::warn!("device flow ended: {e}");
                    events::login_progress(&app2, "failed", Some(e.message));
                    return;
                }
            }
        }
    });
    Ok(DeviceStart {
        user_code: dc.user_code,
        verification_url: dc
            .verification_uri_complete
            .or(dc.verification_uri)
            .unwrap_or_else(|| format!("{}/device", api_base(app))),
        expires_in: dc.expires_in,
    })
}

pub fn login_cancel(app: &AppHandle) {
    if let Some(c) = app.state::<AppState>().auth.take_cancel() {
        c.store(true, Ordering::SeqCst);
    }
}

pub async fn logout(app: &AppHandle) -> IpcResult<()> {
    let state = app.state::<AppState>();
    login_cancel(app);
    if let Ok(Some(refresh)) = state.secrets.get(keys::REFRESH_TOKEN) {
        let _ = state
            .http
            .post(format!("{}{}", api_base(app), paths::REVOKE))
            .form(&[
                ("token", refresh.as_str()),
                ("token_type_hint", "refresh_token"),
                ("client_id", CLIENT_ID),
            ])
            .timeout(Duration::from_secs(10))
            .send()
            .await;
    }
    state.secrets.delete(keys::REFRESH_TOKEN)?;
    let _ = std::fs::remove_file(profile_path(app));
    state.auth.write(|i| {
        *i = Inner::default();
    });
    windows::destroy_sync_window(app);
    events::emit(app, events::AUTH_CHANGED, state.auth.status());
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// HTTP proxy
// ---------------------------------------------------------------------------------------------

/// Headers the proxy owns; the WebView may not set or override them via `headers`.
const RESERVED_HEADERS: &[&str] = &[
    "authorization",
    "cookie",
    "host",
    "content-length",
    "content-type",
    "transfer-encoding",
    "connection",
    "x-bianfa-device-id",
    "x-bianfa-app-version",
];

/// Extra request headers from the WebView (e.g. `X-Organization-Id` for `/v1/orgs/:id/**`).
fn extra_headers(
    headers: Option<HashMap<String, String>>,
) -> IpcResult<reqwest::header::HeaderMap> {
    let mut map = reqwest::header::HeaderMap::new();
    for (k, v) in headers.into_iter().flatten() {
        let name = reqwest::header::HeaderName::from_bytes(k.as_bytes())
            .map_err(|_| IpcError::invalid(format!("bad header name: {k}")))?;
        if RESERVED_HEADERS.contains(&name.as_str()) {
            return Err(IpcError::invalid(format!("header not allowed: {k}")));
        }
        let value = reqwest::header::HeaderValue::from_str(&v)
            .map_err(|_| IpcError::invalid(format!("bad header value for {k}")))?;
        map.insert(name, value);
    }
    Ok(map)
}

/// The only HTTP egress for the WebView (07 §2.4): injects `Authorization`, retries once after a
/// 401 with a refreshed token. `path` must start with `/v1/`. `headers` are added verbatim
/// (see `RESERVED_HEADERS` for what is refused).
pub async fn api_request(
    app: &AppHandle,
    method: &str,
    path: &str,
    json_body: Option<serde_json::Value>,
    timeout_ms: Option<u64>,
    headers: Option<HashMap<String, String>>,
) -> IpcResult<ApiResponse> {
    if !path.starts_with("/v1/") {
        return Err(IpcError::invalid("path must start with /v1/"));
    }
    let extra = extra_headers(headers)?;
    let state = app.state::<AppState>();
    if state.network_blocked.load(Ordering::Relaxed) {
        return Err(IpcError::unsupported(
            "network features are disabled by a service notice",
        ));
    }
    let method = reqwest::Method::from_bytes(method.to_ascii_uppercase().as_bytes())
        .map_err(|_| IpcError::invalid("bad HTTP method"))?;
    let url = format!("{}{}", api_base(app), path);
    let mut token = ensure_access_token(app).await.ok().flatten();
    for attempt in 0..2 {
        let mut req = state
            .http
            .request(method.clone(), &url)
            .timeout(Duration::from_millis(
                timeout_ms.unwrap_or(30_000).clamp(1_000, 300_000),
            ))
            .header("X-Bianfa-Device-Id", state.auth.device_id())
            .header(
                "X-Bianfa-App-Version",
                app.package_info().version.to_string(),
            )
            .headers(extra.clone());
        if let Some(t) = &token {
            req = req.bearer_auth(t);
        }
        if let Some(body) = &json_body {
            req = req.json(body);
        }
        let resp = req.send().await?;
        let status = resp.status().as_u16();
        if status == 401 && attempt == 0 && token.is_some() {
            state.auth.write(|i| i.access_token = None);
            token = ensure_access_token(app).await?;
            continue;
        }
        let headers = resp
            .headers()
            .iter()
            .filter_map(|(k, v)| {
                v.to_str()
                    .ok()
                    .map(|v| (k.as_str().to_string(), v.to_string()))
            })
            .collect();
        let body_text = resp.text().await?;
        return Ok(ApiResponse {
            status,
            headers,
            body_text,
        });
    }
    Err(IpcError::auth("unauthorized"))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncToken {
    pub token: String,
    /// Unix ms (server `expires_at`).
    pub expires_at: i64,
}

pub async fn sync_token(app: &AppHandle) -> IpcResult<SyncToken> {
    let r = api_request(
        app,
        "POST",
        paths::SYNC_TOKEN,
        Some(serde_json::json!({})),
        Some(15_000),
        None,
    )
    .await?;
    if r.status != 200 {
        return Err(IpcError::auth(format!(
            "sync token request failed ({})",
            r.status
        )));
    }
    let v: SyncTokenResponse = serde_json::from_str(&r.body_text)?;
    Ok(SyncToken {
        expires_at: v.expires_at_ms(now_ms()),
        token: v.token,
    })
}

pub fn secrets_wipe(secrets: &SecretStore) {
    for a in [keys::REFRESH_TOKEN, keys::DEVICE_ID, keys::DB_KEY] {
        let _ = secrets.delete(a);
    }
}
