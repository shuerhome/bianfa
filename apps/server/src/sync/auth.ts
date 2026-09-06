// 认证与授权（规格 03 §1.2–1.4，08 X3/X4/X9）：房间名解析、Origin/路径校验、effective_note_permission 授权、60 s 缓存。
// 授权 SQL 在 withUserTx(userId) 内执行：bianfa_app 受 RLS 约束（看不见的便笺 = 不存在），超级用户（测试）直接算。
import { sql } from "drizzle-orm";
import { type Db, withUserTx } from "../db/client.js";
import { isUuid } from "../db/ids.js";
import type { AuthFailureReason } from "./metrics.js";

export type Perm = "viewer" | "commenter" | "editor" | "manager";
const PERM_RANK: Record<Perm, number> = { viewer: 0, commenter: 1, editor: 2, manager: 3 };

export function permAtLeast(perm: Perm | null, min: Perm): boolean {
  return perm !== null && PERM_RANK[perm] >= PERM_RANK[min];
}

export type DocumentRef =
  | { kind: "note"; name: string; workspaceId: string; noteId: string }
  | { kind: "inbox"; name: string; workspaceId: string; noteId: null };

/** `note:<workspace_id>:<note_id>` 或 `inbox:<workspace_id>`（小写 uuid）；不符 → null（调用方拒绝，不回退默认文档） */
export function parseDocumentName(name: string): DocumentRef | null {
  const parts = name.split(":");
  if (parts[0] === "note" && parts.length === 3) {
    const [, workspaceId, noteId] = parts as [string, string, string];
    if (!isUuid(workspaceId) || !isUuid(noteId)) return null;
    return { kind: "note", name, workspaceId, noteId };
  }
  if (parts[0] === "inbox" && parts.length === 2) {
    const workspaceId = parts[1] as string;
    if (!isUuid(workspaceId)) return null;
    return { kind: "inbox", name, workspaceId, noteId: null };
  }
  return null;
}

export function noteDocumentName(workspaceId: string, noteId: string): string {
  return `note:${workspaceId}:${noteId}`;
}

export function inboxDocumentName(workspaceId: string): string {
  return `inbox:${workspaceId}`;
}

/** WebSocket 升级只接受 `/`（本地测试）与 `/ws` `/ws/*`（08 X2；Caddy 只转 /ws/*） */
export function isAllowedPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/ws" || pathname.startsWith("/ws/");
}

/**
 * Origin 校验（规格 03 §1.1、08 X12）：allowed 为 null = 未配置，一律放行；
 * 无 Origin 头（桌面 Rust/Tauri 侧）放行；有头则必须在名单内（不接受浏览器的 "null" 不透明源）。
 */
export function checkOrigin(origin: string | null | undefined, allowed: ReadonlySet<string> | null): boolean {
  if (!allowed) return true;
  if (origin === undefined || origin === null || origin === "") return true;
  const normalized = origin.trim().toLowerCase().replace(/\/+$/, "");
  if (normalized === "null") return false;
  return allowed.has(normalized);
}

/**
 * 认证 / 授权失败：Hocuspocus 4.6 的 ClientConnection 把 `err.reason` 写进 PermissionDenied 帧
 * （provider 侧 onAuthenticationFailed({reason})），`code` 用于关闭帧。
 */
export class SyncAuthError extends Error {
  readonly code: number;
  constructor(
    readonly reason: AuthFailureReason | "too_many_documents",
    readonly detail: string,
    code?: number,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "SyncAuthError";
    this.code = code ?? (reason === "gone" ? 4410 : reason === "too_many_documents" ? 4429 : 4403);
  }
}

export interface AuthzDecision {
  ok: true;
  perm: Perm;
  /** viewer/commenter 或 msv < schema_version 或 inbox 房间 → 只读 */
  readOnly: boolean;
  /** 便笺行不存在但工作区级授权通过：onLoadDocument 建行 */
  createIfMissing: boolean;
  schemaVersion: number;
}

export interface AuthzDenied {
  ok: false;
  reason: "forbidden" | "gone";
  detail: string;
}

export type AuthzResult = AuthzDecision | AuthzDenied;

interface NoteRow {
  perm: Perm | null;
  exists: boolean;
  workspaceId: string | null;
  schemaVersion: number;
  gone: boolean;
}

/** 便笺级：effective_note_permission + 行状态（一条 SQL） */
async function queryNote(db: Db, userId: string, noteId: string): Promise<NoteRow> {
  return withUserTx(
    userId,
    async (tx) => {
      const r = await tx.execute<{
        perm: Perm | null;
        note_exists: boolean;
        workspace_id: string | null;
        schema_version: number | null;
        gone: boolean | null;
      }>(sql`
        SELECT effective_note_permission(${userId}, ${noteId}::uuid)::text AS perm,
               n.id IS NOT NULL AS note_exists,
               n.workspace_id::text AS workspace_id,
               n.schema_version,
               (n.purged_at IS NOT NULL OR (n.purge_after IS NOT NULL AND n.purge_after < now())) AS gone
          FROM (SELECT 1) AS one
          LEFT JOIN notes n ON n.id = ${noteId}::uuid`);
      const row = r.rows[0];
      return {
        perm: row?.perm ?? null,
        exists: row?.note_exists ?? false,
        workspaceId: row?.workspace_id ?? null,
        schemaVersion: row?.schema_version ?? 1,
        gone: row?.gone ?? false,
      };
    },
    db,
  );
}

