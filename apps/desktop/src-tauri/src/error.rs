//! The single error type crossing the IPC boundary (07 §0: `IpcError { code, message, details? }`).

use serde::Serialize;
use std::fmt;

/// Error codes visible to the WebView. Kept as plain strings so the frontend can `switch` on them.
pub mod code {
    pub const DB: &str = "db";
    pub const KEYRING: &str = "keyring";
    pub const IO: &str = "io";
    pub const NETWORK: &str = "network";
    pub const AUTH: &str = "auth";
    pub const NOT_FOUND: &str = "not_found";
    pub const INVALID: &str = "invalid";
    pub const UNSUPPORTED: &str = "unsupported";
    /// Shell/runtime failures that are none of the above (tauri, plugins).
    pub const INTERNAL: &str = "internal";
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

pub type IpcResult<T> = Result<T, IpcError>;

impl IpcError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn db(message: impl Into<String>) -> Self {
        Self::new(code::DB, message)
    }
    pub fn keyring(message: impl Into<String>) -> Self {
        Self::new(code::KEYRING, message)
    }
    pub fn io(message: impl Into<String>) -> Self {
        Self::new(code::IO, message)
    }
    pub fn network(message: impl Into<String>) -> Self {
        Self::new(code::NETWORK, message)
    }
    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(code::AUTH, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(code::NOT_FOUND, message)
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(code::INVALID, message)
    }
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(code::UNSUPPORTED, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(code::INTERNAL, message)
    }
}

impl fmt::Display for IpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for IpcError {}

impl From<rusqlite::Error> for IpcError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::QueryReturnedNoRows => IpcError::not_found("row not found"),
            other => IpcError::db(other.to_string()),
        }
    }
}

impl From<std::io::Error> for IpcError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => IpcError::not_found(e.to_string()),
            _ => IpcError::io(e.to_string()),
        }
    }
}

impl From<serde_json::Error> for IpcError {
    fn from(e: serde_json::Error) -> Self {
        IpcError::invalid(format!("json: {e}"))
    }
}

impl From<base64::DecodeError> for IpcError {
    fn from(e: base64::DecodeError) -> Self {
        IpcError::invalid(format!("base64: {e}"))
    }
}

impl From<yrs::encoding::read::Error> for IpcError {
    fn from(e: yrs::encoding::read::Error) -> Self {
        IpcError::invalid(format!("yjs update: {e}"))
    }
}

impl From<url::ParseError> for IpcError {
    fn from(e: url::ParseError) -> Self {
        IpcError::invalid(format!("url: {e}"))
    }
}

#[cfg(feature = "app")]
impl From<tauri::Error> for IpcError {
    fn from(e: tauri::Error) -> Self {
        IpcError::internal(e.to_string())
    }
}

#[cfg(feature = "app")]
impl From<reqwest::Error> for IpcError {
    fn from(e: reqwest::Error) -> Self {
        IpcError::network(e.to_string())
    }
}

#[cfg(feature = "app")]
impl From<keyring::Error> for IpcError {
    fn from(e: keyring::Error) -> Self {
        match e {
            keyring::Error::NoEntry => IpcError::not_found("keyring entry not found"),
            other => IpcError::keyring(other.to_string()),
        }
    }
}

#[cfg(feature = "app")]
impl From<tauri_plugin_updater::Error> for IpcError {
    fn from(e: tauri_plugin_updater::Error) -> Self {
        IpcError::network(format!("updater: {e}"))
    }
}

#[cfg(feature = "app")]
impl From<tauri_plugin_global_shortcut::Error> for IpcError {
    fn from(e: tauri_plugin_global_shortcut::Error) -> Self {
        IpcError::internal(format!("global-shortcut: {e}"))
    }
}

#[cfg(feature = "app")]
impl From<tauri_plugin_opener::Error> for IpcError {
    fn from(e: tauri_plugin_opener::Error) -> Self {
        IpcError::io(format!("opener: {e}"))
    }
}

#[cfg(feature = "app")]
impl From<tauri_plugin_autostart::Error> for IpcError {
    fn from(e: tauri_plugin_autostart::Error) -> Self {
        IpcError::internal(format!("autostart: {e}"))
    }
}
