// 成员（规格 04 §4.6 / §6.3）：列表、改角色、移除（一次事务）、暂停/恢复、退出。
import { and, eq, ne, sql } from "drizzle-orm";
import { audit } from "../../audit/index.js";
import { type Tx, withUserTx } from "../../db/client.js";
import { member, teamMember, user } from "../../db/schema/index.js";
import { asUser, notifyAuthzRevoked } from "../db-helpers.js";
import { ApiFailure } from "../http.js";
import {
  invalidateMemberCache,
  isOrgRole,
  type OrgContext,
  type OrgRole,
  roleAtLeast,
} from "../org-guard.js";
import { type Actor, actorEntry, type ServiceDeps } from "./context.js";

export async function listMembers(deps: ServiceDeps, actor: Actor, org: OrgContext) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      const rows = await tx
        .select({
          userId: member.userId,
          name: user.name,
          email: user.email,
          image: user.image,
          role: member.role,
          status: member.status,
          seatBillable: member.seatBillable,
          joinedAt: member.createdAt,
        })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(and(eq(member.organizationId, org.orgId), ne(member.status, "removed")));
      return {
        members: rows.map((m) => ({
          user_id: m.userId,
          name: m.name,
          email: m.email,
          image: m.image,
          role: m.role,
          status: m.status,
          seat_billable: m.seatBillable,
          joined_at: m.joinedAt.toISOString(),
        })),
      };
    },
    deps.db,
  );
}

async function loadTarget(tx: Tx, orgId: string, userId: string) {
  const rows = await tx
    .select({ id: member.id, role: member.role, status: member.status, sessionEpoch: member.sessionEpoch })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1);
  const t = rows[0];
  if (!t || t.status === "removed" || !isOrgRole(t.role)) throw new ApiFailure(404, "member_not_found");
  return { ...t, role: t.role as OrgRole };
}

/** admin 只能管 member；owner 能管 admin/member；谁都不能动 owner（owner 用 transfer） */
function assertCanManage(actorRole: OrgRole, targetRole: OrgRole): void {
  if (targetRole === "owner") throw new ApiFailure(403, "cannot_modify_owner");
  if (!roleAtLeast(actorRole, "admin"))
    throw new ApiFailure(403, "insufficient_role", { required: { resource: "org", action: "admin" } });
  if (targetRole === "admin" && actorRole !== "owner") {
    throw new ApiFailure(403, "insufficient_role", { required: { resource: "org", action: "owner" } });
  }
}

export async function updateMemberRole(
  deps: ServiceDeps,
  actor: Actor,
  org: OrgContext,
  targetUserId: string,
  role: "admin" | "member",
) {
  if (targetUserId === actor.userId) throw new ApiFailure(400, "cannot_change_own_role");
  return withUserTx(
    actor.userId,
    async (tx) => {
      const target = await loadTarget(tx, org.orgId, targetUserId);
      assertCanManage(org.role, target.role);
      if (role === "admin" && org.role !== "owner")
        throw new ApiFailure(403, "insufficient_role", { required: { resource: "org", action: "owner" } });
      if (target.role === role) return { user_id: targetUserId, role };
      const downgrade = roleAtLeast(target.role, "admin") && role === "member";
      await tx
        .update(member)
        .set({ role, ...(downgrade ? { sessionEpoch: sql`${member.sessionEpoch} + 1` } : {}) })
        .where(eq(member.id, target.id));
      if (downgrade) await notifyAuthzRevoked(tx, targetUserId, "org", org.orgId);
      await audit(
        tx,
        actorEntry(actor, {
          action: "member.role_changed",
          orgId: org.orgId,
          targetType: "user",
          targetId: targetUserId,
          before: { role: target.role },
          after: { role },
        }),
      );
      invalidateMemberCache(targetUserId, org.orgId);
      return { user_id: targetUserId, role };
    },
    deps.db,
  );
}

/**
 * 规格 04 §4.6 移除事务：status=removed, removed_at, epoch+1 → 删该用户在该 org 团队便笺上的 shares(user)
 * （以被移除者身份执行，RLS 才看得到那些行）→ 删 team_member → NOTIFY org → 审计。
 */
