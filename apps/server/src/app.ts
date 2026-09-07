// HTTP 应用装配（api.ts 与集成测试共用）：createApp(deps) → Hono。
//   /healthz                 SELECT 1 经 PgBouncer ≤ 2 s → 200，否则 503（Redis 可选，不参与判定）
//   /login /device /invite/* …  Web 面静态页（apps/web 产物；src/http/web-static.ts）+ GET /web-config.json
//   /api/auth/*              Better Auth handler（B1）
//   /v1/*                    仅 Bearer（cookie 显式拒绝）；匿名白名单：/v1/notice、/v1/telemetry、/v1/invites/:token/preview、
//                            /v1/auth/reset-with-code（安全码重置密码）
//     B2 路由：workspaces / notes / shares / pins / comments / attachments / notifications / claim / sync/token / me/export
//     B1 路由：deps.auth.v1Routes（/me、/orgs/**、/invites/**、/me/devices/**、/me/delete）
// 每个 JSON 响应带 server_time（Unix ms）与 X-Request-Id；错误统一 { error: <code> }（规格 04 §5.3）。
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { audit } from "./audit/index.js";
import { requireBearer } from "./auth/index.js";
import { r2ConfigFromEnv } from "./http/env.js";
import { AppError, mapError } from "./http/errors.js";
import {
  bearerOnly,
  clientIp,
  corsMiddleware,
  requestIdMiddleware,
  securityHeaders,
  serverTime,
} from "./http/middleware.js";
import { createMemoryRateLimiter } from "./http/ratelimit.js";
import { LIMITS } from "./http/validate.js";
import { webRoutes } from "./http/web-static.js";
import { accountRoutes } from "./routes/account.js";
import { anonymousRoutes } from "./routes/anonymous.js";
import { attachmentRoutes } from "./routes/attachments.js";
import type { AppDeps, RouteDeps, RouteEnv } from "./routes/context.js";
import { noteRoutes } from "./routes/notes.js";
import { notificationRoutes } from "./routes/notifications.js";
import { pinRoutes } from "./routes/pins.js";
import { shareRoutes } from "./routes/shares.js";
import { todoRoutes } from "./routes/todos.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { createNoticeLoader } from "./services/notice.js";
import { createPgBossQueue } from "./services/queue.js";
import { createR2Storage } from "./services/storage.js";

export type { AppDeps, RouteEnv } from "./routes/context.js";

export const HEALTHZ_DB_TIMEOUT_MS = 2000;

const ANON_V1 = /^\/v1\/(notice|telemetry|invites\/[^/]+\/preview|auth\/reset-with-code)$/;
/** /v1/admin/* 自带 requireAdminActor（Bearer 或同源会话 cookie），不能被只认 Bearer 的 bearerOnly 提前挡掉 */
const ADMIN_V1 = /^\/v1\/admin(\/|$)/;
export function isAnonymousV1Path(path: string): boolean {
  return ANON_V1.test(path) || ADMIN_V1.test(path);
}

function resolveDeps(deps: AppDeps): RouteDeps {
  const r2 = r2ConfigFromEnv(deps.env);
  return {
    db: deps.db,
    log: deps.log,
    env: deps.env,
    queue: deps.queue ?? createPgBossQueue(deps.env.DATABASE_URL, deps.log),
    storage: deps.storage !== undefined ? deps.storage : r2 ? createR2Storage(r2) : null,
    rateLimiter: deps.rateLimiter ?? createMemoryRateLimiter(),
    notice: deps.notice ?? createNoticeLoader(deps.env.NOTICE_FILE),
    now: deps.now ?? (() => new Date()),
  };
}

