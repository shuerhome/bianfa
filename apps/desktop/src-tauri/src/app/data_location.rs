//! 数据目录的位置（可搬到别的盘，例如 Windows 上的 D:\）。
//!
//! **为什么需要一个单独的指针文件**：数据目录里装着 settings.json 本身，所以「数据目录在哪」
//! 这条配置不能存在数据目录里——那是个鸡生蛋。指针文件固定放在系统默认位置
//! （`app_local_data_dir()/data-location.json`），只有一行内容，指向真正的数据目录。
//!
//! **绝不静默回落**：如果指针指向的盘没挂上（外置盘、网络盘、D 盘被拔了），启动时**不能**
//! 悄悄退回默认目录 —— 那样用户看到的是一个空应用，会以为便笺全丢了，进而可能去重新导入、
//! 覆盖掉云端。正确做法是明确报错，把路径显示出来，让人自己决定是插盘还是切回默认。
//!
//! **不许放进云盘同步目录**：OneDrive / iCloud / Dropbox / Google Drive 同步 SQLite 的 WAL
//! 文件是数据库损坏的头号来源（规格 05 §7.1）。选目录时直接挡掉这一类路径。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const POINTER_FILE: &str = "data-location.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pointer {
    /// 用户选定的数据目录绝对路径
    data_dir: String,
}

/// 指针解析的结果。`Missing` 是致命的，调用方必须显示错误而不是回落。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Located {
    /// 没有指针文件（或内容为空）→ 用系统默认目录
    Default(PathBuf),
    /// 指针有效且目录可用
    Custom(PathBuf),
    /// 指针存在但目标不可用（盘没挂上 / 被删 / 没权限）——**不要回落**
    Missing { configured: PathBuf, reason: String },
}

/// 云盘同步目录的特征片段（小写比较）。宁可误挡也不要让人把 SQLite 放进去。
const CLOUD_MARKERS: [&str; 6] = [
    "onedrive",
    "dropbox",
    "google drive",
    "googledrive",
    "icloud",
    "com~apple~clouddocs",
];

/// 这个路径看起来是不是云盘同步目录
pub fn looks_like_cloud_sync(path: &Path) -> bool {
    let s = path.to_string_lossy().to_lowercase();
    CLOUD_MARKERS.iter().any(|m| s.contains(m))
}

/// 读指针。`default_dir` 是系统默认位置，指针文件就放在它里面。
pub fn locate(default_dir: &Path) -> Located {
    let pointer = default_dir.join(POINTER_FILE);
    let text = match std::fs::read_to_string(&pointer) {
        Ok(t) => t,
        Err(_) => return Located::Default(default_dir.to_path_buf()),
    };
    let parsed: Pointer = match serde_json::from_str(&text) {
        Ok(p) => p,
        Err(e) => {
            // 指针文件读不懂：这时回落是安全的，因为我们**不知道**用户选过哪里，
            // 而且真有自定义目录的话下面 Missing 那条分支才是它该走的路。
            log::warn!("{POINTER_FILE} 解析失败（{e}），改用默认数据目录");
            return Located::Default(default_dir.to_path_buf());
        }
    };
    let dir = PathBuf::from(parsed.data_dir.trim());
    if dir.as_os_str().is_empty() {
        return Located::Default(default_dir.to_path_buf());
    }
    match probe_writable(&dir) {
        Ok(()) => Located::Custom(dir),
        Err(reason) => Located::Missing {
            configured: dir,
            reason,
        },
    }
}

/// 目录存在、可写吗。返回 Err(人话原因)。
pub fn probe_writable(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Err("目录不存在（盘没挂上？或被删了）".into());
    }
    if !dir.is_dir() {
        return Err("这个路径不是目录".into());
    }
    let probe = dir.join(".bianfa-write-probe");
    match std::fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => Err(format!("目录不可写：{e}")),
    }
}

