// 平台总管理员管理台的取数层（服务端见 apps/server/src/auth/services/admin.ts 与 routes.ts 的 /v1/admin/*）。
//
// 两条必须记住的边界：
//   ① 真正的鉴权发生在服务端（requireSuperAdmin）。本文件与 pages/admin/* 里所有的「藏起来」都只是体验，
//      不是安全：即使有人手敲 /admin、改前端代码、直接 curl 端点，也一样会被 403 insufficient_role 挡住。
//      所以这里不做任何本地的「我是不是管理员」推断，一律以服务端的应答为准。
//   ② 管理面可以被整面关掉（PLATFORM_ADMIN_ENABLED=0），这时端点回 404 而不是 403 ——
//      「没有权限」与「这个部署根本没有管理面」是两件事，调用方要分开处理（见 gateStateOf）。
//
// 字段名一律与服务端 DTO 逐字对应（snake_case），不做驼峰改写，避免两边漂移时看不出来。
import type { Result } from "./api.js";
import { toFailure } from "./lib/errors.js";

/** /v1 的错误体：{ error, ...extra, server_time } */
interface AdminErrorBody {
  error?: unknown;
  required?: unknown;
}

function queryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "" || v === false) continue;
    q.set(k, v === true ? "1" : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * `/v1/admin/*` 一次请求。
 *
 * 注意：/v1 只认 `Authorization: Bearer`，Web 面持有的是同源 cookie 会话 —— 我们照常把 cookie 带上
 * （credentials: same-origin），能不能通过由服务端决定；拿到 401 时页面会显示「会话无法访问管理接口」
 * 而不是装作没事。前端不去自造令牌：那等于在浏览器里复刻一份桌面端的凭据，得不偿失。
 */
async function adminFetch<T>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<Result<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(`/v1/admin${path}`, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const body = (await res.json().catch(() => ({}))) as AdminErrorBody & Record<string, unknown>;
    if (!res.ok) {
      const code = typeof body.error === "string" ? body.error : `http_${res.status}`;
      return { ok: false, error: { status: res.status, code, message: "" } };
    }
    return { ok: true, data: body as T };
  } catch (err) {
    return { ok: false, error: toFailure(err) };
  }
}

// ─────────────────────────────────────────────────────────── DTO（与服务端 admin.ts 一一对应）

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  created_at: string | null;
  frozen: boolean;
  frozen_at: string | null;
  frozen_reason: string | null;
  deleted: boolean;
  is_platform_admin: boolean;
}

export interface AdminUserPage {
  users: AdminUser[];
  /** 服务端算好的下一页起点；null = 没有下一页 */
  next_offset: number | null;
}

export interface PlatformAdminEntry {
  user_id: string;
  email: string | null;
  name: string | null;
  granted_at: string | null;
  granted_by: string | null;
  note: string | null;
}

export interface AdminUserDetail {
  user: AdminUser;
  frozen_by: string | null;
  organizations: Array<{ id: string; name: string; slug: string; role: string; status: string }>;
  teams: Array<{ id: string; name: string; org_id: string }>;
  devices: Array<{ id: string; name: string | null; platform: string | null; revoked: boolean }>;
  scale: { workspaces: number; notes: number; deleted_notes: number; e2ee_notes: number };
}

export interface AdminWorkspace {
  id: string;
  kind: string;
  name: string;
  org_id: string | null;
  org_name: string | null;
  team_id: string | null;
  team_name: string | null;
  note_count: number;
}

export interface AdminNoteSummary {
  id: string;
  workspace_id: string;
  workspace_name: string;
  created_by: string;
  title: string | null;
  excerpt: string;
  color: string;
  /** false = 服务端拿不到明文（目前只有 E2EE 一种原因） */
  readable: boolean;
  unreadable_reason: "e2ee" | null;
  updated_at: string;
  deleted: boolean;
}

export interface AdminNoteBody {
  id: string;
  workspace_id: string;
  workspace_name: string;
  created_by: string;
  creator_email: string | null;
  color: string;
  created_at: string;
  updated_at: string;
  deleted: boolean;
  readable: boolean;
  unreadable_reason: "e2ee" | null;
  content: Record<string, unknown> | null;
  content_text: string;
}