export function createApp(deps: AppDeps): Hono<RouteEnv> {
  const d = resolveDeps(deps);
  const production = deps.env.NODE_ENV === "production";
  const app = new Hono<RouteEnv>();

  app.use("*", requestIdMiddleware());
  // Web 面（apps/web 产物 + /web-config.json）：必须早于 securityHeaders（它会覆盖页面 CSP），自带同一套安全头
  app.route("/", webRoutes({ appOrigins: deps.env.APP_ORIGINS, production }));
  app.use("*", securityHeaders({ production }));
  app.use("*", corsMiddleware(deps.env.APP_ORIGINS));
  app.use("*", serverTime());

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    const mapped = mapError(err);
    const requestId = c.var.requestId ?? null;
    if (mapped.status >= 500) {
      d.log.error(
        { err: { message: err.message, stack: err.stack }, requestId, path: c.req.path },
        "request failed",
      );
    } else if (mapped.status === 403 && err instanceof AppError && err.denied) {
      const auth = c.var.auth;
      const denied = err.denied;
      // 业务事务已回滚，审计单独落一笔（规格 04 §4.7 authz.denied）
      void d.db
        .transaction((tx) =>
          audit(tx, {
            action: "authz.denied",
            orgId: denied.orgId ?? null,
            actorId: auth?.userId ?? null,
            actorDeviceId: auth?.deviceId ?? null,
            actorIp: /^[0-9a-fA-F.:]+$/.test(clientIp(c)) ? clientIp(c) : null,
            targetType: denied.targetType ?? null,
            targetId: denied.targetId ?? null,
            outcome: "denied",
            metadata: { required: denied.required ?? null, path: c.req.path, method: c.req.method },
            requestId,
          }),
        )
        .catch((e: unknown) => d.log.warn({ err: (e as Error).message }, "authz.denied audit failed"));
    }
    for (const [k, v] of Object.entries(mapped.headers)) c.header(k, v);
    c.header("Cache-Control", "no-store");
    return c.json({ ...mapped.body, request_id: requestId, server_time: Date.now() }, mapped.status);
  });

  app.get("/healthz", async (c) => {
    const started = Date.now();
    try {
      await Promise.race([
        d.db.execute(sql`SELECT 1`),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("db timeout")), HEALTHZ_DB_TIMEOUT_MS).unref(),
        ),
      ]);
    } catch (err) {
      d.log.warn({ err: (err as Error).message }, "healthz db check failed");
      return c.json({ ok: false, service: "api", db: "down" }, 503);
    }
    return c.json({ ok: true, service: "api", db: "ok", db_ms: Date.now() - started });
  });

  // Better Auth（Web cookie / OAuth / device）：原样转交 Request
  app.all("/api/auth/*", (c) => deps.auth.handler(c.req.raw));

  const v1 = new Hono<RouteEnv>();
  v1.use("*", bearerOnly(isAnonymousV1Path));
  v1.use("*", bodyLimit({ maxSize: LIMITS.jsonBodyMax }));

  // 已认证：600/min/user（规格 04 §1.7）
  const verify = requireBearer(deps.auth.verifyBearer);
  const authed = new Hono<RouteEnv>();
  authed.use("*", async (c, next) => {
    if (c.var.auth) return next();
    return verify(c as unknown as Parameters<typeof verify>[0], next);
  });
  authed.use("*", async (c, next) => {
    const rl = await d.rateLimiter.hit("v1_user", c.var.auth.userId, 600, 60);
    if (!rl.ok) {
      c.header("Retry-After", String(rl.retryAfter));
      return c.json({ error: "rate_limited", retry_after: rl.retryAfter }, 429);
    }
    return next();
  });
  authed.route("/", workspaceRoutes(d));
  authed.route("/", noteRoutes(d));
  authed.route("/", shareRoutes(d));
  authed.route("/", pinRoutes(d));
  authed.route("/", attachmentRoutes(d));
  authed.route("/", notificationRoutes(d));
  authed.route("/", accountRoutes(d));
  authed.route("/", todoRoutes(d));

  v1.route("/", anonymousRoutes(d));
  // B1 的账号/组织路由先挂：它们各自带 requireBearer；后面的 authed 中间件对已匹配的路径不再运行
  v1.route("/", deps.auth.v1Routes as unknown as Hono<RouteEnv>);
  v1.route("/", authed);

  app.route("/v1", v1);
  return app;
}
