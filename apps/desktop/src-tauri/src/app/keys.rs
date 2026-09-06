//! OS keyring access (`service = app.bianfa.desktop`; accounts `db_key`, `refresh_token`,
//! `device_id`). Headless/broken keyrings fall back to a 0600 file with a loud warning
//! (04 §2.5). Values are always < 2048 bytes.

use crate::error::{IpcError, IpcResult};
use std::path::PathBuf;

pub const SERVICE: &str = "app.bianfa.desktop";
pub const DB_KEY: &str = "db_key";
pub const REFRESH_TOKEN: &str = "refresh_token";
pub const DEVICE_ID: &str = "device_id";

pub struct SecretStore {
    fallback_dir: PathBuf,
}

fn store_unavailable(e: &keyring::Error) -> bool {
    matches!(
        e,
        keyring::Error::NoDefaultStore
            | keyring::Error::NoStorageAccess(_)
            | keyring::Error::PlatformFailure(_)
            | keyring::Error::NotSupportedByStore(_)
    )
}

impl SecretStore {
    pub fn new(fallback_dir: PathBuf) -> Self {
        Self { fallback_dir }
    }

    fn fallback_path(&self, account: &str) -> PathBuf {
        self.fallback_dir.join(account)
    }

    fn fallback_get(&self, account: &str) -> IpcResult<Option<String>> {
        match std::fs::read_to_string(self.fallback_path(account)) {
            Ok(s) => Ok(Some(s.trim().to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn fallback_set(&self, account: &str, value: &str) -> IpcResult<()> {
        std::fs::create_dir_all(&self.fallback_dir)?;
        let p = self.fallback_path(account);
        std::fs::write(&p, value)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
        }
        log::warn!("keyring unavailable; stored `{account}` in a local file instead");
        Ok(())
    }

    pub fn get(&self, account: &str) -> IpcResult<Option<String>> {
        match keyring::Entry::new(SERVICE, account) {
            Ok(entry) => match entry.get_password() {
                Ok(v) => Ok(Some(v)),
                Err(keyring::Error::NoEntry) => self.fallback_get(account),
                Err(e) if store_unavailable(&e) => self.fallback_get(account),
                Err(e) => Err(IpcError::keyring(e.to_string())),
            },
            Err(e) if store_unavailable(&e) => self.fallback_get(account),
            Err(e) => Err(IpcError::keyring(e.to_string())),
        }
    }

    pub fn set(&self, account: &str, value: &str) -> IpcResult<()> {
        if value.len() >= 2048 {
            return Err(IpcError::invalid("keyring value must be < 2048 bytes"));
        }
        match keyring::Entry::new(SERVICE, account) {
            Ok(entry) => match entry.set_password(value) {
                Ok(()) => {
                    let _ = std::fs::remove_file(self.fallback_path(account));
                    Ok(())
                }
                Err(e) if store_unavailable(&e) => self.fallback_set(account, value),
                Err(e) => Err(IpcError::keyring(e.to_string())),
            },
            Err(e) if store_unavailable(&e) => self.fallback_set(account, value),
            Err(e) => Err(IpcError::keyring(e.to_string())),
        }
    }

    pub fn delete(&self, account: &str) -> IpcResult<()> {
        let _ = std::fs::remove_file(self.fallback_path(account));
        match keyring::Entry::new(SERVICE, account) {
            Ok(entry) => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) if store_unavailable(&e) => Ok(()),
                Err(e) => Err(IpcError::keyring(e.to_string())),
            },
            Err(e) if store_unavailable(&e) => Ok(()),
            Err(e) => Err(IpcError::keyring(e.to_string())),
        }
    }

    /// 32 random bytes as hex, created on first run.
    pub fn db_key(&self) -> IpcResult<String> {
        if let Some(k) = self.get(DB_KEY)? {
            if k.len() == 64 {
                return Ok(k);
            }
        }
        let key = hex::encode(crate::util::random_bytes(32));
        self.set(DB_KEY, &key)?;
        Ok(key)
    }

    /// Stable per-installation device id (UUID v7), created on first run.
    pub fn device_id(&self) -> IpcResult<String> {
        if let Some(id) = self.get(DEVICE_ID)? {
            if !id.is_empty() {
                return Ok(id);
            }
        }
        let id = crate::util::uuid_v7();
        self.set(DEVICE_ID, &id)?;
        Ok(id)
    }
}
