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

/// One row of `todos_list`: a `taskItem` block joined with its (non-trashed) note.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub note_id: String,
    /// First non-empty line of the note text (≤ 120 chars; may carry a `[ ] ` task prefix).
    pub note_title: String,
    pub note_color: NoteColor,
    pub workspace_id: Option<String>,
    /// `taskItem.attrs.id` (nanoid, 10 chars).
    pub block_id: String,
    pub text: String,
    pub checked: bool,
    /// Document order within the note, from 0.
    pub ordinal: i64,
    pub note_updated_at: i64,
    /// When this item's text or checked state last changed (unix ms).
    pub item_updated_at: i64,
}

/// `todos_counts` result (same exclusions as `todos_list`).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodoCounts {
    pub open: i64,
    pub done: i64,
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
    /// 正文的紧凑度：`compact` / `cozy` / `relaxed`。默认 compact —— 便笺是拿来扫一眼的，
    /// 原版 Windows 便笺也是密排；行距和段距太松，一屏看不下几行。
    pub content_density: String,
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

/// 正文紧凑度的合法取值。顺序即「从紧到松」。
pub const CONTENT_DENSITIES: [&str; 3] = ["compact", "cozy", "relaxed"];
/// 默认取最紧的一档：对齐 Windows 便笺的密排观感。
pub const DEFAULT_CONTENT_DENSITY: &str = "compact";

/// 曾经的硬编码同步地址。它假定部署会单独开一个 `ws.` 子域，而实际部署把 WebSocket 挂在
/// API 同一个主机的 `/ws/v1` 上（Caddy 的 `handle /ws/*` 不按主机名区分）。两边一旦对不上，
/// 表现是「登录成功、界面正常、但一条便笺都同步不上去」——客户端连不上就换不到同步凭据，
/// 服务端因此连一次请求都看不到，两头都不报错，非常难查。
///
/// 现在同步地址默认**从 apiBaseUrl 推导**（见 [`default_sync_ws_url`]），自托管只需配一个地址。
/// 这个常量保留下来只为一件事：把老安装里存着的这个旧值识别出来并迁移掉（见 [`Settings::normalize`]）。
pub const LEGACY_SYNC_WS_URL: &str = "wss://ws.bianfa.app/ws/v1";

