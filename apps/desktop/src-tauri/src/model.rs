//! DTOs shared with the WebView (07 §1). Field names serialize as camelCase.

use crate::colors::NoteColor;
use serde::{Deserialize, Serialize};

/// 0 normal / 1 always-on-top / 2 pinned-to-desktop.
pub type ZMode = i64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    pub block_id: String,
    pub text: String,
    pub checked: bool,
    pub ordinal: i64,
}

/// Projection of a Y.Doc computed by JS (`@bianfa/shared`); Rust never parses PM JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteProjection {
    pub content: serde_json::Value,
    #[serde(default)]
    pub content_text: String,
    #[serde(default)]
    pub content_bigram: String,
    #[serde(default)]
    pub body_html: String,
    #[serde(default)]
    pub color: NoteColor,
    #[serde(default)]
    pub z_mode: ZMode,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub deleted_at: Option<i64>,
    #[serde(default = "default_schema_version")]
    pub schema_version: i64,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    #[serde(default)]
    pub checklist: Vec<ChecklistItem>,
}

fn default_schema_version() -> i64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteListItem {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    pub color: NoteColor,
    pub z_mode: ZMode,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub is_open: bool,
    pub synced: bool,
    pub workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    #[serde(flatten)]
    pub item: NoteListItem,
    pub body_html: String,
    pub schema_version: i64,
    pub head_seq: i64,
    pub content_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDocBundle {
    pub snapshot_b64: Option<String>,
    pub snapshot_upto_seq: i64,
    pub updates_b64: Vec<String>,
    pub head_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatesSince {
    pub updates_b64: Vec<String>,
    pub head_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub note_id: String,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub w: Option<i64>,
    pub h: Option<i64>,
    pub monitor_key: Option<String>,
    pub scale: Option<f64>,
    pub home_display_id: Option<String>,
    pub home_bounds: Option<String>,
    pub z_mode: ZMode,
    pub collapsed: bool,
    pub is_open: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    #[serde(default)]
    pub pinned: Option<bool>,
    #[serde(default)]
    pub trashed: Option<bool>,
    #[serde(default)]
    pub color: Option<NoteColor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSync {
    pub note_id: String,
    pub head_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncErrorItem {
    pub note_id: String,
    pub err_code: String,
    pub message: Option<String>,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionItem {
    pub id: String,
    pub label: String,
    pub created_at: i64,
    pub byte_size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub id: String,
    pub hash: String,
    pub mime: String,
    pub byte_size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub blurhash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRow {
    pub id: String,
    pub content_hash: Vec<u8>,
    pub byte_size: i64,
    pub mime: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub blurhash: Option<String>,
    pub local_path: String,
    pub upload_state: String,
    pub created_at: i64,
}

/// One row of `import_commit.items`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportWindow {
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub w: Option<i64>,
    pub h: Option<i64>,
    #[serde(default)]
    pub display_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommitItem {
    pub external_id: String,
    pub note_id: String,
    pub update_v2_b64: String,
    pub projection: NoteProjection,
    #[serde(default)]
    pub is_open: bool,
    #[serde(default)]
    pub window: Option<ImportWindow>,
    #[serde(default)]
    pub source_updated_at: Option<i64>,
    #[serde(default)]
    pub degraded: bool,
    #[serde(default)]
    pub has_ink: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommitResult {
    pub imported: i64,
    pub updated: i64,
    pub skipped: i64,
}

/// `db:changed` payload (07 §3).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbChanged {
    pub rev: i64,
    pub origin: String,
    pub tables: Vec<String>,
    pub ids: Vec<String>,
}

/// Application settings persisted as JSON (07 §1 `Settings`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    pub ui_scale: u32,
    pub language: String,
    pub autostart: bool,
    pub channel: String,
    pub hotkey_new_note: String,
    pub desktop_pin_readonly: bool,
    pub color_patterns: bool,
    pub reduce_transparency: bool,
    pub api_base_url: String,
    pub sync_ws_url: String,
    /// Notice ids the user acknowledged (`notice_ack`). Not part of the public contract.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub acked_notice_ids: Vec<String>,
    /// Whether the "notes live in the tray" balloon was shown once (05 §2.3).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub tray_hint_shown: bool,
}

pub const DEFAULT_API_BASE_URL: &str = "https://api.bianfa.app";
pub const DEFAULT_SYNC_WS_URL: &str = "wss://ws.bianfa.app/ws/v1";

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            ui_scale: 100,
            language: "system".into(),
            autostart: false,
            channel: "stable".into(),
            hotkey_new_note: default_hotkey().into(),
            desktop_pin_readonly: cfg!(target_os = "macos"),
            color_patterns: false,
            reduce_transparency: false,
            api_base_url: DEFAULT_API_BASE_URL.into(),
            sync_ws_url: DEFAULT_SYNC_WS_URL.into(),
            acked_notice_ids: Vec::new(),
            tray_hint_shown: false,
        }
    }
}

/// `Ctrl+Alt+N` on Windows/Linux, `⌥⌘N` on macOS (05 §4.2).
pub fn default_hotkey() -> &'static str {
    if cfg!(target_os = "macos") {
        "Alt+Super+N"
    } else {
        "Ctrl+Alt+N"
    }
}

impl Settings {
    pub fn ui_scale_factor(&self) -> f64 {
        match self.ui_scale {
            90 | 100 | 115 | 130 => self.ui_scale as f64 / 100.0,
            _ => 1.0,
        }
    }

    /// Effective UI language: `zh-Hans` or `en`.
    pub fn effective_language(&self, system_locale: Option<&str>) -> &'static str {
        match self.language.as_str() {
            "zh-Hans" => "zh-Hans",
            "en" => "en",
            _ => {
                let loc = system_locale.unwrap_or("zh").to_ascii_lowercase();
                if loc.starts_with("zh") {
                    "zh-Hans"
                } else {
                    "en"
                }
            }
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if !matches!(self.theme.as_str(), "system" | "light" | "dark") {
            return Err(format!("theme: {}", self.theme));
        }
        if !matches!(self.ui_scale, 90 | 100 | 115 | 130) {
            return Err(format!("uiScale: {}", self.ui_scale));
        }
        if !matches!(self.language.as_str(), "zh-Hans" | "en" | "system") {
            return Err(format!("language: {}", self.language));
        }
        if !matches!(self.channel.as_str(), "stable" | "beta") {
            return Err(format!("channel: {}", self.channel));
        }
        if !(self.api_base_url.starts_with("https://") || self.api_base_url.starts_with("http://"))
        {
            return Err("apiBaseUrl must be http(s)".into());
        }
        if !(self.sync_ws_url.starts_with("wss://") || self.sync_ws_url.starts_with("ws://")) {
            return Err("syncWsUrl must be ws(s)".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub os: String,
    pub arch: String,
    pub data_dir: String,
    pub install_id: String,
    pub channel: String,
    pub webview: String,
    pub is_autostart_launch: bool,
    /// Extra (not in 07): set when the data dir sits inside OneDrive/iCloud/Dropbox (05 §7.1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud_sync_folder: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub image: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub logged_in: bool,
    pub user: Option<AuthUser>,
    pub device_id: String,
    pub personal_workspace_id: Option<String>,
    pub active_organization_id: Option<String>,
    /// Effective plan from `GET /v1/me` (`free` / `pro` / `team`); `None` until fetched.
    #[serde(default)]
    pub plan: Option<String>,
}

/// Result of `attachment_upload` (presign → PUT → commit against `/v1/attachments/*`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUploadResult {
    /// Local attachment id (the one referenced from note bodies).
    pub attachment_id: String,
    /// Server-side id; differs from `attachment_id` only on a workspace-level dedup hit.
    pub remote_attachment_id: Option<String>,
    /// `committed` | `local` (not signed in) | `unsupported` (non-image) | `disabled` (503).
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    pub status: u16,
    pub headers: std::collections::HashMap<String, String>,
    pub body_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub id: String,
    pub issued_at: Option<serde_json::Value>,
    pub expires_at: Option<serde_json::Value>,
    #[serde(default = "default_notice_action")]
    pub action: String,
    #[serde(default)]
    pub platforms: Vec<String>,
    #[serde(default)]
    pub affected_versions: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub url: Option<String>,
}

fn default_notice_action() -> String {
    "notice".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_defaults_and_language() {
        let s = Settings::default();
        assert!(s.validate().is_ok());
        assert_eq!(s.effective_language(Some("en-US")), "en");
        assert_eq!(s.effective_language(Some("zh-CN")), "zh-Hans");
        assert_eq!(s.effective_language(None), "zh-Hans");
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["apiBaseUrl"], DEFAULT_API_BASE_URL);
        assert!(json.get("ackedNoticeIds").is_none());
    }

    #[test]
    fn projection_defaults() {
        let p: NoteProjection =
            serde_json::from_str(r#"{"content":{"type":"doc"},"createdAt":1,"updatedAt":2}"#)
                .unwrap();
        assert_eq!(p.schema_version, 1);
        assert_eq!(p.color, NoteColor::Graphite);
        assert!(p.checklist.is_empty());
    }
}
