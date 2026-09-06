// 邀请（规格 04 §4.4 / §4.5）：token = base64url(32B)，库里只存 sha256；同 org+email 的 pending 覆盖不堆积；
// 席位闸门在发送与接受两处；链接 ${APP_ORIGIN}/invite/{token}；50/h/org。
// 不依赖邮件：创建 / 重发的响应直接带 invite_url，邀请人可以复制后用任意渠道发给对方（邮件仍会走 provider，缺省 console）。
import { and, eq, sql } from "drizzle-orm";
import { audit } from "../../audit/index.js";
import { type Tx, withUserTx } from "../../db/client.js";
import { uuidv7 } from "../../db/ids.js";
import { invitation, member, organization, team, teamMember, user } from "../../db/schema/index.js";
import { getRateLimitBackend } from "../../security/rate-limit.js";
import { randomToken, sha256Base64url } from "../../security/tokens.js";
import { ApiFailure } from "../http.js";
import { invalidateMemberCache, type OrgContext } from "../org-guard.js";
import { type Actor, actorEntry, type ServiceDeps, sendMailSafely } from "./context.js";
import { activeSeats } from "./orgs.js";

export const INVITATION_TTL_MS = 48 * 3600 * 1000;
export const INVITES_PER_ORG_PER_HOUR = 50;
export const PENDING_INVITATION_LIMIT = 100;

export type InviteRole = "member" | "admin";

function inviteLink(deps: ServiceDeps, token: string): string {
  return `${deps.env.appOrigin}/invite/${token}`;
}

async function assertSeatAvailable(tx: Tx, orgId: string): Promise<void> {
  const org = await tx
    .select({ seatsPaid: organization.seatsPaid, plan: organization.plan })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  const seatsPaid = org[0]?.seatsPaid ?? 1;
  const seats = await activeSeats(tx, orgId);
  if (seats >= seatsPaid)
    throw new ApiFailure(409, "seat_limit", { seats_paid: seatsPaid, active_seats: seats });
}

async function assertInviteRate(orgId: string): Promise<void> {
  const decision = await getRateLimitBackend().consume(`invite:${orgId}`, INVITES_PER_ORG_PER_HOUR, 3600);
  if (!decision.allowed)
    throw new ApiFailure(429, "rate_limited", { retry_after: decision.retryAfterSeconds });
}

interface IssuedInvite {
  id: string;
  email: string;
  role: string;
  teamId: string | null;
  expiresAt: Date;
  token: string;
  orgName: string;
}

function inviteView(i: {
  id: string;
  email: string;
  role: string | null;
  teamId: string | null;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  inviterId: string;
}) {
  return {
    id: i.id,
    email: i.email,
    role: i.role ?? "member",
    team_id: i.teamId,
    status: i.status,
    expires_at: i.expiresAt.toISOString(),
    created_at: i.createdAt.toISOString(),
    inviter_id: i.inviterId,
  };
}

export interface CreateInviteInput {
  email: string;
  role: InviteRole;
  team_id?: string | undefined;
}

