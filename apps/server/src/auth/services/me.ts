// /v1/me、修改安全码、账号删除（规格 04 §6.2 / §7.9）。
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { audit } from "../../audit/index.js";
import { type Db, withUserTx } from "../../db/client.js";
import { account, device, member, organization, user, workspaces } from "../../db/schema/index.js";
import { notifyAuthzRevoked } from "../db-helpers.js";
import { ApiFailure } from "../http.js";
import { revokeAllUserTokens } from "../oauth-tokens.js";
import { invalidateMemberCache } from "../org-guard.js";
import { normalizeSecurityCode, securityCodeProblem } from "../security-code.js";
import { type Actor, actorEntry, type ServiceDeps, sendMailSafely } from "./context.js";

export type Plan = "free" | "pro" | "team";
const PLAN_RANK: Record<Plan, number> = { free: 0, pro: 1, team: 2 };
function planRank(p: string): number {
  return (PLAN_RANK as Record<string, number | undefined>)[p] ?? 0;
}
export const DELETION_GRACE_DAYS = 30;

/** 用户有效计划 = 其活跃成员身份里最高的 org.plan（个人无付费列，Free 默认） */
export async function userPlan(db: Db, userId: string): Promise<Plan> {
  const rows = await db
    .select({ plan: organization.plan })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, userId), eq(member.status, "active"), isNull(organization.deletedAt)));
  let best: Plan = "free";
  for (const r of rows) {
    if (planRank(r.plan) > planRank(best)) best = r.plan as Plan;
  }
  return best;
}

export async function getMe(deps: ServiceDeps, actor: Actor) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      const users = await tx
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
          image: user.image,
          createdAt: user.createdAt,
          deletedAt: user.deletedAt,
          deletionDueAt: user.deletionDueAt,
          aiOptIn: user.aiOptIn,
          twoFactorEnabled: user.twoFactorEnabled,
          securityCodeSetAt: user.securityCodeSetAt,
        })
        .from(user)
        .where(eq(user.id, actor.userId))
        .limit(1);
      const u = users[0];
      if (!u) throw new ApiFailure(401, "unauthorized");
      const orgs = await tx
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          plan: organization.plan,
          enterpriseMode: organization.enterpriseMode,
          role: member.role,
          status: member.status,
          joinedAt: member.createdAt,
        })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(
          and(eq(member.userId, actor.userId), ne(member.status, "removed"), isNull(organization.deletedAt)),
        );
      const ws = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(eq(workspaces.ownerUserId, actor.userId), eq(workspaces.kind, "personal")))
        .limit(1);
      const devices = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(device)
        .where(and(eq(device.userId, actor.userId), isNull(device.revokedAt)));
      let plan: Plan = "free";
      for (const o of orgs) {
        if (o.status === "active" && planRank(o.plan) > planRank(plan)) plan = o.plan as Plan;
      }
      return {
        user: {
          id: u.id,
          name: u.name,
          email: u.email,
          email_verified: u.emailVerified,
          image: u.image,
          created_at: u.createdAt.toISOString(),
          ai_opt_in: u.aiOptIn,
          two_factor_enabled: u.twoFactorEnabled ?? false,
        },
        plan,
        personal_workspace_id: ws[0]?.id ?? null,
        orgs: orgs.map((o) => ({
          id: o.id,
          name: o.name,
          slug: o.slug,
          plan: o.plan,
          enterprise_mode: o.enterpriseMode,
          role: o.role,
          status: o.status,
          joined_at: o.joinedAt.toISOString(),
        })),
        active_devices: devices[0]?.n ?? 0,
        current_device_id: actor.deviceId,
        deletion_due_at: u.deletionDueAt ? u.deletionDueAt.toISOString() : null,
        /** 安全码最近一次设置时间；null = 尚未设置（社交登录建的账号） */
        security_code_set_at: u.securityCodeSetAt ? u.securityCodeSetAt.toISOString() : null,
      };
    },
    deps.db,
  );
}

export interface ChangeSecurityCodeInput {
  password: string;
  newSecurityCode: string;
}

/**
 * POST /v1/me/security-code：当前密码验证通过 → 新安全码哈希落库（与密码同一哈希器）→ 审计 auth.security_code_changed。
 * 明文既不进日志也不进审计（audit 的 FORBIDDEN_KEYS 也挡 code 键）。
 */
