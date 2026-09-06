// /v1/me、账号删除（规格 04 §6.2 / §7.9）。
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { audit } from "../../audit/index.js";
import { type Db, withUserTx } from "../../db/client.js";
import { device, member, organization, user, workspaces } from "../../db/schema/index.js";
import { notifyAuthzRevoked } from "../db-helpers.js";
import { ApiFailure } from "../http.js";
import { revokeAllUserTokens } from "../oauth-tokens.js";
import { invalidateMemberCache } from "../org-guard.js";
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
      };
    },
    deps.db,
  );
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
