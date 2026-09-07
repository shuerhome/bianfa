// 组织 / 成员 / 邀请（服务端 src/auth/routes.ts B1 路由 + auth/services/{orgs,members,invites}.ts）。
//   POST /v1/orgs、GET /v1/orgs 不需要额外头；/v1/orgs/:id/** 全部要求请求头 X-Organization-Id 与路径 id 一致
//   （auth/org-guard.ts：缺 → 400 no_active_organization；不一致 → 400 organization_mismatch）。
//   头通过 IPC api_request 的 `headers` 参数透传：Rust 侧 api_request 需接受 headers: Option<HashMap<String,String>>
//   并原样加到请求上；在 Rust 支持之前，服务端会回 no_active_organization，UI 把它映射成「请升级客户端」。
//   B1 的校验失败是 400 validation_failed（与 B2 的 validation_error 不同）。
import { call } from "../ipc/commands.js";
import { IpcError } from "../ipc/errors.js";
import type { ApiResponse } from "../ipc/types.js";
import { apiJson, type HttpMethod, isoToMs, toApiError } from "./http.js";
import type { MemberStatus, OrgRole, Plan } from "./me.js";

export const ORG_HEADER = "X-Organization-Id";

/** 组织管理路由的稳定错误码（服务端 auth/services/*.ts ApiFailure） */
export const ORG_ERROR = {
  noActiveOrganization: "no_active_organization",
  organizationMismatch: "organization_mismatch",
  organizationLimit: "organization_limit",
  slugTaken: "slug_taken",
  alreadyMember: "already_member",
  seatLimit: "seat_limit",
  invitationLimit: "invitation_limit",
  teamNotFound: "team_not_found",
  rateLimited: "rate_limited",
  cannotChangeOwnRole: "cannot_change_own_role",
  cannotModifyOwner: "cannot_modify_owner",
  cannotSuspendSelf: "cannot_suspend_self",
  insufficientRole: "insufficient_role",
  memberNotFound: "member_not_found",
  useLeave: "use_leave",
  transferOwnershipFirst: "transfer_ownership_first",
  validationFailed: "validation_failed",
} as const;

/** 与 http.ts apiJson 同形，但带 X-Organization-Id（apiJson 没有 headers 选项） */
async function orgJson<T>(
  orgId: string,
  method: HttpMethod,
  path: string,
  opts: { body?: unknown } = {},
): Promise<T> {
  if (!path.startsWith("/v1/")) throw new IpcError("bad_path", "api_request path 必须以 /v1/ 开头");
  const res = await call<ApiResponse>("api_request", {
    method,
    path,
    ...(opts.body !== undefined ? { jsonBody: opts.body } : {}),
    timeoutMs: 15_000,
    headers: { [ORG_HEADER]: orgId },
  });
  if (res.status < 200 || res.status >= 300) throw toApiError(res);
  if (res.status === 204 || res.bodyText.length === 0) return undefined as T;
  try {
    return JSON.parse(res.bodyText) as T;
  } catch {
    throw new IpcError("bad_json", "服务端返回了无法解析的内容", {
      status: res.status,
      body: null,
      requestId: null,
    });
  }
}

const orgPath = (orgId: string, rest = "") => `/v1/orgs/${encodeURIComponent(orgId)}${rest}`;

// ── 组织 ──

export interface CreatedOrg {
  id: string;
  name: string;
  slug: string | null;
  plan: Plan;
  seatsPaid: number;
  createdAt: number | null;
  role: OrgRole;
}

/** POST /v1/orgs { name, slug? } → 201 { org, default_workspace_id }（slug 缺省由服务端按 name 生成；自动建「共享区」工作区） */
export async function createOrg(input: { name: string; slug?: string }): Promise<{
  org: CreatedOrg;
  defaultWorkspaceId: string | null;
}> {
  const body: Record<string, unknown> = { name: input.name.trim() };
  if (input.slug) body.slug = input.slug.trim();
  const r = await apiJson<{
    org: {
      id: string;
      name: string;
      slug: string | null;
      plan: Plan;
      seats_paid: number;
      created_at: string;
      role: OrgRole;
    };
    default_workspace_id: string | null;
  }>("POST", "/v1/orgs", { body });
  return {
    org: {
      id: r.org.id,
      name: r.org.name,
      slug: r.org.slug ?? null,
      plan: r.org.plan ?? "free",
      seatsPaid: r.org.seats_paid ?? 1,
      createdAt: isoToMs(r.org.created_at),
      role: r.org.role ?? "owner",
    },
    defaultWorkspaceId: r.default_workspace_id ?? null,
  };
}