export async function createInvite(
  deps: ServiceDeps,
  actor: Actor,
  org: OrgContext,
  input: CreateInviteInput,
) {
  if (input.role === "admin" && org.role !== "owner")
    throw new ApiFailure(403, "insufficient_role", { required: { resource: "org", action: "owner" } });
  await assertInviteRate(org.orgId);
  const email = input.email.toLowerCase();
  const issued = await withUserTx(
    actor.userId,
    async (tx): Promise<IssuedInvite> => {
      const already = await tx
        .select({ status: member.status })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(
          and(
            eq(member.organizationId, org.orgId),
            sql`lower(${user.email}) = ${email}`,
            sql`${member.status} <> 'removed'`,
          ),
        )
        .limit(1);
      if (already[0]) throw new ApiFailure(409, "already_member");
      if (input.team_id) {
        const t = await tx
          .select({ id: team.id })
          .from(team)
          .where(and(eq(team.id, input.team_id), eq(team.organizationId, org.orgId)))
          .limit(1);
        if (!t[0]) throw new ApiFailure(404, "team_not_found");
      }
      await assertSeatAvailable(tx, org.orgId);
      const orgRow = await tx
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, org.orgId))
        .limit(1);
      const token = randomToken(32);
      const tokenHash = sha256Base64url(token);
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
      const pending = await tx
        .select({ id: invitation.id })
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, org.orgId),
            sql`lower(${invitation.email}) = ${email}`,
            eq(invitation.status, "pending"),
          ),
        )
        .limit(1);
      let id: string;
      if (pending[0]) {
        id = pending[0].id;
        await tx
          .update(invitation)
          .set({
            tokenHash,
            expiresAt,
            role: input.role,
            teamId: input.team_id ?? null,
            inviterId: actor.userId,
            createdAt: new Date(),
          })
          .where(eq(invitation.id, id));
      } else {
        const count = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(invitation)
          .where(and(eq(invitation.organizationId, org.orgId), eq(invitation.status, "pending")));
        if ((count[0]?.n ?? 0) >= PENDING_INVITATION_LIMIT)
          throw new ApiFailure(409, "invitation_limit", { limit: PENDING_INVITATION_LIMIT });
        id = uuidv7();
        await tx.insert(invitation).values({
          id,
          organizationId: org.orgId,
          email,
          role: input.role,
          teamId: input.team_id ?? null,
          status: "pending",
          expiresAt,
          inviterId: actor.userId,
          tokenHash,
        });
      }
      await audit(
        tx,
        actorEntry(actor, {
          action: "member.invited",
          orgId: org.orgId,
          targetType: "invitation",
          targetId: id,
          metadata: { role: input.role, team_id: input.team_id ?? null, resend: Boolean(pending[0]) },
        }),
      );
      return {
        id,
        email,
        role: input.role,
        teamId: input.team_id ?? null,
        expiresAt,
        token,
        orgName: orgRow[0]?.name ?? "",
      };
    },
    deps.db,
  );
  await sendMailSafely(deps, () =>
    deps.mail.send(issued.email, "invite", {
      org_name: issued.orgName,
      inviter_name: actor.name ?? actor.email,
      role: issued.role,
      url: inviteLink(deps, issued.token),
      token: issued.token,
    }),
  );
  return {
    invitation: {
      id: issued.id,
      email: issued.email,
      role: issued.role,
      team_id: issued.teamId,
      status: "pending",
      expires_at: issued.expiresAt.toISOString(),
    },
    /** 邀请人复制后自行发送（唯一一次能看到明文 token 的地方；库里只有 hash） */
    invite_url: inviteLink(deps, issued.token),
  };
}

export async function listInvites(deps: ServiceDeps, actor: Actor, org: OrgContext) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      const rows = await tx.select().from(invitation).where(eq(invitation.organizationId, org.orgId));
      rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return { invitations: rows.map(inviteView) };
    },
    deps.db,
  );
}

export async function cancelInvite(deps: ServiceDeps, actor: Actor, org: OrgContext, invId: string) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      const rows = await tx
        .update(invitation)
        .set({ status: "canceled", tokenHash: null })
        .where(
          and(
            eq(invitation.id, invId),
            eq(invitation.organizationId, org.orgId),
            eq(invitation.status, "pending"),
          ),
        )
        .returning({ id: invitation.id });
      if (!rows[0]) throw new ApiFailure(404, "not_found");
      await audit(
        tx,
        actorEntry(actor, {
          action: "member.invite_canceled",
          orgId: org.orgId,
          targetType: "invitation",
          targetId: invId,
        }),
      );
      return { id: invId, status: "canceled" };
    },
    deps.db,
  );
}

