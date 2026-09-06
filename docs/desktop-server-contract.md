# 桌面端 ⇄ 服务端契约（对齐 `apps/server` 最终实现）

> 服务端是事实来源；本文只记录桌面端（`apps/desktop/src-tauri` Rust 壳 + WebView）实际调用的部分。
> 线格式：**snake_case**、ISO‑8601 时间、每个 JSON 响应带 `server_time`（Unix ms）；错误统一 `{ error: <code>, ...extra, request_id?, server_time }`。
> 桌面端只在两个地方转成 camelCase：Rust `src/api.rs`（→ IPC DTO）与前端 `src/api/*.ts`（→ UI 类型）。

## 1. 谁发请求

| 发起方 | 说明 |
|---|---|
| Rust（reqwest） | `/api/auth/*` 全部、`/v1/claim`、`/v1/me`（登录后派生 `AuthStatus`）、`/v1/sync/token`、`/v1/notice`、附件 `presign → PUT R2 → commit`。token 只在 keyring / 内存。 |
| WebView（经 IPC `api_request`） | 其余 `/v1/*`：Rust 注入 `Authorization: Bearer <access>`，401 自动刷新一次重试；`path` 必须以 `/v1/` 开头；请求头附 `X-Bianfa-Device-Id`、`X-Bianfa-App-Version`。 |

## 2. 登录流程

公共常量：`client_id = bianfa-desktop`，`scope = openid profile email offline_access`。
所有 grant 都在 **`POST /api/auth/oauth2/token`**（`application/x-www-form-urlencoded`）换 token，并附桌面字段
`device_id`（UUID v7，keyring 持久化）、`device_name`、`platform ∈ windows|macos|linux`、`app_version`。
响应 `{ access_token: "bfa_…", refresh_token: "bfr_…", token_type: "Bearer", expires_in: 900, scope }`——**不透明 token，没有 `id_token`**。
失败 `{ error, error_description?, limit? }`。

### 2.1 主路径：loopback + PKCE
1. Rust 生成 `verifier`/`S256 challenge`/`state`，绑 `127.0.0.1:0`，浏览器打开
   `GET /api/auth/oauth2/authorize?client_id&redirect_uri=http://127.0.0.1:<port>/cb&response_type=code&code_challenge&code_challenge_method=S256&state&scope`。
2. 回调只接受一次 `state` 匹配的 `/cb?code=…`（20 s 提示复制链接、60 s 提示设备码、120 s 失败）。
3. `POST /oauth2/token`：`grant_type=authorization_code, code, code_verifier, client_id, redirect_uri` + 桌面字段。

### 2.2 降级：Device Authorization（RFC 8628）
1. `POST /api/auth/device/code`（JSON `{ client_id, scope }`）→ `{ device_code, user_code(8 位), verification_uri, verification_uri_complete, expires_in: 1800, interval: 5 }`。
2. 用户在浏览器 `verification_uri`（Web `/device` 页）输入 `user_code` 并 approve。
3. 每 `interval` 秒 `POST /api/auth/oauth2/token`：`grant_type=urn:ietf:params:oauth:grant-type:device_code, device_code, client_id` + 桌面字段
   （**不是** `/api/auth/device/token`，那个只发 Better Auth 会话 token）。
   - `authorization_pending` → 继续；`slow_down` → interval +5 s；`expired_token` / `access_denied` → 结束并 `auth:login-progress {phase:'failed', message}`。

### 2.3 设备上限
Free 计划最多 2 台活跃设备：第 3 台换 token 得到 **403 `{ error: "device_limit_reached", error_description, limit: 2 }`**，服务端已作废刚签发的 token。
桌面端发 `auth:login-progress { phase: 'failed', message: <中英双语> }`，设置页「账号」显示该说明；用户可在设备列表注销一台后重试。

### 2.4 登录成功后
1. `POST /v1/claim { local_user_id: <install_id, UUID> }` → `{ personal_workspace_id, claimed_before }`（幂等；`409 claimed_by_other` 视为永久，不再重试）。`profile.json` 记录 `claimedLocalUserId/claimedUserId`，启动刷新时不重复。
2. `GET /v1/me` → 派生 `AuthStatus`：
   `user = { id, email, name, image }`，`personalWorkspaceId = personal_workspace_id`，
   `activeOrganizationId = orgs 中第一个 status=active（否则第一个）的 id`，`plan`。
