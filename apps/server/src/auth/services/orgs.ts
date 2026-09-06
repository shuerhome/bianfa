// 组织（规格 04 §6.3）：建 org（creator=owner + 默认 team workspace「共享区」）、列表、详情、设置、软删、转让。
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { audit } from "../../audit/index.js";
import { withUserTx } from "../../db/client.js";
import { uuidv7 } from "../../db/ids.js";
import { member, organization, user, workspaces } from "../../db/schema/index.js";
import { randomToken } from "../../security/tokens.js";
import { notifyAuthzRevoked } from "../db-helpers.js";
import { ApiFailure } from "../http.js";
import { invalidateMemberCache, invalidateOrgCache, type OrgContext } from "../org-guard.js";
import { type Actor, actorEntry, type ServiceDeps } from "./context.js";

export const ORGANIZATION_LIMIT = 10;
export const DEFAULT_TEAM_WORKSPACE_NAME = "共享区";

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "org";
}

export interface CreateOrgInput {
  name: string;
  slug?: string | undefined;
}

export async function createOrg(deps: ServiceDeps, actor: Actor, input: CreateOrgInput) {
  // 账号模型不验证邮箱（安全码取代邮件），这里不再要求 emailVerified
  return withUserTx(
    actor.userId,
    async (tx) => {
      const owned = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(
          and(
            eq(member.userId, actor.userId),
            eq(member.role, "owner"),
            ne(member.status, "removed"),
            isNull(organization.deletedAt),
          ),
        );
      if ((owned[0]?.n ?? 0) >= ORGANIZATION_LIMIT)
        throw new ApiFailure(409, "organization_limit", { limit: ORGANIZATION_LIMIT });

      let slug = input.slug ? slugify(input.slug) : slugify(input.name);
      const taken = await tx
        .select({ id: organization.id })
        .from(organization)
        .where(eq(organization.slug, slug))
        .limit(1);
      if (taken[0]) {
        if (input.slug) throw new ApiFailure(409, "slug_taken");
        slug = `${slug}-${randomToken(4)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .slice(0, 6)}`;
      }
      const orgId = uuidv7();
      const now = new Date();
      await tx
        .insert(organization)
        .values({ id: orgId, name: input.name, slug, createdAt: now, plan: "free", seatsPaid: 1 });
      await tx.insert(member).values({
        id: uuidv7(),
        organizationId: orgId,
        userId: actor.userId,
        role: "owner",
        createdAt: now,
        status: "active",
      });
      const wsId = uuidv7();
      await tx
        .insert(workspaces)
        .values({ id: wsId, kind: "team", orgId, name: DEFAULT_TEAM_WORKSPACE_NAME });
      await audit(
        tx,
        actorEntry(actor, {
          action: "org.created",
          orgId,
          targetType: "org",
          targetId: orgId,
          after: { name: input.name, slug },
          metadata: { default_workspace_id: wsId },
        }),
      );
      invalidateMemberCache(actor.userId, orgId);
      return {
        org: {
          id: orgId,
          name: input.name,
          slug,
          plan: "free",
          seats_paid: 1,
          created_at: now.toISOString(),
          role: "owner",
        },
        default_workspace_id: wsId,
      };
    },
    deps.db,
  );
}

export async function listOrgs(deps: ServiceDeps, actor: Actor) {
  const rows = await deps.db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      logo: organization.logo,
      plan: organization.plan,
      enterpriseMode: organization.enterpriseMode,
      createdAt: organization.createdAt,
      role: member.role,
      status: member.status,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(
      and(eq(member.userId, actor.userId), ne(member.status, "removed"), isNull(organization.deletedAt)),
    );
  return {
    orgs: rows.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      logo: o.logo,
      plan: o.plan,
      enterprise_mode: o.enterpriseMode,
      created_at: o.createdAt.toISOString(),
      role: o.role,
      status: o.status,
    })),
  };
}

export async function activeSeats(
  q: { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: unknown[] }> },
  orgId: string,
): Promise<number> {
  const r = await q.execute(
    sql`SELECT count(*)::int AS n FROM member WHERE "organizationId" = ${orgId} AND status = 'active' AND seat_billable`,
  );
  return (r.rows[0] as { n: number } | undefined)?.n ?? 0;
}

export async function getOrg(deps: ServiceDeps, actor: Actor, org: OrgContext) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      const rows = await tx.select().from(organization).where(eq(organization.id, org.orgId)).limit(1);
      const o = rows[0];
      if (!o || o.deletedAt) throw new ApiFailure(404, "not_found");
      const seats = await activeSeats(tx, org.orgId);
      const members = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(member)
        .where(and(eq(member.organizationId, org.orgId), ne(member.status, "removed")));
      return {
        org: {
          id: o.id,
          name: o.name,
          slug: o.slug,
          logo: o.logo,
          plan: o.plan,
          seats_paid: o.seatsPaid,
          active_seats: seats,
          member_count: members[0]?.n ?? 0,
          allow_public_links: o.allowPublicLinks,
          enterprise_mode: o.enterpriseMode,
          created_at: o.createdAt.toISOString(),
          role: org.role,
        },
      };
    },
    deps.db,
  );
}

