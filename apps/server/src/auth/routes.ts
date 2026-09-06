// =============================================================================
// /v1 账号 / 设备 / 组织 / 成员 / 邀请 / 团队 / 审计 路由（规格 04 §6.2 / §6.3）。B2 以 app.route('/v1', v1Routes) 挂载。
// -----------------------------------------------------------------------------
// * 除 GET /invites/:token/preview（匿名，10/min/ip）外全部 requireBearer；带 cookie 无 Bearer → 401（seam 保证）。
// * 已认证 600/min/user 限流；org 路由再过 requireOrgRole；body 全部 zod .strict()；响应统一 server_time。
// * 每个 service 自己开 withUserTx 并写审计；ApiFailure → 对应状态码。
// =============================================================================
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { rateLimit } from "../security/rate-limit.js";
import {
  ApiFailure,
  emailSchema,
  fail,
  idSchema,
  nameSchema,
  ok,
  requestMeta,
  uuidSchema,
  validationHook,
} from "./http.js";
import { type AuthVariables, type BearerVerifier, requireBearer } from "./index.js";
import { type OrgVariables, requireOrgRole } from "./org-guard.js";
import { auditToCsv, listAudit } from "./services/audit-query.js";
import type { Actor, ServiceDeps } from "./services/context.js";
import { listDevices, revokeAllDevices, revokeDevice } from "./services/devices.js";
import {
  acceptInvitationByToken,
  cancelInvite,
  createInvite,
  listInvites,
  previewInvite,
  rejectInvitationByToken,
  resendInvite,
} from "./services/invites.js";
import { cancelDeletion, getMe, scheduleDeletion } from "./services/me.js";
import { leaveOrg, listMembers, removeMember, setSuspended, updateMemberRole } from "./services/members.js";
import { createOrg, deleteOrg, getOrg, listOrgs, transferOrg, updateOrg } from "./services/orgs.js";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  listTeamMembers,
  listTeams,
  removeTeamMember,
  updateTeam,
} from "./services/teams.js";

export type V1Env = { Variables: AuthVariables & OrgVariables };

export const AUTHENTICATED_RATE_LIMIT = { limit: 600, windowSeconds: 60 };
export const ANON_PREVIEW_RATE_LIMIT = { limit: 10, windowSeconds: 60 };

function actorOf(c: Context<V1Env>): Actor {
  const auth = c.get("auth");
  const meta = requestMeta(c);
  return {
    userId: auth.userId,
    email: auth.email,
    emailVerified: auth.emailVerified,
    deviceId: auth.deviceId,
    ip: meta.ip,
    ua: meta.ua,
    requestId: meta.requestId,
  };
}

const roleSchema = z.enum(["admin", "member"]);
const tokenSchema = z
  .string()
  .min(20)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const confirmDelete = z.object({ confirm: z.literal("DELETE") }).strict();