3. 事件 `auth:changed`（`AuthStatus`，无 token）+ `auth:login-progress {phase:'done'}`；创建隐藏 `sync` 窗。

### 2.5 刷新 / 登出
- 刷新：`POST /oauth2/token grant_type=refresh_token, refresh_token, client_id` + 桌面字段（单飞锁）；`400 invalid_grant` → 删 keyring、退回本地模式、`auth:changed`。
- 登出：`POST /api/auth/oauth2/revoke`（form）`token=<refresh>, token_type_hint=refresh_token, client_id` → 服务端标记 `device.revoked_at` 并 NOTIFY；本地删 keyring `refresh_token`、清内存 access、删 `profile.json`、销毁 sync 窗。**不删本机便笺。**

## 3. `/v1` 端点（桌面端使用的）

| 端点 | 请求 | 响应（关键字段） | 桌面端 |
|---|---|---|---|
| `GET /v1/me` | — | `user{id,name,email,email_verified,image,created_at,ai_opt_in,two_factor_enabled}`, `plan`, `personal_workspace_id`, `orgs[]{id,name,slug,plan,enterprise_mode,role,status,joined_at}`, `active_devices`, `current_device_id`, `deletion_due_at` | Rust `api::MeResponse`；前端 `api/me.ts fetchMe` |
| `GET /v1/me/devices` | — | `devices[]{id,name,platform,app_version,last_ip,last_seen_at,created_at,revoked_at,current}` | 设置 → 账号 设备列表 |
| `DELETE /v1/me/devices/:id` | — | `{ revoked: true, device_id }` | 逐个注销 |
| `POST /v1/me/devices/revoke-all` | `{ keep_current?: bool }` | `{ revoked: string[], count }` | 「注销其他所有设备」（`keep_current: true`） |
| `POST /v1/me/delete` | `{ confirm: "DELETE" }` | 202 `{ deletion_due_at }`；409 `transfer_ownership_first {org_id}` | 删除账号（随后本地 `auth_logout`） |
| `POST /v1/me/delete/cancel` | — | `{ deletion_due_at: null }`；409 `not_scheduled` | 取消删除 |
| `GET /v1/orgs` | — | `orgs[]{id,name,slug,logo,plan,enterprise_mode,created_at,role,status}` | `api/me.ts listOrgs` |
| `POST /v1/claim` | `{ local_user_id }` | `{ personal_workspace_id, claimed_before }` | Rust，见 §2.4 |
| `POST /v1/sync/token` | `{ max_schema_version? }` | `{ token, expires_in: 60, expires_at(ms) }`（30/min/device） | Rust `auth_sync_token` → `{ token, expiresAt(ms) }` |
| `GET /v1/workspaces` | — | `workspaces[]{id,kind,org_id,team_id,owner_user_id,name,default_note_perm,effective_perm,created_at,archived_at}` | `api/workspaces.ts` |
| `GET /v1/notes?workspace_id&since_version&limit(≤500)` | query | `{ workspace_id, effective_perm, notes[], next_version, has_more }`（含墓碑，`version` = lsn 水位） | sync host 发现（union，永不本地删除；按 `has_more` 翻页，`since = next_version`） |
| `GET /v1/workspaces/:id/notes?since_version&limit` | query | 同上（别名） | 团队墙：org 下未归档 team 工作区逐个拉（**没有** `/v1/orgs/:id/notes`） |
| `GET /v1/notes/:id` / `POST /v1/notes` / `POST /v1/notes/:id/move` | `{ id, workspace_id, client_id?, color?, z_mode?, expires_at? }` | `{ note: noteMetaDto }` | `api/notes.ts`（兜底用） |
| `GET/PUT /v1/notes/:id/shares`, `DELETE …/shares/:sid`, `GET /v1/shared-with-me?cursor&limit` | PUT `{ grantee_kind:"user", grantee_id \| email, permission, expires_at? }` | `{ share }` / `{ items[], next_cursor }` | `api/shares.ts` |
| `GET /v1/notifications?cursor&limit&unread`, `POST /v1/notifications/read` | `{ ids[] } \| { all: true }` | `{ notifications[], unread_count, next_cursor }` / `{ updated }` | `api/notifications.ts` |
| `POST /v1/attachments/presign` | `{ attachment_id, workspace_id, hash(BLAKE3 hex), size, mime, width?, height?, blurhash? }` | `{ exists:true, attachment_id }` 或 `{ exists:false, attachment_id, upload_url, method:"PUT", headers, expires_in }`；503 `attachments_disabled`；409 `quota_exceeded` | Rust `attachment_upload` |
| `PUT <upload_url>` | 原始字节 + presign 给的 `headers`（Content‑Length 由 reqwest 生成） | 2xx | Rust |
| `POST /v1/attachments/commit` | `{ attachment_id }` | `{ attachment_id, status:"committed", committed_at }`；409 `object_missing` / `size_mismatch`；400 `invalid_image` | Rust |
| `GET /v1/attachments/:id/url?note_id` | query | `{ url, mime, expires_in: 300 }` | `api/attachments.ts` |
| `POST /v1/me/export` | `{ scope?: "user" }` | 202 `{ job_id, status:"queued" }`；429 `export_rate_limited { job_id, status, retry_after }` | 设置 → 账号「云端数据导出」 |
| `GET /v1/me/export/:job_id` | — | `{ job{id,status,byte_size,error,expires_at,created_at,finished_at,download_url} }` | 同上（`download_url` 用系统浏览器打开） |
| `GET /v1/notice` | 匿名 | 204 或 `{ v:1, payload(base64url JSON), sig }` | Rust `notices.rs` 验签；公告 payload 是 `{ id, action:"notice"\|"block", platforms, affected_versions, title, body, url, issued_at, expires_at }` |
| `POST /v1/telemetry` | `{ install_id(UUIDv4), app_version?, platform?, counters{…} }` | 204 | （预留，Rust） |

