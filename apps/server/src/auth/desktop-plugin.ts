// =============================================================================
// bianfa-desktop Better Auth 插件：给 oauth-provider / organization / 登录端点挂 hook（规格 04 §2.2 / §2.4 / §4.4 / §4.7）。
// -----------------------------------------------------------------------------
// before /oauth2/token      ：device_id 校验；refresh 复用检测（family 已被插件删除，我们补审计 + 撤销全部会话 + 邮件）；
//                            refresh 60/min/device 限流。
// after  /oauth2/token      ：读响应里的 refresh_token → 找到刚建的 refresh 行 → upsert device、Free 计划设备上限 2、绑定
//                            oauth_refresh_device；refresh 轮转时沿用旧行的设备；超限 → 撤销刚发的 token 并回 403 device_limit_reached。
// before /oauth2/revoke     ：桌面登出 → 设备 revoked_at + 审计 + NOTIFY(session)。
// before /organization/accept-invitation | reject-invitation：Web cookie 面，body.invitationId 允许传邮件 token；
//                            走与 /v1/invites/accept 相同的 service（席位闸门 / 审计 / 通知），短路插件自己的实现。
// after  /sign-in/email     ：auth.login_ok / auth.login_failed 审计；连续失败计数（10 次 → security_alert）。
// after  /change-password   ：撤销全部桌面 token + NOTIFY + 审计 + security_alert。
// =============================================================================

import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { audit } from "../audit/index.js";
import type { Db } from "../db/client.js";
import { oauthRefreshToken, user } from "../db/schema/index.js";
import type { MailProvider } from "../mail/index.js";
import { getRateLimitBackend } from "../security/rate-limit.js";
import { isUuidLike } from "../security/tokens.js";
import { isPlatformAdminUser } from "../services/quota.js";
import { auditStandalone, notifyAuthzRevoked } from "./db-helpers.js";
import type { AuthEnv } from "./env.js";
import { ApiFailure } from "./http.js";
import {
  bindRefreshToDevice,
  countActiveDevices,
  DESKTOP_CLIENT_ID,
  FREE_PLAN_DEVICE_LIMIT,
  findDeviceForRefresh,
  findRefreshIdByAccessToken,
  findRefreshRowByToken,
  isDevicePlatform,
  REFRESH_TOKEN_PREFIX,
  revokeAllUserTokens,
  touchDevice,
  upsertDevice,
} from "./oauth-tokens.js";
import { acceptInvitationByToken, rejectInvitationByToken } from "./services/invites.js";
import { userPlan } from "./services/me.js";

export interface DesktopPluginDeps {
  db: Db;
  env: AuthEnv;
  mail: MailProvider;
  log: Logger;
}

type Body = Record<string, unknown>;

function bodyOf(ctx: { body?: unknown }): Body {
  return ctx.body && typeof ctx.body === "object" ? (ctx.body as Body) : {};
}

/** ctx.json() 在 HTTP 路径返回 { body, _flag:'json' }，在 auth.api 直调路径返回裸对象 */
function jsonPayload(returned: unknown): Body | null {
  if (!returned || typeof returned !== "object") return null;
  if (returned instanceof Response || returned instanceof APIError) return null;
  const r = returned as Body;
  if (r._flag === "json" && r.body && typeof r.body === "object") return r.body as Body;
  return r;
}

function ipOf(headers: Headers | undefined): string | null {
  if (!headers) return null;
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || headers.get("x-real-ip") || null;
}

function uaOf(headers: Headers | undefined): string | null {
  return headers?.get("user-agent")?.slice(0, 512) ?? null;
}