export interface UpdateOrgInput {
  name?: string | undefined;
  slug?: string | undefined;
  allow_public_links?: boolean | undefined;
  enterprise_mode?: boolean | undefined;
}

export async function updateOrg(deps: ServiceDeps, actor: Actor, org: OrgContext, input: UpdateOrgInput) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      const rows = await tx.select().from(organization).where(eq(organization.id, org.orgId)).limit(1);
      const before = rows[0];
      if (!before || before.deletedAt) throw new ApiFailure(404, "not_found");
      const set: Partial<typeof organization.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.slug !== undefined) {
        const slug = slugify(input.slug);
        const taken = await tx
          .select({ id: organization.id })
          .from(organization)
          .where(and(eq(organization.slug, slug), ne(organization.id, org.orgId)))
          .limit(1);
        if (taken[0]) throw new ApiFailure(409, "slug_taken");
        set.slug = slug;
      }
      if (input.allow_public_links !== undefined) set.allowPublicLinks = input.allow_public_links;
      if (input.enterprise_mode !== undefined) set.enterpriseMode = input.enterprise_mode;
      if (Object.keys(set).length === 0) throw new ApiFailure(400, "nothing_to_update");
      const updated = await tx
        .update(organization)
        .set(set)
        .where(eq(organization.id, org.orgId))
        .returning();
      const after = updated[0];
      if (!after) throw new ApiFailure(404, "not_found");
      await audit(
        tx,
        actorEntry(actor, {
          action: "org.settings_changed",
          orgId: org.orgId,
          targetType: "org",
          targetId: org.orgId,
          before: pick(before, set),
          after: pick(after, set),
        }),
      );
      return {
        org: {
          id: after.id,
          name: after.name,
          slug: after.slug,
          allow_public_links: after.allowPublicLinks,
          enterprise_mode: after.enterpriseMode,
        },
      };
    },
    deps.db,
  );
}

function pick(row: Record<string, unknown>, keys: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(keys)) out[k] = row[k];
  return out;
}

/** 软删（owner 硬校验在路由层 + 这里再校一次）：全员 epoch+1 + NOTIFY org；30 天后硬删由 worker 负责 */
export async function deleteOrg(deps: ServiceDeps, actor: Actor, org: OrgContext) {
  if (org.role !== "owner")
    throw new ApiFailure(403, "insufficient_role", { required: { resource: "org", action: "owner" } });
  return withUserTx(
    actor.userId,
    async (tx) => {
      const rows = await tx
        .update(organization)
        .set({ deletedAt: new Date() })
        .where(and(eq(organization.id, org.orgId), isNull(organization.deletedAt)))
        .returning({ id: organization.id });
      if (!rows[0]) throw new ApiFailure(404, "not_found");
      const members = await tx
        .select({ userId: member.userId })
        .from(member)
        .where(and(eq(member.organizationId, org.orgId), ne(member.status, "removed")));
      await tx
        .update(member)
        .set({ sessionEpoch: sql`${member.sessionEpoch} + 1` })
        .where(eq(member.organizationId, org.orgId));
      for (const m of members) await notifyAuthzRevoked(tx, m.userId, "org", org.orgId);
      await audit(
        tx,
        actorEntry(actor, {
          action: "org.deleted",
          orgId: org.orgId,
          targetType: "org",
          targetId: org.orgId,
          metadata: { members: members.length },
        }),
      );
      invalidateOrgCache(org.orgId);
      return { deleted: true, org_id: org.orgId };
    },
    deps.db,
  );
}

export async function transferOrg(deps: ServiceDeps, actor: Actor, org: OrgContext, toUserId: string) {
  if (org.role !== "owner")
    throw new ApiFailure(403, "insufficient_role", { required: { resource: "org", action: "owner" } });
  if (toUserId === actor.userId) throw new ApiFailure(400, "already_owner");
  return withUserTx(
    actor.userId,
    async (tx) => {
      const target = await tx
        .select({ id: member.id, status: member.status, role: member.role })
        .from(member)
        .where(and(eq(member.organizationId, org.orgId), eq(member.userId, toUserId)))
        .limit(1);
      if (target[0]?.status !== "active") throw new ApiFailure(404, "member_not_found");
      await tx.update(member).set({ role: "owner" }).where(eq(member.id, target[0].id));
      await tx
        .update(member)
        .set({ role: "admin", sessionEpoch: sql`${member.sessionEpoch} + 1` })
        .where(and(eq(member.organizationId, org.orgId), eq(member.userId, actor.userId)));
      await notifyAuthzRevoked(tx, actor.userId, "org", org.orgId);
      await audit(
        tx,
        actorEntry(actor, {
          action: "org.transferred",
          orgId: org.orgId,
          targetType: "user",
          targetId: toUserId,
          before: { owner: actor.userId },
          after: { owner: toUserId },
        }),
      );
      invalidateMemberCache(actor.userId, org.orgId);
      invalidateMemberCache(toUserId, org.orgId);
      const u = await tx.select({ name: user.name }).from(user).where(eq(user.id, toUserId)).limit(1);
      return { transferred: true, new_owner: { id: toUserId, name: u[0]?.name ?? null }, your_role: "admin" };
    },
    deps.db,
  );
}