错误码桌面端专门处理：`426` → 前端 `upgrade_required`（sync host 暂停）；`401` → Rust 刷新一次；`device_limit_reached`、`quota_exceeded`、`attachments_disabled`、`export_rate_limited`、`transfer_ownership_first`（`src/api/http.ts API_ERROR`）。

## 4. IPC：在 specs/07 之外新增 / 修订的部分

| Command / 事件 | 形状 | 说明 |
|---|---|---|
| `auth_status` → `AuthStatus` | `+ plan: string \| null` | 由 `/v1/me` 派生 |
| `auth_login_device_start` | 不变 | 内部改为轮询 `/oauth2/token`（§2.2） |
| `auth_sync_token` | `{ token, expiresAt }` | `expiresAt` = 服务端 `expires_at`（Unix **ms**） |
| `attachment_upload { id }` | `{ attachmentId, remoteAttachmentId, status: "committed"\|"local"\|"unsupported"\|"disabled" }` | 未登录 → `local`；非图片 → `unsupported`；服务端未配 R2 → `disabled`；配额等 → 抛 `IpcError(code = 服务端 error)` |
| `attachments_pending_upload {}` | `string[]` | `upload_state='local'` 的附件 id；sync host 在登录 / 重连后补传 |
| `attachment_import` | 不变 | 现在会发 `db:changed { tables: ["attachments","note_attachments"], ids: [<attachment id>] }`（注意 ids 是附件 id） |
| `import_preview` | `{ notes: PlumExportNote & { created_at_ms, updated_at_ms }, archivedTo }` | Python 导出器的 snake_case 形状 + Rust 解析好的毫秒时间 |
| 事件 `auth:login-progress` | `{ phase, message?: string \| null }` | `failed` 时附双语说明（设备上限 / 验证码过期 / 拒绝） |
| 事件 `notice` / `notice_get` | `{ id, issuedAt, expiresAt, action, platforms, affectedVersions, title, body, url }` | 与 Rust `Notice` 一致（原前端类型里的 `severity/min_version_affected` 已废弃） |
| `note_create` | 返回 `NoteRecord`（含 `headSeq`） | 无变化，仅确认 |

## 5. 已知的服务端待议项（桌面端已按现状兼容）
- `POST /v1/attachments/presign` 去重命中时返回**已存在的另一个** `attachment_id`，而便笺正文引用的是本地 id → 其他设备 `GET /v1/attachments/<本地 id>/url` 会 404。桌面端把本地行标为 `committed` 并保留 `remoteAttachmentId`，但正文引用未改写。
- `/v1/me` 没有返回 `active_organization_id`；桌面端用「第一个 active 成员身份」代替。
