// =============================================================================
// /v1 账号 / 设备 / 组织 / 成员 / 邀请 / 团队 / 审计 路由（规格 04 §6.2 / §6.3）。B2 以 app.route('/v1', v1Routes) 挂载。
// -----------------------------------------------------------------------------
// * 匿名的只有 GET /invites/:token/preview（10/min/ip）与 POST /auth/reset-with-code（安全码重置密码，5/15min/ip+email）；
//   其余全部 requireBearer；带 cookie 无 Bearer → 401（seam 保证）。
// * 已认证 600/min/user 限流；org 路由再过 requireOrgRole；body 全部 zod .strict()；响应统一 server_time。
// * 每个 service 自己开 withUserTx 并写审计；ApiFailure → 对应状态码。
// =============================================================================
import { zValidator } from "@hono/zod-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { rateLimit } from "../security/rate-limit.js";
import { requireAdminActor, requireSuperAdmin } from "./admin-guard.js";
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
import type { AuthVariables, BearerVerifier } from "./index.js";
import { type OrgVariables, requireOrgRole } from "./org-guard.js";
import { securityCodeSchema } from "./security-code.js";
import {
  adminSetPassword,
  freezeUser,
  getUserDetail,
  listAdminAudit,
  listPlatformAdmins,
  listUserNotes,
  listUsers,
  listUserWorkspaces,
  readUserNote,
  unfreezeUser,
} from "./services/admin.js";
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
import { cancelDeletion, changeSecurityCode, getMe, scheduleDeletion } from "./services/me.js";
import { leaveOrg, listMembers, removeMember, setSuspended, updateMemberRole } from "./services/members.js";
import { createOrg, deleteOrg, getOrg, listOrgs, transferOrg, updateOrg } from "./services/orgs.js";
import { resetPasswordWithSecurityCode } from "./services/security-code.js";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  listTeamMembers,
  listTeams,
  removeTeamMember,
  updateTeam,
} from "./services/teams.js";
import { requireBearerOrWebSession } from "./web-session.js";

export type V1Env = { Variables: AuthVariables & OrgVariables };

export const AUTHENTICATED_RATE_LIMIT = { limit: 600, windowSeconds: 60 };
export const ANON_PREVIEW_RATE_LIMIT = { limit: 10, windowSeconds: 60 };
export const RESET_WITH_CODE_RATE_LIMIT = { limit: 5, windowSeconds: 15 * 60 };

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
/** 与 Better Auth emailAndPassword.min/maxPasswordLength 一致 */
const passwordSchema = z.string().min(8).max(128);
const resetWithCodeBody = z
  .object({ email: emailSchema, security_code: securityCodeSchema, new_password: passwordSchema })
  .strict();