/**
 * 工作区级权限（03 §1.4 裁定；对应 effective_note_permission 的 workspace 分支）：
 * 个人 workspace owner → manager；org owner/admin → manager；team 成员（team_id 为空或在 team 内）→ default_note_perm；否则 null。
 */
export async function queryWorkspacePerm(db: Db, userId: string, workspaceId: string): Promise<Perm | null> {
  return withUserTx(
    userId,
    async (tx) => {
      const r = await tx.execute<{ perm: Perm | null }>(sql`
        SELECT CASE
                 WHEN w.owner_user_id = ${userId} THEN 'manager'
                 WHEN w.kind = 'team' AND EXISTS (
                        SELECT 1 FROM member m
                         WHERE m."organizationId" = w.org_id AND m."userId" = ${userId}
                           AND m.status = 'active' AND m.role IN ('owner', 'admin')) THEN 'manager'
                 WHEN w.kind = 'team' AND EXISTS (
                        SELECT 1 FROM member m
                         WHERE m."organizationId" = w.org_id AND m."userId" = ${userId} AND m.status = 'active')
                      AND (w.team_id IS NULL OR EXISTS (
                        SELECT 1 FROM "teamMember" tm WHERE tm."teamId" = w.team_id AND tm."userId" = ${userId}))
                   THEN w.default_note_perm::text
                 ELSE NULL
               END AS perm
          FROM workspaces w
         WHERE w.id = ${workspaceId}::uuid AND w.archived_at IS NULL`);
      return r.rows[0]?.perm ?? null;
    },
    db,
  );
}

export interface AuthorizeOptions {
  /** 客户端 max_schema_version（JWT msv） */
  msv: number;
}

/** 无缓存的完整授权判定（缓存见 AuthzCache） */
export async function authorize(
  db: Db,
  userId: string,
  ref: DocumentRef,
  opts: AuthorizeOptions,
): Promise<AuthzResult> {
  if (ref.kind === "inbox") {
    const perm = await queryWorkspacePerm(db, userId, ref.workspaceId);
    if (!perm) return { ok: false, reason: "forbidden", detail: "no workspace access" };
    return { ok: true, perm, readOnly: true, createIfMissing: false, schemaVersion: 1 };
  }
  const note = await queryNote(db, userId, ref.noteId);
  if (note.exists) {
    if (note.gone) return { ok: false, reason: "gone", detail: "note purged" };
    if (!note.perm) return { ok: false, reason: "forbidden", detail: "no note permission" };
    if (note.workspaceId !== ref.workspaceId) {
      return { ok: false, reason: "forbidden", detail: "workspace mismatch" };
    }
    return {
      ok: true,
      perm: note.perm,
      readOnly: !permAtLeast(note.perm, "editor") || opts.msv < note.schemaVersion,
      createIfMissing: false,
      schemaVersion: note.schemaVersion,
    };
  }
  // 行不存在（离线新建，或 RLS 下不可见）：改查工作区级
  const wsPerm = await queryWorkspacePerm(db, userId, ref.workspaceId);
  if (!permAtLeast(wsPerm, "editor")) {
    return { ok: false, reason: "forbidden", detail: "cannot create note in workspace" };
  }
  return { ok: true, perm: wsPerm as Perm, readOnly: false, createIfMissing: true, schemaVersion: 1 };
}

interface CacheEntry {
  result: AuthzResult;
  at: number;
}

/**
 * 进程内授权缓存（03 §1.4）：key `${userId}:${noteId}`，TTL 60 s；authz_revoked 命中即删；缓存不跨副本。
 * 只缓存已存在便笺的判定（建行路径每次都查，避免建行后继续命中"不存在"）；inbox 不缓存。
 * msv 参与 readOnly 判定，所以缓存的是原始 perm/schemaVersion，readOnly 按每次的 msv 重新算。
 */
export class AuthzCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  static key(userId: string, noteId: string): string {
    return `${userId}:${noteId}`;
  }

  async decide(
    userId: string,
    ref: DocumentRef,
    opts: AuthorizeOptions & { bypass?: boolean },
  ): Promise<AuthzResult> {
    if (ref.kind === "inbox") return authorize(this.db, userId, ref, opts);
    const key = AuthzCache.key(userId, ref.noteId);
    if (!opts.bypass) {
      const hit = this.entries.get(key);
      if (hit && this.now() - hit.at < this.ttlMs) return applyMsv(hit.result, opts.msv);
    }
    const result = await authorize(this.db, userId, ref, opts);
    if (result.ok && result.createIfMissing) {
      this.entries.delete(key);
    } else {
      this.entries.set(key, { result, at: this.now() });
    }
    return result;
  }

  invalidateNote(userId: string, noteId: string): void {
    this.entries.delete(AuthzCache.key(userId, noteId));
  }

  invalidateUser(userId: string): void {
    const prefix = `${userId}:`;
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

function applyMsv(result: AuthzResult, msv: number): AuthzResult {
  if (!result.ok) return result;
  return { ...result, readOnly: !permAtLeast(result.perm, "editor") || msv < result.schemaVersion };
}