export function buildV1Routes(deps: ServiceDeps, verify: BearerVerifier): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<V1Env>();

  app.onError((err, c) => {
    if (err instanceof ApiFailure) return fail(c, err.status, err.code, err.extra);
    deps.log.error(
      { err: err instanceof Error ? { message: err.message, stack: err.stack } : err, path: c.req.path },
      "v1 route failed",
    );
    return fail(c, 500, "internal_error");
  });

  // ---------------------------------------------------------------- 匿名：邀请预览（10/min/ip）
  app.get(
    "/invites/:token/preview",
    rateLimit({
      name: "invite_preview",
      key: (c) => requestMeta(c).ip ?? "unknown",
      ...ANON_PREVIEW_RATE_LIMIT,
    }),
    async (c) => {
      const token = tokenSchema.safeParse(c.req.param("token"));
      if (!token.success) return fail(c, 404, "not_found");
      return ok(c, await previewInvite(deps, token.data));
    },
  );

  // ---------------------------------------------------------------- 以下全部 Bearer + 600/min/user
  app.use("*", requireBearer(verify));
  app.use(
    "*",
    rateLimit({
      name: "v1_user",
      key: (c) => (c.get("auth") as AuthVariables["auth"] | undefined)?.userId ?? null,
      ...AUTHENTICATED_RATE_LIMIT,
    }),
  );

  // ---- me
  app.get("/me", async (c) => ok(c, await getMe(deps, actorOf(c))));
  app.get("/me/devices", async (c) => ok(c, await listDevices(deps, actorOf(c))));
  app.delete("/me/devices/:id", async (c) => {
    const id = uuidSchema.safeParse(c.req.param("id"));
    if (!id.success) return fail(c, 404, "not_found");
    return ok(c, await revokeDevice(deps, actorOf(c), id.data));
  });
  app.post(
    "/me/devices/revoke-all",
    zValidator(
      "json",
      z.object({ keep_current: z.boolean().optional() }).strict().optional(),
      validationHook,
    ),
    async (c) => {
      const body = c.req.valid("json") ?? {};
      return ok(c, await revokeAllDevices(deps, actorOf(c), { keepCurrent: body.keep_current ?? false }));
    },
  );
  app.post("/me/delete", zValidator("json", confirmDelete, validationHook), async (c) =>
    ok(c, await scheduleDeletion(deps, actorOf(c)), 202),
  );
  app.post("/me/delete/cancel", async (c) => ok(c, await cancelDeletion(deps, actorOf(c))));

  // ---- invites（被邀请人视角）
  app.post(
    "/invites/accept",
    zValidator("json", z.object({ token: tokenSchema }).strict(), validationHook),
    async (c) => ok(c, await acceptInvitationByToken(deps, actorOf(c), c.req.valid("json").token)),
  );
  app.post(
    "/invites/reject",
    zValidator("json", z.object({ token: tokenSchema }).strict(), validationHook),
    async (c) => ok(c, await rejectInvitationByToken(deps, actorOf(c), c.req.valid("json").token)),
  );

  // ---- orgs（不需要 X-Organization-Id 的两条）
  app.post(
    "/orgs",
    zValidator(
      "json",
      z.object({ name: nameSchema, slug: z.string().trim().min(2).max(40).optional() }).strict(),
      validationHook,
    ),
    async (c) => ok(c, await createOrg(deps, actorOf(c), c.req.valid("json")), 201),
  );
  app.get("/orgs", async (c) => ok(c, await listOrgs(deps, actorOf(c))));

  // ---- orgs/:id（X-Organization-Id 必须与路径一致）
  const org = new Hono<V1Env>();
  org.use("*", async (c, next) => {
    const pathId = c.req.param("id");
    const header = c.req.header("x-organization-id");
    if (!header) return fail(c, 400, "no_active_organization");
    if (pathId && header !== pathId) return fail(c, 400, "organization_mismatch");
    await next();
  });

  const member = requireOrgRole("member", { db: deps.db });
  const admin = requireOrgRole("admin", { db: deps.db });
  const owner = requireOrgRole("owner", { db: deps.db });

  org.get("/", member, async (c) => ok(c, await getOrg(deps, actorOf(c), c.get("org"))));
  org.patch(
    "/",
    admin,
    zValidator(
      "json",
      z
        .object({
          name: nameSchema.optional(),
          slug: z.string().trim().min(2).max(40).optional(),
          allow_public_links: z.boolean().optional(),
          enterprise_mode: z.boolean().optional(),
        })
        .strict(),
      validationHook,
    ),
    async (c) => ok(c, await updateOrg(deps, actorOf(c), c.get("org"), c.req.valid("json"))),
  );
  org.delete("/", owner, async (c) => ok(c, await deleteOrg(deps, actorOf(c), c.get("org"))));
  org.post(
    "/transfer",
    owner,
    zValidator("json", z.object({ to_user_id: idSchema }).strict(), validationHook),
    async (c) => ok(c, await transferOrg(deps, actorOf(c), c.get("org"), c.req.valid("json").to_user_id)),
  );
  org.post("/leave", member, async (c) => ok(c, await leaveOrg(deps, actorOf(c), c.get("org"))));

  // members
  org.get("/members", member, async (c) => ok(c, await listMembers(deps, actorOf(c), c.get("org"))));
  org.patch(
    "/members/:uid",
    admin,
    zValidator("json", z.object({ role: roleSchema }).strict(), validationHook),
    async (c) =>
      ok(
        c,
        await updateMemberRole(deps, actorOf(c), c.get("org"), c.req.param("uid"), c.req.valid("json").role),
      ),
  );
  org.delete("/members/:uid", admin, async (c) =>
    ok(c, await removeMember(deps, actorOf(c), c.get("org"), c.req.param("uid"))),
  );
  org.post("/members/:uid/suspend", admin, async (c) =>
    ok(c, await setSuspended(deps, actorOf(c), c.get("org"), c.req.param("uid"), true)),
  );
  org.post("/members/:uid/unsuspend", admin, async (c) =>
    ok(c, await setSuspended(deps, actorOf(c), c.get("org"), c.req.param("uid"), false)),
  );

  // invites（管理视角）
  org.post(
    "/invites",
    admin,
    zValidator(
      "json",
      z
        .object({ email: emailSchema, role: roleSchema.default("member"), team_id: idSchema.optional() })
        .strict(),
      validationHook,
    ),
    async (c) => ok(c, await createInvite(deps, actorOf(c), c.get("org"), c.req.valid("json")), 201),
  );
  org.get("/invites", admin, async (c) => ok(c, await listInvites(deps, actorOf(c), c.get("org"))));
  org.delete("/invites/:inv", admin, async (c) =>
    ok(c, await cancelInvite(deps, actorOf(c), c.get("org"), c.req.param("inv"))),
  );
  org.post("/invites/:inv/resend", admin, async (c) =>
    ok(c, await resendInvite(deps, actorOf(c), c.get("org"), c.req.param("inv"))),
  );

  // teams
  org.post(
    "/teams",
    admin,
    zValidator(
      "json",
      z.object({ name: nameSchema, color: colorSchema.optional() }).strict(),
      validationHook,
    ),
    async (c) => ok(c, await createTeam(deps, actorOf(c), c.get("org"), c.req.valid("json")), 201),
  );
  org.get("/teams", member, async (c) => ok(c, await listTeams(deps, actorOf(c), c.get("org"))));
  org.patch(
    "/teams/:tid",
    admin,
    zValidator(
      "json",
      z.object({ name: nameSchema.optional(), color: colorSchema.nullable().optional() }).strict(),
      validationHook,
    ),
    async (c) =>
      ok(c, await updateTeam(deps, actorOf(c), c.get("org"), c.req.param("tid"), c.req.valid("json"))),
  );
  org.delete("/teams/:tid", admin, async (c) =>
    ok(c, await deleteTeam(deps, actorOf(c), c.get("org"), c.req.param("tid"))),
  );
  org.get("/teams/:tid/members", member, async (c) =>
    ok(c, await listTeamMembers(deps, actorOf(c), c.get("org"), c.req.param("tid"))),
  );
  org.put("/teams/:tid/members/:uid", admin, async (c) =>
    ok(c, await addTeamMember(deps, actorOf(c), c.get("org"), c.req.param("tid"), c.req.param("uid"))),
  );
  org.delete("/teams/:tid/members/:uid", admin, async (c) =>
    ok(c, await removeTeamMember(deps, actorOf(c), c.get("org"), c.req.param("tid"), c.req.param("uid"))),
  );

  // audit
  const auditQuery = z
    .object({
      since: z.iso.datetime({ offset: true }).optional(),
      until: z.iso.datetime({ offset: true }).optional(),
      action: z.string().min(1).max(64).optional(),
      cursor: z.string().regex(/^\d+$/).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    })
    .strict();
  const toQuery = (q: z.output<typeof auditQuery>) => ({
    since: q.since ? new Date(q.since) : undefined,
    until: q.until ? new Date(q.until) : undefined,
    action: q.action,
    cursor: q.cursor,
    limit: q.limit,
  });
  org.get("/audit", admin, zValidator("query", auditQuery, validationHook), async (c) =>
    ok(c, await listAudit(deps, actorOf(c), c.get("org"), toQuery(c.req.valid("query")))),
  );
  org.get("/audit/export.csv", admin, zValidator("query", auditQuery, validationHook), async (c) => {
    const q = toQuery(c.req.valid("query"));
    const result = await listAudit(deps, actorOf(c), c.get("org"), { ...q, limit: 500 });
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="audit-${c.get("org").orgId}.csv"`);
    return c.body(auditToCsv(result.entries));
  });

  app.route("/orgs/:id", org);
  return app as unknown as Hono<{ Variables: AuthVariables }>;
}