export async function changeSecurityCode(deps: ServiceDeps, actor: Actor, input: ChangeSecurityCodeInput) {
  const hasher = deps.password;
  if (!hasher) throw new ApiFailure(500, "internal_error");
  const problem = securityCodeProblem(input.newSecurityCode, input.password);
  if (problem === "equals_password") throw new ApiFailure(400, "security_code_equals_password");
  if (problem)
    throw new ApiFailure(400, "validation_failed", {
      issues: [{ path: "new_security_code", message: problem }],
    });
  const accounts = await deps.db
    .select({ password: account.password })
    .from(account)
    .where(and(eq(account.userId, actor.userId), eq(account.providerId, "credential")))
    .limit(1);
  const hash = accounts[0]?.password;
  if (!hash) throw new ApiFailure(409, "no_password");
  if (!(await hasher.verify({ hash, password: input.password }))) {
    await deps.db.transaction((tx) =>
      audit(
        tx,
        actorEntry(actor, {
          action: "auth.security_code_change_denied",
          targetType: "user",
          targetId: actor.userId,
          outcome: "denied",
          metadata: { reason: "invalid_password" },
        }),
      ),
    );
    throw new ApiFailure(403, "invalid_password");
  }
  const securityCodeHash = await hasher.hash(normalizeSecurityCode(input.newSecurityCode));
  const setAt = new Date();
  await withUserTx(
    actor.userId,
    async (tx) => {
      await tx
        .update(user)
        .set({ securityCodeHash, securityCodeSetAt: setAt, updatedAt: setAt })
        .where(eq(user.id, actor.userId));
      await audit(
        tx,
        actorEntry(actor, {
          action: "auth.security_code_changed",
          targetType: "user",
          targetId: actor.userId,
        }),
      );
    },
    deps.db,
  );
  return { security_code_set_at: setAt.toISOString() };
}

/** 软删：deleted_at / deletion_due_at(+30d)，撤销全部 token/会话/设备，NOTIFY session:*，邮件，审计 */
export async function scheduleDeletion(deps: ServiceDeps, actor: Actor) {
  const due = new Date(Date.now() + DELETION_GRACE_DAYS * 24 * 3600 * 1000);
  const result = await withUserTx(
    actor.userId,
    async (tx) => {
      // 唯一 owner 且 org 还有其他成员 → 先转让
      const blocking = await tx.execute(sql`
        SELECT o.id FROM organization o
        JOIN member me ON me."organizationId" = o.id AND me."userId" = ${actor.userId} AND me.role = 'owner' AND me.status <> 'removed'
        WHERE o.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM member x WHERE x."organizationId" = o.id AND x.role = 'owner' AND x.status = 'active' AND x."userId" <> ${actor.userId})
          AND EXISTS (SELECT 1 FROM member y WHERE y."organizationId" = o.id AND y.status <> 'removed' AND y."userId" <> ${actor.userId})
        LIMIT 1`);
      if (blocking.rows.length) {
        throw new ApiFailure(409, "transfer_ownership_first", {
          org_id: (blocking.rows[0] as { id: string }).id,
        });
      }
      const users = await tx
        .select({ email: user.email, name: user.name, deletedAt: user.deletedAt })
        .from(user)
        .where(eq(user.id, actor.userId))
        .limit(1);
      const u = users[0];
      if (!u) throw new ApiFailure(401, "unauthorized");
      await tx
        .update(user)
        .set({ deletedAt: new Date(), deletionDueAt: due })
        .where(eq(user.id, actor.userId));
      await revokeAllUserTokens(tx, actor.userId);
      await notifyAuthzRevoked(tx, actor.userId, "session", "*");
      await audit(
        tx,
        actorEntry(actor, {
          action: "account.deletion_scheduled",
          targetType: "user",
          targetId: actor.userId,
          metadata: { due_at: due.toISOString() },
        }),
      );
      return { email: u.email, name: u.name };
    },
    deps.db,
  );
  await deps.revokeWebSessions?.(actor.userId);
  invalidateMemberCache(actor.userId);
  await sendMailSafely(deps, () =>
    deps.mail.send(result.email, "account_deletion_scheduled", {
      name: result.name,
      due_at: due.toISOString(),
      url: `${deps.env.appOrigin}/account/restore`,
    }),
  );
  return { deletion_due_at: due.toISOString() };
}

export async function cancelDeletion(deps: ServiceDeps, actor: Actor) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      const rows = await tx
        .update(user)
        .set({ deletedAt: null, deletionDueAt: null })
        .where(and(eq(user.id, actor.userId), sql`${user.deletedAt} IS NOT NULL`))
        .returning({ id: user.id });
      if (!rows[0]) throw new ApiFailure(409, "not_scheduled");
      await audit(
        tx,
        actorEntry(actor, {
          action: "account.deletion_canceled",
          targetType: "user",
          targetId: actor.userId,
        }),
      );
      return { deletion_due_at: null };
    },
    deps.db,
  );
}