export function bianfaDesktopPlugin(deps: DesktopPluginDeps): BetterAuthPlugin {
  const { db, env, mail, log } = deps;

  async function sendSecurityAlert(
    userId: string,
    reason: string,
    devices: Array<{ name: string; platform: string }>,
  ) {
    const rows = await db
      .select({ email: user.email, name: user.name })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const u = rows[0];
    if (!u) return;
    try {
      await mail.send(u.email, "security_alert", {
        name: u.name,
        reason,
        devices: devices.map((d) => `${d.name} (${d.platform})`),
      });
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "security_alert mail failed");
    }
  }

  /** 撤销用户全部桌面 token + Web 会话，NOTIFY session:*（改密 / 复用检测 共用） */
  async function revokeEverything(
    ctx: { context: { internalAdapter: { deleteUserSessions(userId: string): Promise<void> } } },
    userId: string,
  ) {
    const devices = await db.transaction(async (tx) => {
      const revoked = await revokeAllUserTokens(tx, userId);
      await notifyAuthzRevoked(tx, userId, "session", "*");
      return revoked;
    });
    await ctx.context.internalAdapter.deleteUserSessions(userId);
    return devices;
  }

  return {
    id: "bianfa-desktop",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx) => {
            const body = bodyOf(ctx);
            if (body.device_id !== undefined && !isUuidLike(body.device_id)) {
              throw new APIError("BAD_REQUEST", {
                error: "invalid_request",
                error_description: "device_id must be a uuid",
              });
            }
            if (body.platform !== undefined && !isDevicePlatform(body.platform)) {
              throw new APIError("BAD_REQUEST", {
                error: "invalid_request",
                error_description: "platform must be one of windows, macos, linux",
              });
            }
            if (body.grant_type !== "refresh_token" || typeof body.refresh_token !== "string") return;
            const row = await findRefreshRowByToken(db, body.refresh_token);
            if (!row) return;
            const deviceId = await findDeviceForRefresh(db, row.id);
            if (deviceId) {
              const decision = await getRateLimitBackend().consume(`oauth_refresh:${deviceId}`, 60, 60);
              if (!decision.allowed) {
                throw new APIError("TOO_MANY_REQUESTS", {
                  error: "slow_down",
                  error_description: `retry after ${decision.retryAfterSeconds}s`,
                });
              }
            }
            const replayable =
              row.rotationReplayExpiresAt && row.rotationReplayExpiresAt.getTime() > Date.now();
            if (row.revoked && !replayable) {
              // 复用检测命中：插件随后会删掉整个 family（同 client + user）；这里补齐规格 2.4 的其余动作
              log.warn({ userId: row.userId, deviceId }, "refresh token reuse detected");
              const devices = await revokeEverything(ctx, row.userId);
              await auditStandalone(db, {
                action: "auth.refresh_reuse_detected",
                actorId: row.userId,
                actorDeviceId: deviceId,
                actorIp: ipOf(ctx.headers),
                actorUa: uaOf(ctx.headers),
                targetType: "user",
                targetId: row.userId,
                outcome: "denied",
                metadata: { revoked_devices: devices.length },
              });
              await sendSecurityAlert(
                row.userId,
                "refresh token reuse detected / 刷新令牌被重复使用",
                devices,
              );
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/oauth2/revoke",
          handler: createAuthMiddleware(async (ctx) => {
            const body = bodyOf(ctx);
            const token = typeof body.token === "string" ? body.token : null;
            if (!token) return;
            let refreshId: string | null = null;
            let userId: string | null = null;
            if (token.startsWith(REFRESH_TOKEN_PREFIX) || body.token_type_hint === "refresh_token") {
              const row = await findRefreshRowByToken(db, token);
              refreshId = row?.id ?? null;
              userId = row?.userId ?? null;
            } else {
              refreshId = await findRefreshIdByAccessToken(db, token);
              if (refreshId) {
                const rows = await db
                  .select({ userId: oauthRefreshToken.userId })
                  .from(oauthRefreshToken)
                  .where(eq(oauthRefreshToken.id, refreshId))
                  .limit(1);
                userId = rows[0]?.userId ?? null;
              }
            }
            if (!refreshId || !userId) return;
            const deviceId = await findDeviceForRefresh(db, refreshId);
            if (!deviceId) return;
            const ip = ipOf(ctx.headers);
            await db.transaction(async (tx) => {
              // 本机登出：只标记设备撤销，token 行由插件随后处理（refresh 标 revoked + 删 access）
              await tx.execute(
                sql`UPDATE device SET revoked_at = now() WHERE id = ${deviceId}::uuid AND user_id = ${userId}`,
              );
              await notifyAuthzRevoked(tx, userId as string, "session", deviceId);
              await audit(tx, {
                action: "auth.device_revoked",
                actorId: userId,
                actorDeviceId: deviceId,
                actorIp: ip,
                actorUa: uaOf(ctx.headers),
                targetType: "device",
                targetId: deviceId,
                metadata: { via: "oauth2/revoke" },
              });
            });
          }),
        },
        {
          matcher: (ctx) =>
            ctx.path === "/organization/accept-invitation" || ctx.path === "/organization/reject-invitation",
          handler: createAuthMiddleware(async (ctx) => {
            const body = bodyOf(ctx);
            const token = typeof body.invitationId === "string" ? body.invitationId : "";
            if (!token) throw new APIError("BAD_REQUEST", { message: "invitationId is required" });
            const session = await getSessionFromCtx(ctx);
            if (!session) throw new APIError("UNAUTHORIZED");
            const actor = {
              userId: session.user.id,
              email: session.user.email,
              emailVerified: session.user.emailVerified,
              name: session.user.name,
              deviceId: null,
              ip: ipOf(ctx.headers),
              ua: uaOf(ctx.headers),
              requestId: ctx.headers?.get("x-request-id") ?? null,
            };
            try {
              if (ctx.path === "/organization/accept-invitation") {
                const result = await acceptInvitationByToken({ db, mail, env, log }, actor, token);
                return ctx.json(result);
              }
              const result = await rejectInvitationByToken({ db, mail, env, log }, actor, token);
              return ctx.json(result);
            } catch (err) {
              if (err instanceof ApiFailure) {
                throw new APIError(
                  err.status === 404
                    ? "NOT_FOUND"
                    : err.status === 409
                      ? "CONFLICT"
                      : err.status === 403
                        ? "FORBIDDEN"
                        : "BAD_REQUEST",
                  {
                    code: err.code,
                    message: err.code,
                    ...err.extra,
                  },
                );
              }
              throw err;
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === "/oauth2/token",
          handler: createAuthMiddleware(async (ctx) => {
            const payload = jsonPayload(ctx.context.returned);
            if (!payload || typeof payload.refresh_token !== "string") return;
            const body = bodyOf(ctx);
            const grant = body.grant_type;
            const newRow = await findRefreshRowByToken(db, payload.refresh_token);
            if (!newRow) return;
            const ip = ipOf(ctx.headers);

            if (grant === "refresh_token") {
              let deviceId: string | null = isUuidLike(body.device_id) ? body.device_id : null;
              if (!deviceId && typeof body.refresh_token === "string") {
                const oldRow = await findRefreshRowByToken(db, body.refresh_token);
                if (oldRow) deviceId = await findDeviceForRefresh(db, oldRow.id);
              }
              if (!deviceId) return;
              await db.transaction(async (tx) => {
                await bindRefreshToDevice(tx, newRow.id, deviceId, newRow.userId);
                await touchDevice(tx, deviceId, ip);
              });
              return;
            }

            // authorization_code / device_code：需要 device_* 字段才绑定；没有就当作非桌面客户端放行
            if (!isUuidLike(body.device_id)) return;
            const deviceId = body.device_id;
            const name =
              typeof body.device_name === "string" && body.device_name.trim()
                ? body.device_name.trim().slice(0, 120)
                : "Unknown device";
            const platform = isDevicePlatform(body.platform) ? body.platform : null;
            const appVersion =
              typeof body.app_version === "string" && body.app_version.trim()
                ? body.app_version.trim().slice(0, 40)
                : "0.0.0";
            if (!platform) {
              throw new APIError("BAD_REQUEST", {
                error: "invalid_request",
                error_description: "platform is required with device_id",
              });
            }

            const plan = await userPlan(db, newRow.userId);
            // 总管理员不受设备数限制（自托管的所有者不该被自己搭的收费墙挡在门外）
            const unlimited = await isPlatformAdminUser(db, newRow.userId);
            if (plan === "free" && !unlimited) {
              const active = await countActiveDevices(db, newRow.userId, deviceId);
              if (active >= FREE_PLAN_DEVICE_LIMIT) {
                // 撤销刚签发的一组 token（删 refresh 行级联 access）
                await db.delete(oauthRefreshToken).where(eq(oauthRefreshToken.id, newRow.id));
                await auditStandalone(db, {
                  action: "auth.device_limit_reached",
                  actorId: newRow.userId,
                  actorDeviceId: deviceId,
                  actorIp: ip,
                  actorUa: uaOf(ctx.headers),
                  targetType: "device",
                  targetId: deviceId,
                  outcome: "denied",
                  metadata: { limit: FREE_PLAN_DEVICE_LIMIT, active },
                });
                throw new APIError("FORBIDDEN", {
                  error: "device_limit_reached",
                  error_description: `Free plan allows ${FREE_PLAN_DEVICE_LIMIT} active sync devices; revoke one or upgrade`,
                  limit: FREE_PLAN_DEVICE_LIMIT,
                });
              }
            }

            await db.transaction(async (tx) => {
              await upsertDevice(tx, { id: deviceId, userId: newRow.userId, name, platform, appVersion, ip });
              await bindRefreshToDevice(tx, newRow.id, deviceId, newRow.userId);
              await audit(tx, {
                action: "auth.login_ok",
                actorId: newRow.userId,
                actorDeviceId: deviceId,
                actorIp: ip,
                actorUa: uaOf(ctx.headers),
                targetType: "device",
                targetId: deviceId,
                metadata: { grant: String(grant), client_id: DESKTOP_CLIENT_ID, platform },
              });
            });
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx) => {
            const body = bodyOf(ctx);
            const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
            const returned = ctx.context.returned;
            const failed = returned instanceof APIError;
            const ip = ipOf(ctx.headers);
            const ua = uaOf(ctx.headers);
            const payload = failed ? null : jsonPayload(returned);
            let userId: string | null = null;
            const u = payload?.user;
            if (u && typeof u === "object" && typeof (u as Body).id === "string")
              userId = (u as Body).id as string;
            if (!userId && email) {
              const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
              userId = rows[0]?.id ?? null;
            }
            await auditStandalone(db, {
              action: failed ? "auth.login_failed" : "auth.login_ok",
              actorId: userId,
              actorIp: ip,
              actorUa: ua,
              targetType: userId ? "user" : null,
              targetId: userId,
              outcome: failed ? "denied" : "success",
              metadata: { method: "email", surface: "web" },
            });
            if (failed && userId) {
              const decision = await getRateLimitBackend().consume(`login_fail:${userId}`, 10, 900);
              if (decision.allowed && decision.remaining === 0) {
                await sendSecurityAlert(
                  userId,
                  "10 consecutive failed sign-in attempts / 连续 10 次登录失败",
                  [],
                );
              }
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/change-password",
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.context.returned instanceof APIError) return;
            const session = ctx.context.session ?? (await getSessionFromCtx(ctx));
            const userId = session?.user.id;
            if (!userId) return;
            const devices = await revokeEverything(ctx, userId);
            await auditStandalone(db, {
              action: "auth.password_changed",
              actorId: userId,
              actorIp: ipOf(ctx.headers),
              actorUa: uaOf(ctx.headers),
              targetType: "user",
              targetId: userId,
              metadata: { revoked_devices: devices.length },
            });
            await sendSecurityAlert(userId, "password changed / 密码已更改", devices);
          }),
        },
      ],
    },
  };
}