export interface OrgDetail {
  id: string;
  name: string;
  slug: string | null;
  logo: string | null;
  plan: Plan;
  seatsPaid: number;
  activeSeats: number;
  memberCount: number;
  allowPublicLinks: boolean;
  enterpriseMode: boolean;
  createdAt: number | null;
  role: OrgRole;
}

/** GET /v1/orgs/:id（member） */
export async function fetchOrg(orgId: string): Promise<OrgDetail> {
  const r = await orgJson<{
    org: {
      id: string;
      name: string;
      slug: string | null;
      logo: string | null;
      plan: Plan;
      seats_paid: number;
      active_seats: number;
      member_count: number;
      allow_public_links: boolean;
      enterprise_mode: boolean;
      created_at: string;
      role: OrgRole;
    };
  }>(orgId, "GET", orgPath(orgId));
  const o = r.org;
  return {
    id: o.id,
    name: o.name,
    slug: o.slug ?? null,
    logo: o.logo ?? null,
    plan: o.plan ?? "free",
    seatsPaid: o.seats_paid ?? 1,
    activeSeats: o.active_seats ?? 0,
    memberCount: o.member_count ?? 0,
    allowPublicLinks: Boolean(o.allow_public_links),
    enterpriseMode: Boolean(o.enterprise_mode),
    createdAt: isoToMs(o.created_at),
    role: o.role,
  };
}

/** POST /v1/orgs/:id/transfer { to_user_id }（owner）→ { transferred, new_owner{id,name}, your_role:"admin" } */
export async function transferOrg(
  orgId: string,
  toUserId: string,
): Promise<{ newOwner: { id: string; name: string | null }; yourRole: OrgRole }> {
  const r = await orgJson<{
    transferred: boolean;
    new_owner: { id: string; name: string | null };
    your_role: OrgRole;
  }>(orgId, "POST", orgPath(orgId, "/transfer"), { body: { to_user_id: toUserId } });
  return {
    newOwner: { id: r.new_owner.id, name: r.new_owner.name ?? null },
    yourRole: r.your_role ?? "admin",
  };
}

/** POST /v1/orgs/:id/leave（member；owner → 409 transfer_ownership_first） */
export async function leaveOrg(orgId: string): Promise<void> {
  await orgJson<unknown>(orgId, "POST", orgPath(orgId, "/leave"));
}

// ── 成员 ──

export interface Member {
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  role: OrgRole;
  status: MemberStatus;
  seatBillable: boolean;
  joinedAt: number | null;
}

interface MemberDto {
  user_id: string;
  name: string | null;
  email: string;
  image: string | null;
  role: OrgRole;
  status: MemberStatus;
  seat_billable: boolean;
  joined_at: string;
}

export function mapMember(m: MemberDto): Member {
  return {
    userId: m.user_id,
    name: m.name ?? null,
    email: m.email,
    image: m.image ?? null,
    role: m.role,
    status: m.status ?? "active",
    seatBillable: Boolean(m.seat_billable),
    joinedAt: isoToMs(m.joined_at),
  };
}

const ROLE_ORDER: Record<OrgRole, number> = { owner: 0, admin: 1, member: 2 };

/** GET /v1/orgs/:id/members（member；不含 removed）→ 所有者 / 管理员 / 成员，同级按加入时间 */
export async function listMembers(orgId: string): Promise<Member[]> {
  const r = await orgJson<{ members: MemberDto[] }>(orgId, "GET", orgPath(orgId, "/members"));
  return (r.members ?? [])
    .map(mapMember)
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.joinedAt ?? 0) - (b.joinedAt ?? 0));
}

export type AssignableRole = Exclude<OrgRole, "owner">;

/** PATCH /v1/orgs/:id/members/:uid { role }（admin；设 admin 需 owner） */
export async function updateMemberRole(
  orgId: string,
  userId: string,
  role: AssignableRole,
): Promise<{ userId: string; role: OrgRole }> {
  const r = await orgJson<{ user_id: string; role: OrgRole }>(
    orgId,
    "PATCH",
    orgPath(orgId, `/members/${encodeURIComponent(userId)}`),
    { body: { role } },
  );
  return { userId: r.user_id, role: r.role };
}