export interface AdminAuditEntry {
  id: string | number;
  at: string | null;
  actor_id: string | null;
  actor_email: string | null;
  actor_ip: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: string | null;
  metadata: Record<string, unknown> | null;
}

// ─────────────────────────────────────────────────────────── 端点

/** GET /v1/admin/admins —— 同时充当「我是不是总管理员」的探针（见 pages/admin/gate.ts） */
export function fetchPlatformAdmins(): Promise<Result<{ admins: PlatformAdminEntry[] }>> {
  return adminFetch("/admins");
}

export interface ListUsersQuery {
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  frozenOnly?: boolean | undefined;
}

/** GET /v1/admin/users?q=&limit=&offset=&frozen=1 */
export function fetchUsers(input: ListUsersQuery = {}): Promise<Result<AdminUserPage>> {
  return adminFetch(
    `/users${queryString({
      q: input.q ?? null,
      limit: input.limit ?? null,
      offset: input.offset ?? null,
      frozen: input.frozenOnly === true,
    })}`,
  );
}

/** GET /v1/admin/users/:id */
export function fetchUserDetail(userId: string): Promise<Result<AdminUserDetail>> {
  return adminFetch(`/users/${encodeURIComponent(userId)}`);
}

/** GET /v1/admin/users/:id/workspaces —— 目标用户自己能看到的工作区，含其团队工作区 */
export function fetchUserWorkspaces(userId: string): Promise<Result<{ workspaces: AdminWorkspace[] }>> {
  return adminFetch(`/users/${encodeURIComponent(userId)}/workspaces`);
}

export interface ListNotesQuery {
  workspaceId?: string | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  includeDeleted?: boolean | undefined;
}

/** GET /v1/admin/users/:id/notes?workspace_id=&q=&limit=&offset=&include_deleted=1 */
export function fetchUserNotes(
  userId: string,
  input: ListNotesQuery = {},
): Promise<Result<{ notes: AdminNoteSummary[]; next_offset: number | null }>> {
  return adminFetch(
    `/users/${encodeURIComponent(userId)}/notes${queryString({
      workspace_id: input.workspaceId ?? null,
      q: input.q ?? null,
      limit: input.limit ?? null,
      offset: input.offset ?? null,
      include_deleted: input.includeDeleted === true,
    })}`,
  );
}

/** GET /v1/admin/users/:id/notes/:noteId */
export function fetchUserNote(userId: string, noteId: string): Promise<Result<{ note: AdminNoteBody }>> {
  return adminFetch(`/users/${encodeURIComponent(userId)}/notes/${encodeURIComponent(noteId)}`);
}

/** POST /v1/admin/users/:id/freeze { reason? } —— 会吊销该用户全部设备令牌并断开同步连接 */
export function freezeUser(
  userId: string,
  reason: string | null,
): Promise<Result<{ ok: true; revoked_devices: number }>> {
  return adminFetch(`/users/${encodeURIComponent(userId)}/freeze`, {
    method: "POST",
    body: reason ? { reason } : {},
  });
}

/** POST /v1/admin/users/:id/unfreeze */
export function unfreezeUser(userId: string): Promise<Result<{ ok: true }>> {
  return adminFetch(`/users/${encodeURIComponent(userId)}/unfreeze`, { method: "POST", body: {} });
}

/** POST /v1/admin/users/:id/password { new_password } —— 同样吊销全部令牌与会话 */
export function setUserPassword(
  userId: string,
  newPassword: string,
): Promise<Result<{ ok: true; revoked_devices: number }>> {
  return adminFetch(`/users/${encodeURIComponent(userId)}/password`, {
    method: "POST",
    body: { new_password: newPassword },
  });
}

export interface ListAuditQuery {
  limit?: number | undefined;
  offset?: number | undefined;
  userId?: string | undefined;
}

/** GET /v1/admin/audit?limit=&offset=&user_id= */
export function fetchAdminAudit(
  input: ListAuditQuery = {},
): Promise<Result<{ entries: AdminAuditEntry[]; next_offset: number | null }>> {
  return adminFetch(
    `/audit${queryString({
      limit: input.limit ?? null,
      offset: input.offset ?? null,
      user_id: input.userId ?? null,
    })}`,
  );
}
