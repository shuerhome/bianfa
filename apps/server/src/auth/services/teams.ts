// 团队（规格 04 §4.1 / §6.3）：Team 只是授权主体 + workspace 可见性范围；≤ 20 个/org；成员移除 → NOTIFY scope:'team'。
import { and, eq, sql } from "drizzle-orm";
import { audit } from "../../audit/index.js";
import { type Tx, withUserTx } from "../../db/client.js";
import { uuidv7 } from "../../db/ids.js";
import { team, teamMember, user } from "../../db/schema/index.js";
import { notifyAuthzRevoked } from "../db-helpers.js";
import { ApiFailure } from "../http.js";
import type { OrgContext } from "../org-guard.js";
import { type Actor, actorEntry, type ServiceDeps } from "./context.js";
import { isActiveMember } from "./members.js";

export const MAX_TEAMS_PER_ORG = 20;

function teamView(t: {
  id: string;
  name: string;
  color: string | null;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date | null;
}) {
  return {
    id: t.id,
    name: t.name,
    color: t.color,
    member_count: t.memberCount,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt ? t.updatedAt.toISOString() : null,
  };
}

async function loadTeam(tx: Tx, orgId: string, teamId: string) {
  const rows = await tx
    .select()
    .from(team)
    .where(and(eq(team.id, teamId), eq(team.organizationId, orgId)))
    .limit(1);
  if (!rows[0]) throw new ApiFailure(404, "not_found");
  return rows[0];
}

async function refreshCount(tx: Tx, teamId: string): Promise<number> {
  const r = await tx.execute(
    sql`UPDATE team SET "memberCount" = (SELECT count(*) FROM "teamMember" WHERE "teamId" = ${teamId}), "updatedAt" = now() WHERE id = ${teamId} RETURNING "memberCount" AS n`,
  );
  return (r.rows[0] as { n: number } | undefined)?.n ?? 0;
}

export async function createTeam(
  deps: ServiceDeps,
  actor: Actor,
  org: OrgContext,
  input: { name: string; color?: string | undefined },
) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      const count = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(team)
        .where(eq(team.organizationId, org.orgId));
      if ((count[0]?.n ?? 0) >= MAX_TEAMS_PER_ORG)
        throw new ApiFailure(409, "team_limit", { limit: MAX_TEAMS_PER_ORG });
      const id = uuidv7();
      const now = new Date();
      const rows = await tx
        .insert(team)
        .values({
          id,
          name: input.name,
          color: input.color ?? null,
          organizationId: org.orgId,
          createdAt: now,
          memberCount: 0,
        })
        .returning();
      await audit(
        tx,
        actorEntry(actor, {
          action: "team.created",
          orgId: org.orgId,
          targetType: "team",
          targetId: id,
          after: { name: input.name },
        }),
      );
      return { team: teamView(rows[0] as (typeof rows)[number]) };
    },
    deps.db,
  );
}

export async function listTeams(deps: ServiceDeps, actor: Actor, org: OrgContext) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      const rows = await tx.select().from(team).where(eq(team.organizationId, org.orgId));
      rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return { teams: rows.map(teamView) };
    },
    deps.db,
  );
}

export async function updateTeam(
  deps: ServiceDeps,
  actor: Actor,
  org: OrgContext,
  teamId: string,
  input: { name?: string | undefined; color?: string | null | undefined },
) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      const before = await loadTeam(tx, org.orgId, teamId);
      const set: Partial<typeof team.$inferInsert> = { updatedAt: new Date() };
      if (input.name !== undefined) set.name = input.name;
      if (input.color !== undefined) set.color = input.color;
      const rows = await tx.update(team).set(set).where(eq(team.id, teamId)).returning();
      await audit(
        tx,
        actorEntry(actor, {
          action: "team.updated",
          orgId: org.orgId,
          targetType: "team",
          targetId: teamId,
          before: { name: before.name, color: before.color },
          after: { name: rows[0]?.name, color: rows[0]?.color },
        }),
      );
      return { team: teamView(rows[0] as (typeof rows)[number]) };
    },
    deps.db,
  );
}

/** 删团队：teamMember 级联删除，workspaces.team_id → NULL（FK），每个原成员 NOTIFY team */
export async function deleteTeam(deps: ServiceDeps, actor: Actor, org: OrgContext, teamId: string) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      const t = await loadTeam(tx, org.orgId, teamId);
      const members = await tx
        .select({ userId: teamMember.userId })
        .from(teamMember)
        .where(eq(teamMember.teamId, teamId));
      await tx.delete(team).where(eq(team.id, teamId));
      for (const m of members) await notifyAuthzRevoked(tx, m.userId, "team", teamId);
      await audit(
        tx,
        actorEntry(actor, {
          action: "team.deleted",
          orgId: org.orgId,
          targetType: "team",
          targetId: teamId,
          before: { name: t.name },
          metadata: { members: members.length },
        }),
      );
      return { deleted: true, team_id: teamId };
    },
    deps.db,
  );
}

export async function listTeamMembers(deps: ServiceDeps, actor: Actor, org: OrgContext, teamId: string) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      await loadTeam(tx, org.orgId, teamId);
      const rows = await tx
        .select({
          userId: teamMember.userId,
          name: user.name,
          email: user.email,
          createdAt: teamMember.createdAt,
        })
        .from(teamMember)
        .innerJoin(user, eq(user.id, teamMember.userId))
        .where(eq(teamMember.teamId, teamId));
      return {
        members: rows.map((m) => ({
          user_id: m.userId,
          name: m.name,
          email: m.email,
          added_at: m.createdAt ? m.createdAt.toISOString() : null,
        })),
      };
    },
    deps.db,
  );
}

export async function addTeamMember(
  deps: ServiceDeps,
  actor: Actor,
  org: OrgContext,
  teamId: string,
  userId: string,
) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      await loadTeam(tx, org.orgId, teamId);
      if (!(await isActiveMember(tx, org.orgId, userId))) throw new ApiFailure(404, "member_not_found");
      await tx
        .insert(teamMember)
        .values({ id: uuidv7(), teamId, userId, membershipKey: `${teamId}:${userId}`, createdAt: new Date() })
        .onConflictDoNothing();
      const n = await refreshCount(tx, teamId);
      await audit(
        tx,
        actorEntry(actor, {
          action: "team.member_added",
          orgId: org.orgId,
          targetType: "user",
          targetId: userId,
          metadata: { team_id: teamId },
        }),
      );
      return { team_id: teamId, user_id: userId, member_count: n };
    },
    deps.db,
  );
}

export async function removeTeamMember(
  deps: ServiceDeps,
  actor: Actor,
  org: OrgContext,
  teamId: string,
  userId: string,
) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      await loadTeam(tx, org.orgId, teamId);
      const rows = await tx
        .delete(teamMember)
        .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, userId)))
        .returning({ id: teamMember.id });
      if (!rows[0]) throw new ApiFailure(404, "not_found");
      const n = await refreshCount(tx, teamId);
      await notifyAuthzRevoked(tx, userId, "team", teamId);
      await audit(
        tx,
        actorEntry(actor, {
          action: "team.member_removed",
          orgId: org.orgId,
          targetType: "user",
          targetId: userId,
          metadata: { team_id: teamId },
        }),
      );
      return { team_id: teamId, user_id: userId, member_count: n };
    },
    deps.db,
  );
}