const changeSecurityCodeBody = z
  .object({ password: z.string().min(1).max(128), new_security_code: securityCodeSchema })
  .strict();

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

  // ---------------------------------------------------------------- 匿名：安全码重置密码（5 / 15 min / ip+email；先校验 body 再计数）
  app.post(
    "/auth/reset-with-code",
    zValidator("json", resetWithCodeBody, validationHook),
    rateLimit({
      name: "reset_with_code",
      key: (c) => {
        const body = (c.req as unknown as { valid: (t: "json") => z.output<typeof resetWithCodeBody> }).valid(
          "json",
        );
        return `${requestMeta(c).ip ?? "unknown"}:${body.email}`;
      },
      ...RESET_WITH_CODE_RATE_LIMIT,
    }),
    async (c) => {
      const body = c.req.valid("json");
      return ok(
        c,
        await resetPasswordWithSecurityCode(deps, requestMeta(c), {
          email: body.email,
          securityCode: body.security_code,
          newPassword: body.new_password,
        }),
      );
    },
  );

  // ---------------------------------------------------------------- 平台总管理员（/v1/admin/*）
  // 用 route("/admin", …) 显式前缀挂载：如果写成 route("/", adminApp) 且 adminApp 内部 use("*")，
  // 那个闸门会命中整个 /v1（包括 /v1/notes），全站瘫痪。
  // 挂在下面那句全局 requireBearer **之前**：管理台在浏览器里跑、只有同源会话 cookie，
  // 走不通只认 Bearer 的那条路（详见 requireAdminActor 的注释）。
  const adminApp = new Hono<V1Env>();
  adminApp.use(
    "*",
    requireAdminActor({
      db: deps.db,
      enabled: deps.env.platformAdminEnabled,
      verify,
      resolveSession: deps.resolveSession,
      appOrigins: deps.env.appOrigins,
    }),
  );
  adminApp.use(
    "*",
    rateLimit({
      name: "v1_admin",
      key: (c) => (c.get("auth") as AuthVariables["auth"] | undefined)?.userId ?? null,
      ...AUTHENTICATED_RATE_LIMIT,
    }),
  );
  adminApp.use("*", requireSuperAdmin({ db: deps.db, enabled: deps.env.platformAdminEnabled }));

  /** 分页参数：坏值一律回落到缺省，不让一个手抖的查询串变成 500 */
  const page = (c: Context<V1Env>) => {
    const n = (v: string | undefined, d: number) => {
      const x = Number(v);
      return Number.isFinite(x) && x >= 0 ? x : d;
    };
    return { limit: n(c.req.query("limit"), 50), offset: n(c.req.query("offset"), 0) };
  };

  adminApp.get("/users", async (c) =>
    ok(
      c,
      await listUsers(deps, actorOf(c), {
        q: c.req.query("q"),
        ...page(c),
        frozenOnly: c.req.query("frozen") === "1",
      }),
    ),
  );

  adminApp.get("/admins", async (c) => ok(c, await listPlatformAdmins(deps)));

  adminApp.get("/audit", async (c) =>
    ok(
      c,
      await listAdminAudit(deps, actorOf(c), {
        ...page(c),
        targetUserId: c.req.query("user_id"),
      }),
    ),
  );

  const adminUser = new Hono<V1Env>();
  const targetOf = (c: Context<V1Env>): string => {
    const id = idSchema.safeParse(c.req.param("id"));
    if (!id.success) throw new ApiFailure(404, "not_found");
    return id.data;
  };

  const workspaceIdOf = (c: Context<V1Env>): string | undefined => {
    const raw = c.req.query("workspace_id");
    if (raw === undefined || raw === "") return undefined;
    const parsed = uuidSchema.safeParse(raw);
    if (!parsed.success) throw new ApiFailure(400, "validation_failed");
    return parsed.data;
  };

  adminUser.get("/", async (c) => ok(c, await getUserDetail(deps, actorOf(c), targetOf(c))));
  adminUser.get("/workspaces", async (c) => ok(c, await listUserWorkspaces(deps, actorOf(c), targetOf(c))));
  adminUser.get("/notes", async (c) =>
    ok(
      c,
      await listUserNotes(deps, actorOf(c), targetOf(c), {
        // 未校验的 workspace_id 直接进 ::uuid 会让一个手敲的查询串变成 500
        workspaceId: workspaceIdOf(c),
        q: c.req.query("q"),
        ...page(c),
        includeDeleted: c.req.query("include_deleted") === "1",
      }),
    ),
  );
  adminUser.get("/notes/:noteId", async (c) => {
    const noteId = uuidSchema.safeParse(c.req.param("noteId"));
    if (!noteId.success) throw new ApiFailure(404, "not_found");
    return ok(c, await readUserNote(deps, actorOf(c), targetOf(c), noteId.data));
  });
  adminUser.post(
    "/freeze",
    zValidator("json", z.object({ reason: z.string().trim().max(200).optional() }).strict(), validationHook),
    async (c) => ok(c, await freezeUser(deps, actorOf(c), targetOf(c), c.req.valid("json").reason ?? null)),
  );
  adminUser.post("/unfreeze", async (c) => ok(c, await unfreezeUser(deps, actorOf(c), targetOf(c))));
  adminUser.post(
    "/password",
    zValidator("json", z.object({ new_password: z.string().min(8).max(128) }).strict(), validationHook),
    async (c) =>
      ok(c, await adminSetPassword(deps, actorOf(c), targetOf(c), c.req.valid("json").new_password)),
  );
  adminApp.route("/users/:id", adminUser);

  app.route("/admin", adminApp);

  // ---------------------------------------------------------------- 以下全部 Bearer / 同源会话 + 600/min/user
  // 浏览器里的网页端（含 PWA）拿不到 Bearer——那是 oauth-provider 给桌面端签的令牌。
  // 这里接受同源的 Better Auth 会话 cookie，三层 CSRF 防御见 requireBearerOrWebSession 的注释。
  app.use(
    "*",
    requireBearerOrWebSession({
      db: deps.db,
      verify,
      resolveSession: deps.resolveSession,
      appOrigins: deps.env.appOrigins,
    }),
  );
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
  app.post("/me/security-code", zValidator("json", changeSecurityCodeBody, validationHook), async (c) => {
    const body = c.req.valid("json");
    return ok(
      c,
      await changeSecurityCode(deps, actorOf(c), {
        password: body.password,
        newSecurityCode: body.new_security_code,
      }),
    );
  });
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
