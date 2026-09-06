//! `settings.json` + `install_id` file (05 §5.2, 07 §2.3).

use super::state::Paths;
use crate::error::{IpcError, IpcResult};
use crate::model::Settings;

pub fn load(paths: &Paths) -> Settings {
    match std::fs::read_to_string(&paths.settings_file) {
        Ok(text) => match serde_json::from_str::<Settings>(&text) {
            Ok(s) if s.validate().is_ok() => s,
            Ok(_) => {
                log::warn!("settings.json has invalid values; using defaults");
                Settings::default()
            }
            Err(e) => {
                log::warn!("settings.json unreadable ({e}); using defaults");
                Settings::default()
            }
        },
        Err(_) => Settings::default(),
    }
}

pub fn save(paths: &Paths, settings: &Settings) -> IpcResult<()> {
    let text = serde_json::to_string_pretty(settings)?;
    let tmp = paths.settings_file.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &paths.settings_file)?;
    Ok(())
}

/// Applies a partial JSON patch onto the current settings and validates the result.
pub fn apply_patch(current: &Settings, patch: &serde_json::Value) -> IpcResult<Settings> {
    let mut merged = serde_json::to_value(current)?;
    let obj = patch
        .as_object()
        .ok_or_else(|| IpcError::invalid("patch must be an object"))?;
    if let serde_json::Value::Object(target) = &mut merged {
        for (k, v) in obj {
            target.insert(k.clone(), v.clone());
        }
    }
    let next: Settings = serde_json::from_value(merged)?;
    next.validate().map_err(IpcError::invalid)?;
    Ok(next)
}

/// Random UUID v4 created on first launch (never a machine fingerprint). Resettable.
pub fn install_id(paths: &Paths) -> String {
    if let Ok(s) = std::fs::read_to_string(&paths.install_id_file) {
        let s = s.trim();
        if uuid::Uuid::parse_str(s).is_ok() {
            return s.to_string();
        }
    }
    let id = crate::util::uuid_v4();
    let _ = std::fs::write(&paths.install_id_file, &id);
    id
}
