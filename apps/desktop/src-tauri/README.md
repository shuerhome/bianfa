# bianfa 桌面端 · Rust 壳（`apps/desktop/src-tauri`）

Tauri 2.11.5 壳层。Yjs 语义全部在 WebView（`@bianfa/shared`），Rust 只存字节、管窗口、管密钥、做系统集成。IPC 契约见 `specs/07-ipc-contract.md`（含 03-sync 修订）。

## 模块地图

| 路径 | 职责 |
|---|---|
| `src/error.rs` | `IpcError { code, message, details? }`；code ∈ `db / keyring / io / network / auth / not_found / invalid / unsupported / internal` |
| `src/model.rs` | 与 07 §1 对齐的 DTO（camelCase）：`NoteProjection`、`NoteListItem`、`NoteRecord`、`WindowState`、`Settings`、`AppInfo`、`AuthStatus`、`AttachmentUploadResult`… |
| `src/api.rs` | 服务端线格式（snake_case / ISO / `server_time`）的 serde 形状与到 IPC DTO 的映射：`TokenResponse`、`OAuthError`（含双语提示）、`DeviceCodeResponse`、`MeResponse → AuthStatus`、`ClaimResponse`、`SyncTokenResponse`、`PresignResponse` / `CommitResponse`；路径常量 `api::paths`；宿主单测用服务端集成测试里的 JSON |
| `src/colors.rs` | 10 色枚举；`paper`/`dot` 取自 `packages/tokens/dist/tokens.rs`（`include!`） |
| `src/db/` | SQLCipher 本地库：`schema.rs`（DDL，`user_version=2`，`MIGRATIONS` 只追加不改旧版）、`notes.rs`（列表/检索/创建/追加/快照/压缩/回收站）、`checklist.rs`（`checklist_items`：投影里 `checklist` 的本地镜像，随 `write_projection` 重建、随便笺删除/清空；`todos_list` / `todos_counts` 数据源）、`window_state.rs`、`versions.rs`（daily / shrink_guard / manual）、`sync_state.rs`、`attachments.rs`、`imports.rs`；`mod.rs` 负责开库（keyring 密钥、WAL、`integrity_check`、`user_version` 门禁）、逐版迁移、每日 `VACUUM INTO backups/`（保留 14 份）、`meta.rev` |
| `src/import/` | Windows 便笺导入：`plum.rs`（三件套复制后 `?mode=ro` 打开，按列名取值）、`snt.rs`（`cfb`，stream `3` UTF‑16 / stream `0` RTF）、`text.rs`（ticks、`WindowPosition`、私有 `Text` 格式、`LastServerVersion`） |
| `src/app/mod.rs` | Tauri Builder：single-instance（第一个插件）→ global-shortcut / autostart / updater / notification / dialog / opener / deep-link；`bianfa-att` 协议；启动序列；深链；退出收尾；「注销并删除本机数据」 |
| `src/app/state.rs` | `AppState`（DB 互斥锁、设置、窗口注册表、auth、HTTP client…）；文件日志 `logs/bianfa.log` |
| `src/app/windows/` | 窗口模型：`note-<uuid>` / 预热窗 `note-pool-<n>` / `main` / `settings` / `login` / 隐藏 `sync`；几何持久化与越界夹回；折叠；显示/隐藏全部（隐藏 10 min 自动 `close()`）；`pin.rs` 三档层级分发 |
| `src/app/windows/pin_windows.rs` | 贴桌面（Windows，方案 B） |
| `src/app/windows/pin_macos.rs` | 贴桌面 / 置顶（macOS） |
| `src/app/tray.rs` | 托盘与菜单（中/英随设置）；同步状态行；快捷键被占用 / 便笺过多 / 有更新 的警示行 |
| `src/app/hotkey.rs` | 唯一全局热键 `Ctrl+Alt+N` / `⌥⌘N` |
| `src/app/auth.rs` | loopback + PKCE 登录、设备码降级（`/api/auth/device/code` → 轮询 `/api/auth/oauth2/token` device_code grant）、刷新（单飞锁）、`POST /v1/claim` → `GET /v1/me` 派生 `AuthStatus`、`/oauth2/revoke` 登出、`api_request` 代理、`/v1/sync/token`；token 只在 keyring / 内存；403 `device_limit_reached` → `auth:login-progress {phase:'failed', message}` 双语提示。契约见 `docs/desktop-server-contract.md` |
| `src/app/attachments.rs` | 附件落盘（BLAKE3 去重、长边 >2560 缩放、blurhash）与 `bianfa-att://localhost/<id>` 协议；`attachment_upload`：`POST /v1/attachments/presign` → `PUT` R2 → `POST /v1/attachments/commit`（WebView 无网络，只有 Rust 能传） |
| `src/app/updater.rs` | `X-Bianfa-Install-Id` / `X-Bianfa-Channel` 头；启动后 30 s + 每小时检查 |
| `src/app/notices.rs` | `/v1/notice` Ed25519 验签（占位公钥时整体禁用） |
| `src/app/commands/` | 全部 `#[tauri::command]`，按 notes / windows / system / auth / files 分组 |

