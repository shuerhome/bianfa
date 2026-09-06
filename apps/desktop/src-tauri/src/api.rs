//! Server wire shapes exactly as `apps/server` returns them (04 §6: snake_case, ISO-8601
//! timestamps, `server_time` in ms) and their mapping onto the camelCase IPC DTOs in
//! `model.rs`. Nothing here touches the network, so the parsers are unit-tested on the host
//! with the JSON the server integration tests assert on.

use crate::model::{AuthStatus, AuthUser};
use serde::Deserialize;
use std::collections::HashMap;

/// Public OAuth client registered by `bootstrapDesktopClient`.
pub const CLIENT_ID: &str = "bianfa-desktop";
pub const SCOPE: &str = "openid profile email offline_access";
pub const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// `device` table platforms accepted by the token endpoint (anything else → 400).
pub const PLATFORMS: [&str; 3] = ["windows", "macos", "linux"];
/// Server-side attachment MIME whitelist (`POST /v1/attachments/presign`).
pub const UPLOAD_MIMES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/// Server paths used by the desktop (04 §6.1–6.4).
pub mod paths {
    pub const AUTHORIZE: &str = "/api/auth/oauth2/authorize";
    /// Every grant, including RFC 8628 device codes, is redeemed here.
    pub const TOKEN: &str = "/api/auth/oauth2/token";
    pub const REVOKE: &str = "/api/auth/oauth2/revoke";
    pub const DEVICE_CODE: &str = "/api/auth/device/code";
    pub const ME: &str = "/v1/me";
    pub const CLAIM: &str = "/v1/claim";
    pub const SYNC_TOKEN: &str = "/v1/sync/token";
    pub const ATTACHMENT_PRESIGN: &str = "/v1/attachments/presign";
    pub const ATTACHMENT_COMMIT: &str = "/v1/attachments/commit";
    pub const NOTICE: &str = "/v1/notice";
}

/// `std::env::consts::OS` → the value the server's `device.platform` column accepts.
pub fn platform_name(os: &str) -> &'static str {
    match os {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    }
}

/// Successful `POST /api/auth/oauth2/token` (authorization_code / device_code / refresh_token).
/// Opaque tokens only: `bfa_…` access (15 min), `bfr_…` refresh; no `id_token` is issued.
#[derive(Debug, Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub token_type: Option<String>,
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub scope: Option<String>,
}

/// OAuth-style failure body (`{ error, error_description?, … }`); the desktop plugin adds
/// `limit` to `device_limit_reached`.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
pub struct OAuthError {
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub error_description: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

impl OAuthError {
    /// Lenient: a non-JSON body becomes an empty error (callers fall back to the status).
    pub fn parse(text: &str) -> Self {
        serde_json::from_str(text).unwrap_or_default()
    }

    pub fn is(&self, code: &str) -> bool {
        self.error == code
    }

    /// Human-readable, bilingual (zh · en) message for the login UI.
    pub fn message(&self, status: u16) -> String {
        match self.error.as_str() {
            "device_limit_reached" => {
                let limit = self.limit.unwrap_or(2);
                format!(
                    "免费版最多 {limit} 台同步设备，请先在「设置 → 账号」或网页端注销一台设备，或升级套餐 · \
                     The Free plan allows {limit} sync devices; sign out one device or upgrade."
                )
            }
            "expired_token" => {
                "验证码已过期，请重新点击登录 · The code expired; please start signing in again."
                    .into()
            }
            "access_denied" => "登录已被拒绝 · Sign-in was denied in the browser.".into(),
            "invalid_grant" => {
                "登录凭据无效或已过期，请重试 · The sign-in grant is invalid or expired; please retry."
                    .into()
            }
            "slow_down" => "请求过于频繁，请稍后重试 · Too many requests; please try again shortly.".into(),
            "" => format!("登录失败（HTTP {status}） · Sign-in failed (HTTP {status})."),
            other => match &self.error_description {
                Some(d) if !d.is_empty() => format!("登录失败：{other}（{d}） · Sign-in failed: {other} ({d})"),
                _ => format!("登录失败：{other} · Sign-in failed: {other}"),
            },
        }
    }
}

/// `POST /api/auth/device/code` (RFC 8628 §3.2).
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    #[serde(default)]
    pub verification_uri: Option<String>,
    #[serde(default)]
    pub verification_uri_complete: Option<String>,
    #[serde(default = "default_device_expiry")]
    pub expires_in: i64,
    #[serde(default = "default_interval")]
    pub interval: i64,
}