/** DELETE /v1/orgs/:id/members/:uid（admin；删自己 → 400 use_leave） */
export async function removeMember(
  orgId: string,
  userId: string,
): Promise<{ userId: string; sharesDeleted: number; teamsLeft: number }> {
  const r = await orgJson<{
    user_id: string;
    status: "removed";
    shares_deleted: number;
    teams_left: number;
  }>(orgId, "DELETE", orgPath(orgId, `/members/${encodeURIComponent(userId)}`));
  return { userId: r.user_id, sharesDeleted: r.shares_deleted ?? 0, teamsLeft: r.teams_left ?? 0 };
}

/** POST /v1/orgs/:id/members/:uid/suspend | /unsuspend（admin） */
export async function setMemberSuspended(
  orgId: string,
  userId: string,
  suspended: boolean,
): Promise<{ userId: string; status: MemberStatus }> {
  const r = await orgJson<{ user_id: string; status: MemberStatus }>(
    orgId,
    "POST",
    orgPath(orgId, `/members/${encodeURIComponent(userId)}/${suspended ? "suspend" : "unsuspend"}`),
  );
  return { userId: r.user_id, status: r.status };
}

// ── 邀请（管理视角；不依赖邮件：响应直接带 invite_url，复制后任意渠道发给对方） ──

export type InviteStatus = "pending" | "accepted" | "rejected" | "canceled" | "expired";

export interface Invitation {
  id: string;
  email: string;
  role: OrgRole;
  teamId: string | null;
  status: InviteStatus;
  expiresAt: number | null;
  createdAt: number | null;
  inviterId: string | null;
}

interface InvitationDto {
  id: string;
  email: string;
  role: OrgRole;
  team_id?: string | null;
  status: InviteStatus;
  expires_at: string;
  created_at?: string;
  inviter_id?: string;
}

export function mapInvitation(i: InvitationDto): Invitation {
  return {
    id: i.id,
    email: i.email,
    role: i.role ?? "member",
    teamId: i.team_id ?? null,
    status: i.status ?? "pending",
    expiresAt: isoToMs(i.expires_at),
    createdAt: isoToMs(i.created_at),
    inviterId: i.inviter_id ?? null,
  };
}

export interface InviteResult {
  invitation: Invitation;
  /** `${APP_ORIGIN}/invite/<token>`，48 小时有效 */
  inviteUrl: string;
}

/**
 * POST /v1/orgs/:id/invites { email, role?, team_id? }（admin；role=admin 需 owner）→ 201 { invitation, invite_url }。
 * 409 already_member / seat_limit / invitation_limit；429 rate_limited；400 validation_failed。
 */
export async function createInvite(
  orgId: string,
  input: { email: string; role?: AssignableRole; teamId?: string },
): Promise<InviteResult> {
  const body: Record<string, unknown> = { email: input.email.trim() };
  if (input.role) body.role = input.role;
  if (input.teamId) body.team_id = input.teamId;
  const r = await orgJson<{ invitation: InvitationDto; invite_url: string }>(
    orgId,
    "POST",
    orgPath(orgId, "/invites"),
    { body },
  );
  return { invitation: mapInvitation(r.invitation), inviteUrl: r.invite_url };
}

/** GET /v1/orgs/:id/invites（admin；含非 pending，按创建时间倒序） */
export async function listInvites(orgId: string): Promise<Invitation[]> {
  const r = await orgJson<{ invitations: InvitationDto[] }>(orgId, "GET", orgPath(orgId, "/invites"));
  return (r.invitations ?? []).map(mapInvitation);
}

/** DELETE /v1/orgs/:id/invites/:inv（admin）→ { id, status: "canceled" } */
export async function cancelInvite(orgId: string, inviteId: string): Promise<void> {
  await orgJson<{ id: string; status: string }>(
    orgId,
    "DELETE",
    orgPath(orgId, `/invites/${encodeURIComponent(inviteId)}`),
  );
}

/** POST /v1/orgs/:id/invites/:inv/resend（admin）→ { invitation, invite_url }（新 token） */
export async function resendInvite(orgId: string, inviteId: string): Promise<InviteResult> {
  const r = await orgJson<{ invitation: InvitationDto; invite_url: string }>(
    orgId,
    "POST",
    orgPath(orgId, `/invites/${encodeURIComponent(inviteId)}/resend`),
  );
  return { invitation: mapInvitation(r.invitation), inviteUrl: r.invite_url };
}