export async function resendInvite(deps: ServiceDeps, actor: Actor, org: OrgContext, invId: string) {
  await assertInviteRate(org.orgId);
  const issued = await withUserTx(
    actor.userId,
    async (tx): Promise<IssuedInvite> => {
      const rows = await tx
        .select({
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          teamId: invitation.teamId,
          status: invitation.status,
        })
        .from(invitation)
        .where(and(eq(invitation.id, invId), eq(invitation.organizationId, org.orgId)))
        .limit(1);
      const inv = rows[0];
      if (inv?.status !== "pending") throw new ApiFailure(404, "not_found");
      await assertSeatAvailable(tx, org.orgId);
      const token = randomToken(32);
      const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
      await tx
        .update(invitation)
        .set({ tokenHash: sha256Base64url(token), expiresAt, inviterId: actor.userId })
        .where(eq(invitation.id, invId));
      const orgRow = await tx
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, org.orgId))
        .limit(1);
      await audit(
        tx,
        actorEntry(actor, {
          action: "member.invited",
          orgId: org.orgId,
          targetType: "invitation",
          targetId: invId,
          metadata: { resend: true },
        }),
      );
      return {
        id: inv.id,
        email: inv.email,
        role: inv.role ?? "member",
        teamId: inv.teamId,
        expiresAt,
        token,
        orgName: orgRow[0]?.name ?? "",
      };
    },
    deps.db,
  );
  await sendMailSafely(deps, () =>
    deps.mail.send(issued.email, "invite", {
      org_name: issued.orgName,
      inviter_name: actor.name ?? actor.email,
      role: issued.role,
      url: inviteLink(deps, issued.token),
      token: issued.token,
    }),
  );
  return {
    invitation: {
      id: issued.id,
      email: issued.email,
      role: issued.role,
      status: "pending",
      expires_at: issued.expiresAt.toISOString(),
    },
    invite_url: inviteLink(deps, issued.token),
  };
}