fn default_device_expiry() -> i64 {
    1800
}
fn default_interval() -> i64 {
    5
}

/// `GET /v1/me` → `user`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct MeUser {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub email: String,
    #[serde(default)]
    pub email_verified: bool,
    #[serde(default)]
    pub image: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub ai_opt_in: bool,
    #[serde(default)]
    pub two_factor_enabled: bool,
}

/// `GET /v1/me` → `orgs[]` (memberships that are not `removed`, org not deleted).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct MeOrg {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub slug: Option<String>,
    #[serde(default = "default_plan")]
    pub plan: String,
    #[serde(default)]
    pub enterprise_mode: bool,
    #[serde(default)]
    pub role: String,
    #[serde(default = "default_member_status")]
    pub status: String,
    #[serde(default)]
    pub joined_at: Option<String>,
}

fn default_plan() -> String {
    "free".into()
}
fn default_member_status() -> String {
    "active".into()
}

/// `GET /v1/me` (auth/services/me.ts `getMe`).
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct MeResponse {
    pub user: MeUser,
    #[serde(default = "default_plan")]
    pub plan: String,
    #[serde(default)]
    pub personal_workspace_id: Option<String>,
    #[serde(default)]
    pub orgs: Vec<MeOrg>,
    #[serde(default)]
    pub active_devices: i64,
    #[serde(default)]
    pub current_device_id: Option<String>,
    #[serde(default)]
    pub deletion_due_at: Option<String>,
    #[serde(default)]
    pub server_time: Option<i64>,
}

impl MeResponse {
    pub fn auth_user(&self) -> AuthUser {
        AuthUser {
            id: self.user.id.clone(),
            email: self.user.email.clone(),
            name: self.user.name.clone().filter(|n| !n.is_empty()),
            image: self.user.image.clone(),
        }
    }

    /// The org the team wall opens on: the first active membership (else the first listed).
    pub fn active_organization_id(&self) -> Option<String> {
        self.orgs
            .iter()
            .find(|o| o.status == "active")
            .or_else(|| self.orgs.first())
            .map(|o| o.id.clone())
    }

    pub fn to_status(&self, device_id: &str) -> AuthStatus {
        AuthStatus {
            logged_in: true,
            user: Some(self.auth_user()),
            device_id: device_id.to_string(),
            personal_workspace_id: self.personal_workspace_id.clone(),
            active_organization_id: self.active_organization_id(),
            plan: Some(self.plan.clone()),
        }
    }
}

/// `POST /v1/claim`.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct ClaimResponse {
    pub personal_workspace_id: String,
    #[serde(default)]
    pub claimed_before: bool,
}