/// 由 API 地址推导同步地址：`https://x/` → `wss://x/ws/v1`（http → ws）。
/// 推导失败（地址畸形）时回落到用默认 API 地址推出来的那个。
pub fn default_sync_ws_url(api_base_url: &str) -> String {
    let trimmed = api_base_url.trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}/ws/v1")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}/ws/v1")
    } else {
        format!(
            "wss://{}/ws/v1",
            DEFAULT_API_BASE_URL.trim_start_matches("https://")
        )
    }
}

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
            content_density: DEFAULT_CONTENT_DENSITY.into(),
            api_base_url: DEFAULT_API_BASE_URL.into(),
            sync_ws_url: default_sync_ws_url(DEFAULT_API_BASE_URL),
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
        if !CONTENT_DENSITIES.contains(&self.content_density.as_str()) {
            return Err(format!("contentDensity: {}", self.content_density));
        }
        Ok(())
    }

    /// 读盘之后、校验之前调用。目前只做一件事：把老安装里存着的 `wss://ws.<域>/ws/v1`
    /// 迁移成由 apiBaseUrl 推导出来的地址。
    ///
    /// 为什么必须迁移而不是只改默认值：这个字段是**持久化**的，老安装启动时读到的是盘上那个旧值，
    /// 新的默认值根本轮不到生效。不迁移的话，升级完照样同步不了，而且更难查——因为代码里已经写着新地址了。
    /// 只认那一个确切的旧字符串，用户自己手改过的地址不动。
    pub fn normalize(&mut self) {
        if self.sync_ws_url == LEGACY_SYNC_WS_URL || self.sync_ws_url.is_empty() {
            self.sync_ws_url = default_sync_ws_url(&self.api_base_url);
        }
        // 老安装的 settings.json 里没有这个字段，serde 会填空串；写坏了也一样兜回默认。
        // 不校验的话，一个非法值会让 CSS 落不到任何一档，正文变成浏览器默认排版。
        if !CONTENT_DENSITIES.contains(&self.content_density.as_str()) {
            self.content_density = DEFAULT_CONTENT_DENSITY.into();
        }
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

    #[test]
    fn sync_url_is_derived_from_api_url() {
        assert_eq!(
            default_sync_ws_url("https://api.bianfa.app"),
            "wss://api.bianfa.app/ws/v1"
        );
        // 末尾斜杠不该多出一段
        assert_eq!(
            default_sync_ws_url("https://api.example.test/"),
            "wss://api.example.test/ws/v1"
        );
        // 本地开发用明文
        assert_eq!(
            default_sync_ws_url("http://127.0.0.1:3000"),
            "ws://127.0.0.1:3000/ws/v1"
        );
        // 畸形输入回落到默认主机，而不是拼出一个非法地址
        assert_eq!(
            default_sync_ws_url("nonsense"),
            "wss://api.bianfa.app/ws/v1"
        );
    }

    #[test]
    fn normalize_repairs_a_bogus_density() {
        // 结构体上有 #[serde(default)]，所以老安装缺这个字段时 serde 会落到 Settings::default()，
        // 不会解析失败 —— 这条测的是另一种情况：settings.json 被手改坏了。
        // normalize 必须在 validate 之前把它修回来（load() 就是这个顺序），
        // 否则一个拼错的字符串会让整份设置被判定无效、全部退回默认。
        let mut s = Settings {
            content_density: String::new(),
            ..Settings::default()
        };
        s.normalize();
        assert_eq!(s.content_density, DEFAULT_CONTENT_DENSITY);
        // 手改坏了也要兜回来，不能让 CSS 落不到任何一档
        s.content_density = "very-loose".into();
        s.normalize();
        assert_eq!(s.content_density, DEFAULT_CONTENT_DENSITY);
        // 合法值原样保留
        s.content_density = "relaxed".into();
        s.normalize();
        assert_eq!(s.content_density, "relaxed");
        assert!(s.validate().is_ok());
    }

    #[test]
    fn default_density_is_the_tight_one() {
        // 便笺是拿来扫一眼的：默认必须是最紧的一档，松的两档是用户主动选的
        assert_eq!(Settings::default().content_density, CONTENT_DENSITIES[0]);
        assert_eq!(DEFAULT_CONTENT_DENSITY, "compact");
    }

    #[test]
    fn a_bogus_density_is_rejected_at_the_patch_boundary() {
        // load() 那条路有 normalize 兜着，但 settings_set 的补丁只过 validate ——
        // 界面传来一个没见过的值必须当场报错，而不是悄悄存进盘里
        let s = Settings {
            content_density: "ultra-tight".into(),
            ..Settings::default()
        };
        assert!(s.validate().is_err());
    }

    #[test]
    fn normalize_migrates_the_dead_legacy_sync_url() {
        // 老安装：盘上存着那个从来连不上的 ws. 子域
        let mut s = Settings {
            sync_ws_url: LEGACY_SYNC_WS_URL.into(),
            api_base_url: "https://api.bianfa.app".into(),
            ..Settings::default()
        };
        s.normalize();
        assert_eq!(s.sync_ws_url, "wss://api.bianfa.app/ws/v1");

        // 自托管：apiBaseUrl 改过，同步地址跟着走
        let mut s = Settings {
            sync_ws_url: LEGACY_SYNC_WS_URL.into(),
            api_base_url: "https://n.example.test".into(),
            ..Settings::default()
        };
        s.normalize();
        assert_eq!(s.sync_ws_url, "wss://n.example.test/ws/v1");

        // 用户自己手改过的地址不许动
        let mut s = Settings {
            sync_ws_url: "wss://my.own.host/ws/v1".into(),
            ..Settings::default()
        };
        s.normalize();
        assert_eq!(s.sync_ws_url, "wss://my.own.host/ws/v1");
    }
}