/// 写指针文件。传 `None` 表示切回系统默认目录（删掉指针）。
pub fn write_pointer(default_dir: &Path, data_dir: Option<&Path>) -> std::io::Result<()> {
    let pointer = default_dir.join(POINTER_FILE);
    match data_dir {
        None => match std::fs::remove_file(&pointer) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        },
        Some(dir) => {
            std::fs::create_dir_all(default_dir)?;
            let body = serde_json::to_string_pretty(&Pointer {
                data_dir: dir.to_string_lossy().into_owned(),
            })
            .unwrap_or_else(|_| "{}".into());
            std::fs::write(&pointer, body)
        }
    }
}

/// 目标目录能不能作为新的数据目录。检查顺序是从「一定不行」到「大概率出事」。
pub fn validate_target(current: &Path, target: &Path) -> Result<(), String> {
    if target == current {
        return Err("新位置和当前位置是同一个目录".into());
    }
    // 互相嵌套会让复制变成无限递归，或者搬完把源目录一起端走
    if target.starts_with(current) {
        return Err("新位置在当前数据目录里面".into());
    }
    if current.starts_with(target) {
        return Err("新位置包含当前数据目录".into());
    }
    if looks_like_cloud_sync(target) {
        return Err(
            "这个位置看起来在云盘同步目录里（OneDrive / iCloud / Dropbox / Google Drive）。\
             云盘同步 SQLite 的 WAL 文件是数据库损坏的头号原因，请换一个不被云盘同步的目录。"
                .into(),
        );
    }
    probe_writable(target)?;
    // 非空目录不是硬错误，但里面已经有一份数据的话，搬过去会覆盖
    if target.join(crate::db::DB_FILE).exists() {
        return Err("这个目录里已经有一份 bianfa 数据了，请换一个空目录".into());
    }
    Ok(())
}

/// 递归复制目录。**先复制、验证、写指针，最后才删源**——中途断电最多留下一份多余的拷贝，
/// 而不是把唯一一份数据搬丢。
pub fn copy_tree(from: &Path, to: &Path) -> std::io::Result<u64> {
    let mut bytes = 0u64;
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        let src = entry.path();
        let dst = to.join(&name);
        let ft = entry.file_type()?;
        if ft.is_dir() {
            bytes += copy_tree(&src, &dst)?;
        } else if ft.is_file() {
            bytes += std::fs::copy(&src, &dst)?;
        }
        // 符号链接直接跳过：跟着走可能把整个盘拷进来
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_sync_dirs_are_rejected() {
        assert!(looks_like_cloud_sync(Path::new(
            r"C:\Users\me\OneDrive\bianfa"
        )));
        assert!(looks_like_cloud_sync(Path::new("/Users/me/Dropbox/bianfa")));
        assert!(looks_like_cloud_sync(Path::new(
            "/Users/me/Library/Mobile Documents/com~apple~CloudDocs/x"
        )));
        assert!(!looks_like_cloud_sync(Path::new(r"D:\bianfa")));
        assert!(!looks_like_cloud_sync(Path::new("/data/bianfa")));
    }

    #[test]
    fn nested_targets_are_rejected() {
        let cur = Path::new("/data/bianfa");
        assert!(validate_target(cur, Path::new("/data/bianfa")).is_err());
        assert!(validate_target(cur, Path::new("/data/bianfa/sub")).is_err());
        assert!(validate_target(cur, Path::new("/data")).is_err());
    }

    #[test]
    fn missing_target_is_not_a_silent_fallback() {
        let tmp = std::env::temp_dir().join(format!("bianfa-loc-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        write_pointer(&tmp, Some(Path::new("/definitely/not/here"))).unwrap();
        match locate(&tmp) {
            Located::Missing { configured, .. } => {
                assert_eq!(configured, PathBuf::from("/definitely/not/here"));
            }
            other => panic!("盘不在时必须报 Missing，不能回落：{other:?}"),
        }
        // 删掉指针 → 回默认
        write_pointer(&tmp, None).unwrap();
        assert_eq!(locate(&tmp), Located::Default(tmp.clone()));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn pointer_roundtrips_a_real_dir() {
        let tmp = std::env::temp_dir().join(format!("bianfa-loc2-{}", std::process::id()));
        let target = tmp.join("target");
        std::fs::create_dir_all(&target).unwrap();
        write_pointer(&tmp, Some(&target)).unwrap();
        assert_eq!(locate(&tmp), Located::Custom(target.clone()));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