/// `POST /v1/sync/token`: 60 s HS256 JWT; `expires_at` is Unix **ms**.
#[derive(Debug, Clone, Deserialize)]
pub struct SyncTokenResponse {
    pub token: String,
    #[serde(default = "default_sync_ttl")]
    pub expires_in: i64,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

fn default_sync_ttl() -> i64 {
    60
}

impl SyncTokenResponse {
    pub fn expires_at_ms(&self, now_ms: i64) -> i64 {
        self.expires_at.unwrap_or(now_ms + self.expires_in * 1000)
    }
}

/// `POST /v1/attachments/presign`: either a dedup hit (`exists: true`) or a presigned PUT.
#[derive(Debug, Clone, Deserialize)]
pub struct PresignResponse {
    #[serde(default)]
    pub exists: bool,
    pub attachment_id: String,
    #[serde(default)]
    pub upload_url: Option<String>,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub expires_in: Option<i64>,
}

/// `POST /v1/attachments/commit`.
#[derive(Debug, Clone, Deserialize)]
pub struct CommitResponse {
    pub attachment_id: String,
    pub status: String,
    #[serde(default)]
    pub committed_at: Option<String>,
}

/// Generic `/v1` failure: `{ error: <code>, ...extra, request_id?, server_time }`.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct ApiErrorBody {
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl ApiErrorBody {
    pub fn parse(text: &str) -> Self {
        serde_json::from_str(text).unwrap_or_default()
    }

    /// Server code, or `http_<status>` when the body carried none.
    pub fn code(&self, status: u16) -> String {
        if self.error.is_empty() {
            format!("http_{status}")
        } else {
            self.error.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_response_from_auth_flow_test() {
        let t: TokenResponse = serde_json::from_str(
            r#"{"access_token":"bfa_abc","refresh_token":"bfr_def","token_type":"Bearer","expires_in":900,"scope":"openid profile email offline_access"}"#,
        )
        .unwrap();
        assert_eq!(t.access_token, "bfa_abc");
        assert_eq!(t.refresh_token.as_deref(), Some("bfr_def"));
        assert_eq!(t.expires_in, Some(900));
        assert!(t.scope.unwrap().contains("offline_access"));
        // refresh grant may omit fields the desktop does not need
        let min: TokenResponse = serde_json::from_str(r#"{"access_token":"bfa_x"}"#).unwrap();
        assert!(min.refresh_token.is_none());
    }

    #[test]
    fn oauth_errors_and_messages() {
        let e = OAuthError::parse(
            r#"{"error":"device_limit_reached","error_description":"Free plan allows 2 active sync devices; revoke one or upgrade","limit":2}"#,
        );
        assert!(e.is("device_limit_reached"));
        assert_eq!(e.limit, Some(2));
        let m = e.message(403);
        assert!(m.contains("2 台") && m.contains("Free plan"));
        for code in [
            "authorization_pending",
            "slow_down",
            "expired_token",
            "access_denied",
        ] {
            let e = OAuthError::parse(&format!(r#"{{"error":"{code}","error_description":"x"}}"#));
            assert!(e.is(code));
        }
        assert!(OAuthError::parse("not json").error.is_empty());
        assert!(OAuthError::parse("").message(502).contains("502"));
        assert!(OAuthError::parse(r#"{"error":"expired_token"}"#)
            .message(400)
            .contains("expired"));
    }

    #[test]
    fn device_code_response_defaults() {
        let d: DeviceCodeResponse = serde_json::from_str(
            r#"{"device_code":"d","user_code":"ABCD-EFGH","verification_uri":"http://localhost:1420/device","verification_uri_complete":"http://localhost:1420/device?user_code=ABCD-EFGH","expires_in":1800,"interval":5}"#,
        )
        .unwrap();
        assert_eq!(d.interval, 5);
        assert_eq!(d.expires_in, 1800);
        let bare: DeviceCodeResponse =
            serde_json::from_str(r#"{"device_code":"d","user_code":"u"}"#).unwrap();
        assert_eq!(bare.interval, 5);
        assert_eq!(bare.expires_in, 1800);
        assert!(bare.verification_uri.is_none());
    }

    #[test]
    fn me_response_maps_to_auth_status() {
        let json = r#"{
          "user": {"id":"u1","name":"Alice","email":"alice@test.invalid","email_verified":true,"image":null,
                   "created_at":"2026-01-01T00:00:00.000Z","ai_opt_in":false,"two_factor_enabled":false},
          "plan":"free",
          "personal_workspace_id":"019a0000-0000-7000-8000-000000000001",
          "orgs":[
            {"id":"o-suspended","name":"Old","slug":"old","plan":"team","enterprise_mode":false,"role":"member","status":"suspended","joined_at":"2026-01-02T00:00:00.000Z"},
            {"id":"o-active","name":"Acme 便笺","slug":"acme","plan":"team","enterprise_mode":true,"role":"owner","status":"active","joined_at":"2026-01-03T00:00:00.000Z"}
          ],
          "active_devices":1,
          "current_device_id":"019a0000-0000-7000-8000-0000000000d1",
          "deletion_due_at":null,
          "server_time":1700000000000
        }"#;
        let me: MeResponse = serde_json::from_str(json).unwrap();
        let s = me.to_status("dev");
        assert!(s.logged_in);
        assert_eq!(s.device_id, "dev");
        assert_eq!(
            s.personal_workspace_id.as_deref(),
            Some("019a0000-0000-7000-8000-000000000001")
        );
        assert_eq!(s.active_organization_id.as_deref(), Some("o-active"));
        assert_eq!(s.plan.as_deref(), Some("free"));
        let u = s.user.unwrap();
        assert_eq!(u.id, "u1");
        assert_eq!(u.name.as_deref(), Some("Alice"));
        assert_eq!(u.email, "alice@test.invalid");
        assert!(u.image.is_none());
        assert_eq!(me.server_time, Some(1_700_000_000_000));

        // the shape asserted in auth-flow.test.ts for a fresh user
        let fresh: MeResponse = serde_json::from_str(
            r#"{"user":{"id":"u","email":"a@b.c"},"plan":"free","personal_workspace_id":"w","orgs":[],"active_devices":0,"current_device_id":"d","deletion_due_at":null,"server_time":1}"#,
        )
        .unwrap();
        assert!(fresh.active_organization_id().is_none());
        assert_eq!(fresh.auth_user().name, None);
    }

    #[test]
    fn claim_sync_token_and_attachment_shapes() {
        let c: ClaimResponse = serde_json::from_str(
            r#"{"personal_workspace_id":"w1","claimed_before":false,"server_time":1}"#,
        )
        .unwrap();
        assert_eq!(c.personal_workspace_id, "w1");
        assert!(!c.claimed_before);

        let t: SyncTokenResponse = serde_json::from_str(
            r#"{"token":"eyJ.x.y","expires_in":60,"expires_at":1700000060000,"server_time":1}"#,
        )
        .unwrap();
        assert_eq!(t.expires_at_ms(0), 1_700_000_060_000);
        let no_abs: SyncTokenResponse = serde_json::from_str(r#"{"token":"t"}"#).unwrap();
        assert_eq!(no_abs.expires_at_ms(1_000), 61_000);

        let hit: PresignResponse =
            serde_json::from_str(r#"{"exists":true,"attachment_id":"a1","server_time":1}"#)
                .unwrap();
        assert!(hit.exists && hit.upload_url.is_none());
        let put: PresignResponse = serde_json::from_str(
            r#"{"exists":false,"attachment_id":"a2","upload_url":"https://r2.example/put","method":"PUT","headers":{"Content-Type":"image/png","Content-Length":"1024"},"expires_in":900}"#,
        )
        .unwrap();
        assert_eq!(put.method.as_deref(), Some("PUT"));
        assert_eq!(put.headers.get("Content-Type").unwrap(), "image/png");
        let done: CommitResponse = serde_json::from_str(
            r#"{"attachment_id":"a2","status":"committed","committed_at":"2026-01-01T00:00:00.000Z"}"#,
        )
        .unwrap();
        assert_eq!(done.status, "committed");
    }

    #[test]
    fn api_error_body_code() {
        let e = ApiErrorBody::parse(
            r#"{"error":"quota_exceeded","used":1,"limit":2,"incoming":3,"request_id":"r","server_time":1}"#,
        );
        assert_eq!(e.code(409), "quota_exceeded");
        assert_eq!(e.extra.get("limit").and_then(|v| v.as_i64()), Some(2));
        assert_eq!(ApiErrorBody::parse("<html>").code(502), "http_502");
    }

    #[test]
    fn platform_names() {
        assert_eq!(platform_name("windows"), "windows");
        assert_eq!(platform_name("macos"), "macos");
        assert_eq!(platform_name("freebsd"), "linux");
        assert!(PLATFORMS.contains(&platform_name(std::env::consts::OS)));
    }
}
