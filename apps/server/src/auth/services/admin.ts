// 平台总管理员的 service 层（迁移 0009）。三件事：改密码、冻结/解冻、只读查看内容。
//
// 「查看所有用户的内容（含其团队内容）」的实现取舍 —— 这是整个特性最关键的一处：
//   不新增 BYPASSRLS 角色、不改任何一条既有 RLS 策略、不新开连接池，
//   而是在一个 **只读事务** 里把 app.user_id 切成目标用户，**重新进入** RLS 再查。
//   好处有三：
//     ① 管理员看到的范围 = 目标用户自己能看到的范围，"包括其团队的内容" 天然成立，不用重写一遍授权逻辑；
//     ② 写路径逐字节没动，RLS 策略一条没改，不存在"顺手把写权限也放开"的风险；
//     ③ SET LOCAL 的语义保证事务结束即恢复，连接池复用不会把身份泄漏给下一个请求。
//   只读事务是第二道保险：即使代码里不小心写了 UPDATE，PostgreSQL 会直接报错而不是改数据。
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { audit } from "../../audit/index.js";
import { type Tx, withUserTx } from "../../db/client.js";
import { platformAdmin } from "../../db/schema/admin.js";
import { member, organization, team, teamMember, user } from "../../db/schema/auth.js";
import { device } from "../../db/schema/device.js";
import { one, rows } from "../../services/db-util.js";
import { notifyAuthzRevoked } from "../db-helpers.js";
import { ApiFailure } from "../http.js";
import { revokeAllUserTokens } from "../oauth-tokens.js";
import { type Actor, actorEntry, type ServiceDeps } from "./context.js";

const MAX_LIMIT = 200;

/** 审计里统一的动作前缀，便于 `GET /v1/admin/audit` 一次捞全 */
export const ADMIN_ACTIONS = [
  "admin.user_frozen",
  "admin.user_unfrozen",
  "admin.password_set",
  "admin.content_viewed",
  "admin.user_listed",
] as const;

/** LIKE 模式里的 % _ \ 要转义，配合 SQL 里的 ESCAPE '\'（转义符本身只能有一个反斜杠） */
function escapeLike(v: string): string {
  return v.replace(/[\\\\%_]/g, (ch) => `\\${ch}`);
}

function clampLimit(v: number | undefined): number {
  if (!v || !Number.isFinite(v)) return 50;
  return Math.min(Math.max(Math.trunc(v), 1), MAX_LIMIT);
}

/**
 * 只读地以目标用户的身份读数据。审计**先于**读取单独落一笔（独立事务），
 * 因为读取事务是只读的，写不进 audit_log；先写也意味着「读失败」同样留痕。
 */