export async function removeMemberTx(
  tx: Tx,
  actor: Actor,
  orgId: string,
  targetUserId: string,
  reason: "removed" | "left",
) {
  const target = await loadTarget(tx, orgId, targetUserId);
  await tx
    .update(member)
    .set({ status: "removed", removedAt: new Date(), sessionEpoch: sql`${member.sessionEpoch} + 1` })
    .where(eq(member.id, target.id));
  const deletedShares = await asUser(tx, actor.userId, targetUserId, async () => {
    const r = await tx.execute(sql`
      DELETE FROM shares s
      WHERE s.grantee_kind = 'user' AND s.grantee_user_id = ${targetUserId}
        AND s.note_id IN (SELECT n.id FROM notes n JOIN workspaces w ON w.id = n.workspace_id WHERE w.org_id = ${orgId})
      RETURNING s.id`);
    return r.rows.length;
  });
  const teams = await tx.execute(sql`
    DELETE FROM "teamMember" tm USING team t
    WHERE tm."teamId" = t.id AND t."organizationId" = ${orgId} AND tm."userId" = ${targetUserId}
    RETURNING t.id`);
  for (const row of teams.rows as Array<{ id: string }>) {
    await tx.execute(
      sql`UPDATE team SET "memberCount" = GREATEST("memberCount" - 1, 0) WHERE id = ${row.id}`,
    );
  }
  await notifyAuthzRevoked(tx, targetUserId, "org", orgId);
  await audit(
    tx,
    actorEntry(actor, {
      action: "member.removed",
      orgId,
      targetType: "user",
      targetId: targetUserId,
      before: { role: target.role, status: target.status },
      metadata: {
        reason,
        shares_deleted: deletedShares,
        teams_left: teams.rows.length,
        self: actor.userId === targetUserId,
      },
    }),
  );
  invalidateMemberCache(targetUserId, orgId);
  return {
    user_id: targetUserId,
    status: "removed",
    shares_deleted: deletedShares,
    teams_left: teams.rows.length,
  };
}

export async function removeMember(deps: ServiceDeps, actor: Actor, org: OrgContext, targetUserId: string) {
  if (targetUserId === actor.userId) throw new ApiFailure(400, "use_leave");
  return withUserTx(
    actor.userId,
    async (tx) => {
      const target = await loadTarget(tx, org.orgId, targetUserId);
      assertCanManage(org.role, target.role);
      return removeMemberTx(tx, actor, org.orgId, targetUserId, "removed");
    },
    deps.db,
  );
}

export async function setSuspended(
  deps: ServiceDeps,
  actor: Actor,
  org: OrgContext,
  targetUserId: string,
  suspended: boolean,
) {
  if (targetUserId === actor.userId) throw new ApiFailure(400, "cannot_suspend_self");
  return withUserTx(
    actor.userId,
    async (tx) => {
      const target = await loadTarget(tx, org.orgId, targetUserId);
      assertCanManage(org.role, target.role);
      const status = suspended ? "suspended" : "active";
      if (target.status === status) return { user_id: targetUserId, status };
      await tx
        .update(member)
        .set({ status, ...(suspended ? { sessionEpoch: sql`${member.sessionEpoch} + 1` } : {}) })
        .where(eq(member.id, target.id));
      if (suspended) await notifyAuthzRevoked(tx, targetUserId, "org", org.orgId);
      await audit(
        tx,
        actorEntry(actor, {
          action: suspended ? "member.suspended" : "member.unsuspended",
          orgId: org.orgId,
          targetType: "user",
          targetId: targetUserId,
          before: { status: target.status },
          after: { status },
        }),
      );
      invalidateMemberCache(targetUserId, org.orgId);
      return { user_id: targetUserId, status };
    },
    deps.db,
  );
}

export async function leaveOrg(deps: ServiceDeps, actor: Actor, org: OrgContext) {
  if (org.role === "owner") throw new ApiFailure(409, "transfer_ownership_first");
  return withUserTx(
    actor.userId,
    (tx) => removeMemberTx(tx, actor, org.orgId, actor.userId, "left"),
    deps.db,
  );
}

/** 团队成员关系工具：给 teams.ts 复用 */
export async function isActiveMember(tx: Tx, orgId: string, userId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId), eq(member.status, "active")))
    .limit(1);
  return Boolean(rows[0]);
}

export { teamMember };
