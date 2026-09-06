// =============================================================================
// requireOrgRole（规格 04 §5.1 / §5.3 / §5.4）
// -----------------------------------------------------------------------------
// * org 来自 `X-Organization-Id` 头（桌面端多 org，不依赖 session.activeOrganizationId）；缺失 → 400 no_active_organization。
// * member 查询走 30 s 进程内缓存 `${userId}:${orgId}`（值含 role/status/session_epoch）；本进程的写路径调 invalidateMemberCache。
// * 非成员 / 已移除 / org 已软删 → 404 not_found（不泄露 org 是否存在）；suspended → 403 member_suspended；
//   角色不够 → 403 insufficient_role + required:{resource:'org',action} 并写 authz.denied 审计。
// * 成功后 c.var.org = { orgId, role, status, sessionEpoch }。
// =============================================================================
import { and, eq, isNull } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { audit } from "../audit/index.js";
import { type Db, getDb, withUserTx } from "../db/client.js";
import { member, organization } from "../db/schema/index.js";
import { fail, requestMeta } from "./http.js";
import type { AuthVariables } from "./index.js";

export type OrgRole = "owner" | "admin" | "member";
export type MemberStatus = "active" | "suspended" | "removed";

export interface OrgContext {
  orgId: string;
  role: OrgRole;
  status: MemberStatus;
  sessionEpoch: number;
}

export type OrgVariables = { org: OrgContext };

export const ORG_HEADER = "x-organization-id";
export const MEMBER_CACHE_TTL_MS = 30_000;
export const ROLE_RANK: Readonly<Record<OrgRole, number>> = { member: 1, admin: 2, owner: 3 };

export function isOrgRole(v: unknown): v is OrgRole {
  return v === "owner" || v === "admin" || v === "member";
}

export function roleAtLeast(role: OrgRole, need: OrgRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[need];
}

interface CacheEntry {
  value: OrgContext | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(userId: string, orgId: string): string {
  return `${userId}:${orgId}`;
}

/** 写路径调用：只给 userId → 清该用户全部；都给 → 清一条；都不给 → 全清 */
export function invalidateMemberCache(userId?: string, orgId?: string): void {
  if (userId && orgId) {
    cache.delete(cacheKey(userId, orgId));
    return;
  }
  if (!userId) {
    cache.clear();
    return;
  }
  const prefix = `${userId}:`;
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

/** 清某个 org 的全部缓存项（org 删除 / 转让） */
export function invalidateOrgCache(orgId: string): void {
  const suffix = `:${orgId}`;
  for (const k of cache.keys()) if (k.endsWith(suffix)) cache.delete(k);
}

export function memberCacheSize(): number {
  return cache.size;
}

/** 直接查库（不走缓存）：org 未软删且 member 行存在时返回；否则 null */
export async function lookupMember(db: Db, userId: string, orgId: string): Promise<OrgContext | null> {
  const rows = await db
    .select({
      role: member.role,
      status: member.status,
      sessionEpoch: member.sessionEpoch,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId), isNull(organization.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (!row || !isOrgRole(row.role)) return null;
  const status = row.status as MemberStatus;
  return { orgId, role: row.role, status, sessionEpoch: row.sessionEpoch };
}

export async function getMemberCached(
  db: Db,
  userId: string,
  orgId: string,
  now = Date.now(),
): Promise<OrgContext | null> {
  const key = cacheKey(userId, orgId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = await lookupMember(db, userId, orgId);
  cache.set(key, { value, expiresAt: now + MEMBER_CACHE_TTL_MS });
  return value;
}

export interface RequireOrgRoleOptions {
  /** 缺省 getDb()（进程级连接池） */
  db?: Db;
}

const ORG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function requireOrgRole(
  need: OrgRole,
  opts: RequireOrgRoleOptions = {},
): MiddlewareHandler<{ Variables: AuthVariables & OrgVariables }> {
  return async (c, next) => {
    const auth = c.get("auth");
    const orgId = c.req.header(ORG_HEADER)?.trim() ?? "";
    if (!orgId || !ORG_ID_RE.test(orgId)) return fail(c, 400, "no_active_organization");
    const db = opts.db ?? getDb();
    const ctx = await getMemberCached(db, auth.userId, orgId);
    if (!ctx || ctx.status === "removed") return fail(c, 404, "not_found");
    if (ctx.status === "suspended") {
      await auditDenied(db, c, auth.userId, orgId, need, "member_suspended");
      return fail(c, 403, "member_suspended");
    }
    if (!roleAtLeast(ctx.role, need)) {
      await auditDenied(db, c, auth.userId, orgId, need, "insufficient_role");
      return fail(c, 403, "insufficient_role", { required: { resource: "org", action: need } });
    }
    c.set("org", ctx);
    await next();
  };
}

async function auditDenied(
  db: Db,
  c: Context,
  userId: string,
  orgId: string,
  need: OrgRole,
  reason: string,
): Promise<void> {
  const meta = requestMeta(c);
  try {
    await withUserTx(
      userId,
      (tx) =>
        audit(tx, {
          action: "authz.denied",
          orgId,
          actorId: userId,
          actorIp: meta.ip,
          actorUa: meta.ua,
          requestId: meta.requestId,
          targetType: "org",
          targetId: orgId,
          outcome: "denied",
          metadata: { reason, required: need, path: c.req.path, method: c.req.method },
        }),
      db,
    );
  } catch {
    // 审计失败不应把 403 变成 500
  }
}