async function adminReadAsUser<T>(
  deps: ServiceDeps,
  actor: Actor,
  targetUserId: string,
  entry: { targetType: string; targetId: string | null; metadata: Record<string, unknown> },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  await deps.db.transaction((tx) =>
    audit(
      tx,
      actorEntry(actor, {
        action: "admin.content_viewed",
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: { ...entry.metadata, subject_user_id: targetUserId },
      }),
    ),
  );
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL transaction_read_only = on`);
    await tx.execute(sql`SELECT set_config('app.user_id', ${targetUserId}, true)`);
    return fn(tx);
  });
}

// ─────────────────────────────────────────────────────────── 找人

export interface ListUsersInput {
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  frozenOnly?: boolean | undefined;
}

export async function listUsers(deps: ServiceDeps, actor: Actor, input: ListUsersInput) {
  const limit = clampLimit(input.limit);
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const needle = input.q?.trim().toLowerCase();
  // "user" 表不受 RLS 约束（规格 02 §1.8：Better Auth 表不加 RLS），直接查即可
  const where = and(
    // LIKE 的通配符要转义，否则搜一个 % 就把全部用户都匹配上（参数化没有注入问题，但语义是错的）
    needle
      ? sql`(lower(${user.email}) LIKE ${`%${escapeLike(needle)}%`} ESCAPE '\\'
             OR lower(${user.name}) LIKE ${`%${escapeLike(needle)}%`} ESCAPE '\\')`
      : undefined,
    input.frozenOnly ? sql`${user.frozenAt} IS NOT NULL` : undefined,
  );
  const list = await deps.db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
      frozenAt: user.frozenAt,
      frozenReason: user.frozenReason,
      banned: user.banned,
      deletedAt: user.deletedAt,
      isAdmin: sql<boolean>`EXISTS (SELECT 1 FROM platform_admin pa WHERE pa.user_id = ${user.id})`,
    })
    .from(user)
    .where(where ?? sql`true`)
    .orderBy(desc(user.createdAt))
    .limit(limit + 1)
    .offset(offset);
  const hasMore = list.length > limit;
  // 翻用户名单也留痕：管理台是低频页面，「谁在什么时候找了谁」正是审计要回答的问题
  await deps.db.transaction((tx) =>
    audit(
      tx,
      actorEntry(actor, {
        action: "admin.user_listed",
        targetType: "user",
        targetId: null,
        metadata: { q: needle ?? null, frozen_only: input.frozenOnly === true, offset, limit },
      }),
    ),
  );
  return {
    users: list.slice(0, limit).map(userDto),
    next_offset: hasMore ? offset + limit : null,
  };
}

function userDto(u: {
  id: string;
  email: string;
  name: string;
  createdAt: Date | null;
  frozenAt: Date | null;
  frozenReason: string | null;
  banned: boolean | null;
  deletedAt: Date | null;
  isAdmin?: boolean;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    created_at: u.createdAt?.toISOString() ?? null,
    frozen: u.frozenAt !== null,
    frozen_at: u.frozenAt?.toISOString() ?? null,
    frozen_reason: u.frozenReason,
    deleted: u.deletedAt !== null,
    is_platform_admin: u.isAdmin === true,
  };
}

// ─────────────────────────────────────────────────────────── 看一个人的全貌

export async function getUserDetail(deps: ServiceDeps, actor: Actor, targetUserId: string) {
  const u = (
    await deps.db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: user.createdAt,
        frozenAt: user.frozenAt,
        frozenBy: user.frozenBy,
        frozenReason: user.frozenReason,
        banned: user.banned,
        deletedAt: user.deletedAt,
        isAdmin: sql<boolean>`EXISTS (SELECT 1 FROM platform_admin pa WHERE pa.user_id = ${user.id})`,
      })
      .from(user)
      .where(eq(user.id, targetUserId))
      .limit(1)
  )[0];
  if (!u) throw new ApiFailure(404, "not_found");

  const orgs = await deps.db
    .select({
      orgId: organization.id,
      orgName: organization.name,
      orgSlug: organization.slug,
      role: member.role,
      status: member.status,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, targetUserId));

  const teams = await deps.db
    .select({ teamId: team.id, teamName: team.name, orgId: team.organizationId })
    .from(teamMember)
    .innerJoin(team, eq(team.id, teamMember.teamId))
    .where(eq(teamMember.userId, targetUserId));

  const devices = await deps.db
    .select({ id: device.id, name: device.name, platform: device.platform, revokedAt: device.revokedAt })
    .from(device)
    .where(eq(device.userId, targetUserId));

  // 内容规模用目标用户自己的视角数，与「管理员能看到什么」保持一致
  const scale = await adminReadAsUser(
    deps,
    actor,
    targetUserId,
    { targetType: "user", targetId: targetUserId, metadata: { view: "detail" } },
    async (tx) =>
      one<{ workspaces: string; notes: string; deleted_notes: string; e2ee_notes: string }>(
        tx,
        sql`SELECT
              (SELECT count(*) FROM workspaces) AS workspaces,
              (SELECT count(*) FROM notes WHERE deleted_at IS NULL AND purged_at IS NULL) AS notes,
              (SELECT count(*) FROM notes WHERE deleted_at IS NOT NULL AND purged_at IS NULL) AS deleted_notes,
              (SELECT count(*) FROM notes WHERE encryption = 'e2ee' AND purged_at IS NULL) AS e2ee_notes`,
      ),
  );

  return {
    user: userDto(u),
    frozen_by: u.frozenBy,
    organizations: orgs.map((o) => ({
      id: o.orgId,
      name: o.orgName,
      slug: o.orgSlug,
      role: o.role,
      status: o.status,
    })),
    teams: teams.map((t) => ({ id: t.teamId, name: t.teamName, org_id: t.orgId })),
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      revoked: d.revokedAt !== null,
    })),
    scale: {
      workspaces: Number(scale?.workspaces ?? 0),
      notes: Number(scale?.notes ?? 0),
      deleted_notes: Number(scale?.deleted_notes ?? 0),
      e2ee_notes: Number(scale?.e2ee_notes ?? 0),
    },
  };
}

// ─────────────────────────────────────────────────────────── 冻结 / 解冻

/** 冻结要同时堵住四条路，只改一个标志位是不够的 */
async function revokeEverything(tx: Tx, targetUserId: string): Promise<number> {
  const devices = await revokeAllUserTokens(tx, targetUserId);
  // 未兑换的设备码：@better-auth/oauth-provider 的 token 端点全程不查用户状态
  // （grep 其 dist 里既没有 banned 也没有 frozen），所以待兑换的码必须在这里作废。
  // 授权码存在通用的 verification 表里、没有 user_id 列，删不动；不过换码这一步要求有效的
  // Web 会话（下面的 revokeWebSessions 会全部清掉），而换出来的 access token 又会被
  // verify-bearer 的 frozen 判定拒绝，所以这条路在"用"的那一端是关死的。
  await tx.execute(
    sql`UPDATE "deviceCode" SET status = 'denied' WHERE "userId" = ${targetUserId} AND status <> 'denied'`,
  );
  // 已建立的同步连接：scope='session' 会让 sync 侧关掉该用户全部 socket（sync/revocation.ts）
  await notifyAuthzRevoked(tx, targetUserId, "session", "*");
  return devices.length;
}

/**
 * Web 会话：**在事务里**删库行并取回 token。
 *
 * 不能只依赖 Better Auth 的 deleteUserSessions：配了 secondaryStorage（Redis）时 findSession 命中缓存
 * 就不查库，而 deleteUserSessions 清缓存的唯一依据是 `active-sessions-<uid>` 这个索引键 —— 在
 * allkeys-lru 下它正是最先被淘汰的一类。索引键一没，就会出现「库里 0 行 session、getSession 仍返回该用户」。
 * 所以库行交给本事务（与 frozen_at 同生共死），Redis 缓存按 token 逐个清（见 dropSessionCaches）。
 */
async function deleteSessionRows(tx: Tx, targetUserId: string): Promise<string[]> {
  const r = await tx.execute<{ token: string }>(
    sql`DELETE FROM "session" WHERE "userId" = ${targetUserId} RETURNING token`,
  );
  return r.rows.map((x) => x.token).filter((t): t is string => typeof t === "string");
}

/**
 * Redis 缓存清理：best-effort。
 * 原来这一步是在事务之外裸 await 的，Redis 抖一下（ioredis 配的是 maxRetriesPerRequest: 2）就会在删任何
 * 东西之前抛出去 —— user 行已提交为冻结、审计已落，接口却回 500，操作者无从知道冻结其实生效了一半。
 * 现在失败只降级并如实回报，冻结这件事本身不再被 Redis 的可用性绑架。
 */
async function dropSessionCaches(
  deps: ServiceDeps,
  targetUserId: string,
  tokens: string[],
): Promise<boolean> {
  let ok = true;
  const warn = (err: unknown, how: string) => {
    ok = false;
    deps.log.error(
      { err: err instanceof Error ? err.message : String(err), targetUserId, how },
      "会话缓存清理失败",
    );
  };
  try {
    if (tokens.length > 0) await deps.revokeSessionTokens?.(tokens);
  } catch (err) {
    warn(err, "by_token");
  }
  try {
    await deps.revokeWebSessions?.(targetUserId);
  } catch (err) {
    warn(err, "by_user");
  }
  return ok;
}

export async function freezeUser(
  deps: ServiceDeps,
  actor: Actor,
  targetUserId: string,
  reason: string | null,
) {
  if (targetUserId === actor.userId) throw new ApiFailure(400, "cannot_freeze_self");
  const target = await requireTarget(deps, targetUserId);
  if (target.isAdmin) throw new ApiFailure(403, "target_is_platform_admin");
  if (target.deletedAt) throw new ApiFailure(409, "user_deleted");

  const revoked = await withUserTx(
    actor.userId,
    async (tx) => {
      // banned 一并置 true：老镜像的 verify-bearer 只认 banned，回滚到旧版本时 Bearer 面仍然是关的
      await tx
        .update(user)
        .set({
          frozenAt: new Date(),
          frozenBy: actor.userId,
          frozenReason: reason,
          banned: true,
          updatedAt: new Date(),
        })
        .where(eq(user.id, targetUserId));
      const n = await revokeEverything(tx, targetUserId);
      const tokens = await deleteSessionRows(tx, targetUserId);
      await audit(
        tx,
        actorEntry(actor, {
          action: "admin.user_frozen",
          targetType: "user",
          targetId: targetUserId,
          metadata: { reason, revoked_devices: n, revoked_sessions: tokens.length },
        }),
      );
      return { devices: n, tokens };
    },
    deps.db,
  );
  const cleared = await dropSessionCaches(deps, targetUserId, revoked.tokens);
  deps.log.warn({ actor: actor.userId, target: targetUserId, cleared }, "platform admin froze user");
  // 如实回报：缓存没清干净时操作者需要知道去补一刀，而不是收到一个语焉不详的 500
  return { ok: true as const, revoked_devices: revoked.devices, session_caches_cleared: cleared };
}

export async function unfreezeUser(deps: ServiceDeps, actor: Actor, targetUserId: string) {
  const target = await requireTarget(deps, targetUserId);
  // 先判已注销：banned 同时是 account-purge 的墓碑标记，无条件清掉会把已匿名化的账号复活。
  // 这个顺序也让「已注销但从没被冻结」拿到 user_deleted 而不是 not_frozen —— 后者会让操作者去找根本不存在的冻结记录。
  if (target.deletedAt) throw new ApiFailure(409, "user_deleted");
  if (target.frozenAt === null) throw new ApiFailure(409, "not_frozen");

  await withUserTx(
    actor.userId,
    async (tx) => {
      await tx
        .update(user)
        .set({ frozenAt: null, frozenBy: null, frozenReason: null, banned: false, updatedAt: new Date() })
        .where(and(eq(user.id, targetUserId), isNull(user.deletedAt)));
      await audit(
        tx,
        actorEntry(actor, { action: "admin.user_unfrozen", targetType: "user", targetId: targetUserId }),
      );
    },
    deps.db,
  );
  deps.log.warn({ actor: actor.userId, target: targetUserId }, "platform admin unfroze user");
  return { ok: true as const };
}

// ─────────────────────────────────────────────────────────── 改密码

export async function adminSetPassword(
  deps: ServiceDeps,
  actor: Actor,
  targetUserId: string,
  newPassword: string,
) {
  const setUserPassword = deps.setUserPassword;
  if (!setUserPassword) throw new ApiFailure(500, "internal_error");
  // 管理员改自己的密码走普通的改密流程（要求先验旧密码），不从这里绕过去
  if (targetUserId === actor.userId) throw new ApiFailure(400, "cannot_target_self");
  const target = await requireTarget(deps, targetUserId);
  // 管理员之间不许互改密码：否则一次令牌泄漏就能横向拿下所有管理员账号，且无法遏制
  if (target.isAdmin) throw new ApiFailure(403, "target_is_platform_admin");
  if (target.deletedAt) throw new ApiFailure(409, "user_deleted");

  await setUserPassword(targetUserId, newPassword);
  const revoked = await withUserTx(
    actor.userId,
    async (tx) => {
      await tx.update(user).set({ updatedAt: new Date() }).where(eq(user.id, targetUserId));
      const n = await revokeEverything(tx, targetUserId);
      const tokens = await deleteSessionRows(tx, targetUserId);
      await audit(
        tx,
        actorEntry(actor, {
          action: "admin.password_set",
          targetType: "user",
          targetId: targetUserId,
          metadata: { via: "platform_admin", revoked_devices: n, revoked_sessions: tokens.length },
        }),
      );
      return { devices: n, tokens };
    },
    deps.db,
  );
  const cleared = await dropSessionCaches(deps, targetUserId, revoked.tokens);
  deps.log.warn({ actor: actor.userId, target: targetUserId, cleared }, "platform admin set user password");
  return { ok: true as const, revoked_devices: revoked.devices, session_caches_cleared: cleared };
}

async function requireTarget(deps: ServiceDeps, targetUserId: string) {
  const rowsFound = await deps.db
    .select({
      id: user.id,
      frozenAt: user.frozenAt,
      deletedAt: user.deletedAt,
      isAdmin: sql<boolean>`EXISTS (SELECT 1 FROM platform_admin pa WHERE pa.user_id = ${user.id})`,
    })
    .from(user)
    .where(eq(user.id, targetUserId))
    .limit(1);
  const t = rowsFound[0];
  if (!t) throw new ApiFailure(404, "not_found");
  return t;
}

// ─────────────────────────────────────────────────────────── 看内容

export interface ListContentInput {
  workspaceId?: string | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  includeDeleted?: boolean | undefined;
}

/** 目标用户能看到的全部工作区（含其所在团队的团队工作区）*/
export async function listUserWorkspaces(deps: ServiceDeps, actor: Actor, targetUserId: string) {
  await requireTarget(deps, targetUserId);
  const list = await adminReadAsUser(
    deps,
    actor,
    targetUserId,
    { targetType: "user", targetId: targetUserId, metadata: { view: "workspaces" } },
    (tx) =>
      rows<{
        id: string;
        kind: string;
        name: string;
        org_id: string | null;
        team_id: string | null;
        org_name: string | null;
        team_name: string | null;
        note_count: string;
      }>(
        tx,
        sql`SELECT w.id, w.kind, w.name, w.org_id, w.team_id,
                   o.name AS org_name, t.name AS team_name,
                   (SELECT count(*) FROM notes n WHERE n.workspace_id = w.id AND n.purged_at IS NULL) AS note_count
              FROM workspaces w
              LEFT JOIN organization o ON o.id = w.org_id
              LEFT JOIN team t ON t.id = w.team_id
               -- RLS 是兜底不是主授权：0002 的策略只判 member 行是否存在，而应用层（services/workspaces.ts、
               -- effective_note_permission、sync 的 queryWorkspacePerm）一律还要 m.status='active'，
               -- 并且跳过已归档的工作区。不补这两条，管理台会把「这个人早就没权限的第三方组织内容」
               -- 当成「他自己看得见的东西」摊开 —— 那是一次以查看之名的越界披露。
               WHERE w.archived_at IS NULL
                 AND (w.org_id IS NULL
                      OR EXISTS (SELECT 1 FROM member m
                                  WHERE m."organizationId" = w.org_id
                                    AND m."userId" = ${targetUserId}
                                    AND m.status = 'active'))
             ORDER BY w.kind, w.name`,
      ),
  );
  return {
    workspaces: list.map((w) => ({
      id: w.id,
      kind: w.kind,
      name: w.name,
      org_id: w.org_id,
      org_name: w.org_name,
      team_id: w.team_id,
      team_name: w.team_name,
      note_count: Number(w.note_count),
    })),
  };
}

export async function listUserNotes(
  deps: ServiceDeps,
  actor: Actor,
  targetUserId: string,
  input: ListContentInput,
) {
  await requireTarget(deps, targetUserId);
  const limit = clampLimit(input.limit);
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const needle = input.q?.trim().toLowerCase();
  const list = await adminReadAsUser(
    deps,
    actor,
    targetUserId,
    {
      targetType: "user",
      targetId: targetUserId,
      metadata: { view: "notes", workspace_id: input.workspaceId ?? null, q: needle ? "yes" : "no" },
    },
    (tx) =>
      rows<{
        id: string;
        workspace_id: string;
        workspace_name: string;
        created_by: string;
        title: string | null;
        excerpt: string;
        color: string;
        encryption: string;
        updated_at: string;
        deleted_at: string | null;
      }>(
        tx,
        sql`SELECT n.id, n.workspace_id, w.name AS workspace_name, n.created_by,
                   n.title_cache AS title,
                   left(n.content_text, 200) AS excerpt,
                   n.color, n.encryption, n.updated_at, n.deleted_at
              FROM notes n
              JOIN workspaces w ON w.id = n.workspace_id
             WHERE n.purged_at IS NULL
               -- 与 listUserWorkspaces 同一口径：只算目标用户**现在**真的还看得见的工作区
               AND w.archived_at IS NULL
               AND (w.org_id IS NULL
                    OR EXISTS (SELECT 1 FROM member m
                                WHERE m."organizationId" = w.org_id
                                  AND m."userId" = ${targetUserId}
                                  AND m.status = 'active'))
               AND (${input.includeDeleted ? sql`true` : sql`n.deleted_at IS NULL`})
               AND (${input.workspaceId ? sql`n.workspace_id = ${input.workspaceId}::uuid` : sql`true`})
               -- E2EE 便笺不进搜索：正文对管理员不可读，那么「搜某个词命中了」本身也不该泄漏出去，
               -- 否则就成了一个可以逐字试探明文的探针
               AND (${needle ? sql`(n.encryption <> 'e2ee' AND lower(n.content_text) LIKE ${`%${escapeLike(needle)}%`} ESCAPE '\\')` : sql`true`})
             ORDER BY n.updated_at DESC
             LIMIT ${limit + 1} OFFSET ${offset}`,
      ),
  );
  const hasMore = list.length > limit;
  return {
    notes: list.slice(0, limit).map((n) => ({
      id: n.id,
      workspace_id: n.workspace_id,
      workspace_name: n.workspace_name,
      created_by: n.created_by,
      // title_cache 是 content_text 的生成列。今天投影器对 e2ee 直接跳过（jobs/project.ts），
      // 所以它恒为空；但只要将来出现「已投影过的便笺转成 e2ee」而不清 content_text 的路径，
      // 标题就会从这里漏出去 —— 不把「今天恰好安全」写成契约。
      title: n.encryption === "e2ee" ? null : n.title,
      excerpt: n.encryption === "e2ee" ? "" : n.excerpt,
      color: n.color,
      readable: n.encryption !== "e2ee",
      unreadable_reason: n.encryption === "e2ee" ? ("e2ee" as const) : null,
      updated_at: n.updated_at,
      deleted: n.deleted_at !== null,
    })),
    next_offset: hasMore ? offset + limit : null,
  };
}

export async function readUserNote(deps: ServiceDeps, actor: Actor, targetUserId: string, noteId: string) {
  await requireTarget(deps, targetUserId);
  const note = await adminReadAsUser(
    deps,
    actor,
    targetUserId,
    { targetType: "note", targetId: noteId, metadata: { view: "note_body" } },
    (tx) =>
      one<{
        id: string;
        workspace_id: string;
        workspace_name: string;
        created_by: string;
        creator_email: string | null;
        content: Record<string, unknown>;
        content_text: string;
        color: string;
        encryption: string;
        created_at: string;
        updated_at: string;
        deleted_at: string | null;
      }>(
        tx,
        sql`SELECT n.id, n.workspace_id, w.name AS workspace_name, n.created_by,
                   u.email AS creator_email,
                   n.content, n.content_text, n.color, n.encryption,
                   n.created_at, n.updated_at, n.deleted_at
              FROM notes n
              JOIN workspaces w ON w.id = n.workspace_id
              LEFT JOIN "user" u ON u.id = n.created_by
             WHERE n.id = ${noteId}::uuid AND n.purged_at IS NULL`,
      ),
  );
  if (!note) throw new ApiFailure(404, "not_found");
  const e2ee = note.encryption === "e2ee";
  return {
    note: {
      id: note.id,
      workspace_id: note.workspace_id,
      workspace_name: note.workspace_name,
      created_by: note.created_by,
      creator_email: note.creator_email,
      color: note.color,
      created_at: note.created_at,
      updated_at: note.updated_at,
      deleted: note.deleted_at !== null,
      readable: !e2ee,
      // E2EE 便笺的正文在服务端只有密文，投影器根本不会写 content/content_text，
      // 所以这里如实返回空 + 原因，而不是假装看到了全部
      unreadable_reason: e2ee ? ("e2ee" as const) : null,
      content: e2ee ? null : note.content,
      content_text: e2ee ? "" : note.content_text,
    },
  };
}

// ─────────────────────────────────────────────────────────── 审计

export async function listAdminAudit(
  deps: ServiceDeps,
  _actor: Actor,
  input: { limit?: number | undefined; offset?: number | undefined; targetUserId?: string | undefined },
) {
  const limit = clampLimit(input.limit);
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  // org 侧的 listAudit 硬编码 WHERE org_id = 当前 org，而管理员条目的 org_id 恒为 NULL，
  // 结构上永远查不到 —— 所以这里必须有一个独立入口，否则「能追责」只是一句空话
  const list = await deps.db.transaction((tx) =>
    rows<Record<string, unknown>>(
      tx,
      sql`SELECT a.id, a.at, a.actor_id, a.actor_ip::text AS actor_ip, a.action,
                 a.target_type, a.target_id, a.outcome, a.metadata,
                 u.email AS actor_email
            FROM audit_log a
            LEFT JOIN "user" u ON u.id = a.actor_id
           WHERE (a.action LIKE 'admin.%'
                  OR a.action = 'auth.sign_in_denied'
                  -- 「谁在摸管理端点被挡了」是这里最值得看的信号，不该只留在库里
                  OR (a.action = 'authz.denied' AND a.metadata->>'required' = 'platform_admin'))
             AND (${
               input.targetUserId
                 ? // 看正文那条审计的 target_id 是便笺 id，被看的人在 metadata.subject_user_id 里；
                   // 只按 target_id 过滤会把「谁看过这个人的便笺」整类漏掉，而那正是最该查的
                   sql`(a.target_id = ${input.targetUserId} OR a.metadata->>'subject_user_id' = ${input.targetUserId})`
                 : sql`true`
})
           ORDER BY a.at DESC
           LIMIT ${limit + 1} OFFSET ${offset}`,
    ),
  );
  const hasMore = list.length > limit;
  return { entries: list.slice(0, limit), next_offset: hasMore ? offset + limit : null };
}

// ─────────────────────────────────────────────────────────── 名单

export async function listPlatformAdmins(deps: ServiceDeps) {
  const list = await deps.db
    .select({
      userId: platformAdmin.userId,
      grantedAt: platformAdmin.grantedAt,
      grantedBy: platformAdmin.grantedBy,
      note: platformAdmin.note,
      email: user.email,
      name: user.name,
    })
    .from(platformAdmin)
    .leftJoin(user, eq(user.id, platformAdmin.userId))
    .orderBy(platformAdmin.grantedAt);
  return {
    admins: list.map((a) => ({
      user_id: a.userId,
      email: a.email,
      name: a.name,
      granted_at: a.grantedAt?.toISOString() ?? null,
      granted_by: a.grantedBy,
      note: a.note,
    })),
  };
}