/** 匿名预览：只返回 org 名、邀请人、角色、过期时间（供 Web 页渲染） */
export async function previewInvite(deps: ServiceDeps, token: string) {
  const rows = await deps.db
    .select({
      id: invitation.id,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      orgName: organization.name,
      orgDeleted: organization.deletedAt,
      inviterName: user.name,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .innerJoin(user, eq(user.id, invitation.inviterId))
    .where(eq(invitation.tokenHash, sha256Base64url(token)))
    .limit(1);
  const inv = rows[0];
  if (!inv || inv.orgDeleted || inv.status !== "pending" || inv.expiresAt.getTime() <= Date.now())
    throw new ApiFailure(404, "not_found");
  return {
    invitation: {
      org_name: inv.orgName,
      inviter_name: inv.inviterName,
      role: inv.role ?? "member",
      expires_at: inv.expiresAt.toISOString(),
    },
  };
}

/** 接受：token → FOR UPDATE → 邮箱一致（不要求邮箱已验证：账号模型不验证邮箱）→ 席位闸门 → member(active)（被移除过的行复活）→ teamMember → accepted → 通知邀请人 */
export async function acceptInvitationByToken(deps: ServiceDeps, actor: Actor, token: string) {
  const result = await withUserTx(
    actor.userId,
    async (tx) => {
      const locked = await tx.execute(sql`
        SELECT i.id, i."organizationId" AS org_id, i.email, i.role, i."teamId" AS team_id, i."inviterId" AS inviter_id
        FROM invitation i JOIN organization o ON o.id = i."organizationId"
        WHERE i.token_hash = ${sha256Base64url(token)} AND i.status = 'pending' AND i."expiresAt" > now() AND o.deleted_at IS NULL
        FOR UPDATE OF i`);
      const inv = locked.rows[0] as
        | {
            id: string;
            org_id: string;
            email: string;
            role: string | null;
            team_id: string | null;
            inviter_id: string;
          }
        | undefined;
      if (!inv) throw new ApiFailure(404, "not_found");
      if (inv.email.toLowerCase() !== actor.email.toLowerCase())
        throw new ApiFailure(403, "invitation_email_mismatch");
      const existing = await tx
        .select({ id: member.id, status: member.status })
        .from(member)
        .where(and(eq(member.organizationId, inv.org_id), eq(member.userId, actor.userId)))
        .limit(1);
      if (existing[0] && existing[0].status !== "removed") throw new ApiFailure(409, "already_member");
      await assertSeatAvailable(tx, inv.org_id);
      const role = inv.role === "admin" ? "admin" : "member";
      const now = new Date();
      if (existing[0]) {
        await tx
          .update(member)
          .set({
            role,
            status: "active",
            removedAt: null,
            createdAt: now,
            seatBillable: true,
            sessionEpoch: sql`${member.sessionEpoch} + 1`,
          })
          .where(eq(member.id, existing[0].id));
      } else {
        await tx.insert(member).values({
          id: uuidv7(),
          organizationId: inv.org_id,
          userId: actor.userId,
          role,
          status: "active",
          createdAt: now,
        });
      }
      if (inv.team_id) {
        const t = await tx
          .select({ id: team.id })
          .from(team)
          .where(and(eq(team.id, inv.team_id), eq(team.organizationId, inv.org_id)))
          .limit(1);
        if (t[0]) {
          await tx
            .insert(teamMember)
            .values({
              id: uuidv7(),
              teamId: inv.team_id,
              userId: actor.userId,
              membershipKey: `${inv.team_id}:${actor.userId}`,
              createdAt: now,
            })
            .onConflictDoNothing();
          await tx.execute(
            sql`UPDATE team SET "memberCount" = (SELECT count(*) FROM "teamMember" WHERE "teamId" = ${inv.team_id}) WHERE id = ${inv.team_id}`,
          );
        }
      }
      await tx
        .update(invitation)
        .set({ status: "accepted", tokenHash: null })
        .where(eq(invitation.id, inv.id));
      await audit(
        tx,
        actorEntry(actor, {
          action: "member.invite_accepted",
          orgId: inv.org_id,
          targetType: "invitation",
          targetId: inv.id,
          after: { role, team_id: inv.team_id },
        }),
      );
      const orgRow = await tx
        .select({ name: organization.name, slug: organization.slug })
        .from(organization)
        .where(eq(organization.id, inv.org_id))
        .limit(1);
      const inviter = await tx
        .select({ email: user.email, name: user.name })
        .from(user)
        .where(eq(user.id, inv.inviter_id))
        .limit(1);
      invalidateMemberCache(actor.userId, inv.org_id);
      return {
        orgId: inv.org_id,
        orgName: orgRow[0]?.name ?? "",
        orgSlug: orgRow[0]?.slug ?? "",
        role,
        invitationId: inv.id,
        teamId: inv.team_id,
        inviter: inviter[0] ?? null,
      };
    },
    deps.db,
  );
  if (result.inviter) {
    const inviter = result.inviter;
    await sendMailSafely(deps, () =>
      deps.mail.send(inviter.email, "invite_accepted", {
        name: inviter.name,
        org_name: result.orgName,
        member_name: actor.name ?? actor.email,
        member_email: actor.email,
      }),
    );
  }
  return {
    invitation: { id: result.invitationId, status: "accepted" },
    member: {
      organization_id: result.orgId,
      user_id: actor.userId,
      role: result.role,
      team_id: result.teamId,
    },
    organization: { id: result.orgId, name: result.orgName, slug: result.orgSlug },
  };
}

export async function rejectInvitationByToken(deps: ServiceDeps, actor: Actor, token: string) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      const rows = await tx
        .select({ id: invitation.id, email: invitation.email, orgId: invitation.organizationId })
        .from(invitation)
        .where(and(eq(invitation.tokenHash, sha256Base64url(token)), eq(invitation.status, "pending")))
        .limit(1);
      const inv = rows[0];
      if (!inv) throw new ApiFailure(404, "not_found");
      if (inv.email.toLowerCase() !== actor.email.toLowerCase())
        throw new ApiFailure(403, "invitation_email_mismatch");
      await tx
        .update(invitation)
        .set({ status: "rejected", tokenHash: null })
        .where(eq(invitation.id, inv.id));
      await audit(
        tx,
        actorEntry(actor, {
          action: "member.invite_rejected",
          orgId: inv.orgId,
          targetType: "invitation",
          targetId: inv.id,
        }),
      );
      return { invitation: { id: inv.id, status: "rejected" } };
    },
    deps.db,
  );
}