## 贴桌面怎么做的

**Windows**（`pin_windows.rs`）：绝不 `SetParent` 到 WorkerW。便笺始终是顶层窗口，进入贴桌面时加 `WS_EX_TOOLWINDOW`（不加 `WS_EX_NOACTIVATE`）并用 `SetWindowPos(HWND_BOTTOM, …NOACTIVATE|NOOWNERZORDER|NOSENDCHANGING)` 沉底。启动时在主线程建一个隐藏探针窗 `BianfaZProbe` 沉到最底，注册 `EVENT_SYSTEM_FOREGROUND` WinEvent hook：前台切换时若 `FindWindowExW(None, host, "BianfaZProbe")` 能在桌面宿主之后找到探针，说明 Win+D / 显示桌面把宿主提到了探针之上 → 所有贴桌面窗临时 `HWND_TOPMOST`；反向则去 TOPMOST 并重新沉底。宿主 = 24H2+（`GetProcAddress(user32,"GetCurrentMonitorTopologyId")` 存在）用 `GetShellWindow()`，否则找承载 `SHELLDLL_DefView` 的 WorkerW；Explorer 重启（`TaskbarCreated`）重解析。状态机 Docked → 用户点击 Editing（不对抗）→ 失焦 200 ms 后沉底；3 s 定时器把被顶起的窗口重新沉底；会话解锁 / 电源恢复也全部重沉。

**macOS**（`pin_macos.rs`）：`CGWindowLevelForKey(kCGDesktopIconWindowLevelKey=18)+1` 运行时取值，`setLevel` + `setCollectionBehavior(CanJoinAllSpaces|Stationary|IgnoresCycle)`；置顶为 `NSFloatingWindowLevel(3)` + `CanJoinAllSpaces|Stationary|FullScreenAuxiliary`。`desktopPinReadonly=true` 时（macOS 默认）前端调 `note_window_desktop_edit { editing:true }` 临时升到普通层编辑，失焦自动放回。

Linux：`zMode=2` 返回 `code:"unsupported"`。

## 构建 / 检查

- `rust-toolchain.toml` 钉 **1.98.1**（`yrs 0.27.4` 使用 `if let` guard，1.94 编不过）。
- Cargo feature：`app`（默认，Tauri 壳）、`vendored-openssl`（SQLCipher 自带 OpenSSL；`tauri.conf.json` 的 `build.features` 已开启，所以 `pnpm tauri build/dev` 自动带上）。
- 本机单元测试（Linux 无 webkit）：`cargo test --no-default-features`。
- 交叉 `cargo check --target x86_64-pc-windows-msvc` / `aarch64-apple-darwin`：需要一个能为目标产出空目标文件的 C 工具链垫片（`libsqlite3-sys`、`ring`、`objc2-exception-helper` 的 build script 会调 cc）。
- 首次 `cargo check` 需要 `apps/desktop/dist/` 存在（`generate_context!` 嵌入前端产物）。

## 尚未实现 / 简化

- 附件重编码为 WebP q82：`image` crate 只有无损 WebP，目前 ≤2560 保留原格式，超出按 PNG/JPEG 重编码。
- 公告防重放（`last_notice_issued_at`）未做；公告公钥为占位 → 功能整体关闭。
- macOS `SMAppService` 自启未做，直接用插件 LaunchAgent。
- 托盘「最近 3 张」子项、Windows Jump List、macOS `⌥+左键` 新建未做。
- 设置 `uiScale` 变更不会实时改已开窗口的尺寸约束（下次打开生效）。
- `ydoc_snapshots.is_daily` 恒为 0：每日历史由 `ydoc_versions(label='daily')` 承担。
