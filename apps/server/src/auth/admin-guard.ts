// 平台总管理员判定与中间件（迁移 0009）。
//
// 判定**不缓存**：org 成员那套 30 秒缓存是为了扛高频调用，而总管理员端点是低频高危操作，
// 多一次索引命中的查询换「撤销即刻生效」是划算的。
//
// 拒绝时返回 403 insufficient_role（而不是伪装成 404）：/v1 全程要求 Bearer，能走到这里的都是已登录用户，
// 「存在一个 /v1/admin」本身不是秘密，真正的边界是这里的判定本身；伪装 404 反而要求响应与全局 404 逐字一致，
// 而 v1 的 fail() 会多一个 server_time 字段，做不到逐字一致，等于给出一个更细的 oracle 还自欺欺人。
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { audit } from "../audit/index.js";
import type { Db } from "../db/client.js";
import { platformAdmin } from "../db/schema/admin.js";
import { ApiFailure, requestMeta } from "./http.js";
import type { AuthVariables, BearerVerifier } from "./index.js";
import type { ServiceDeps } from "./services/context.js";

export type AdminVariables = AuthVariables & { platformAdmin: true };

/** 名单里有这个人吗。任何异常一律当作「不是」（fail-closed）。 */
export async function isPlatformAdmin(db: Db, userId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ userId: platformAdmin.userId })
      .from(platformAdmin)
      .where(eq(platformAdmin.userId, userId))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

export interface AdminGuardDeps {
  db: Db;
  /** PLATFORM_ADMIN_ENABLED=0 时整个管理面下线（出事时一分钟内能落下的闸）*/
  enabled: boolean;
}

/**
 * `/v1/admin/*` 专用的身份中间件：Bearer 优先，没有 Bearer 时接受**同源** Better Auth 会话 cookie。
 *
 * 为什么要开这条口子：/v1 按规格 04 §1.5 只认 Bearer，而 Bearer 是 oauth-provider 给桌面端签的不透明令牌
 * （bootstrap 里唯一的 client 是 native + PKCE，回调是 127.0.0.1）。管理台跑在浏览器里，拿不到这种令牌；
 * 若为它注册一个 Web OAuth client，就等于把一份可长期使用的凭据放进浏览器 JS 能碰到的地方，一次 XSS 即全失守。
 * 相比之下 HttpOnly 的会话 cookie 是更小的攻击面。
 *
 * 这条口子**只在 /v1/admin/* 之下**，不扩大到 /v1 的其余部分。CSRF 由三层一起挡：
 *   ① Better Auth 的会话 cookie 是 SameSite=Lax，跨站的表单 POST 根本不带 cookie；
 *   ② 这里对所有非 GET 请求强制校验 Origin ∈ APP_ORIGIN；
 *   ③ 要求自定义头 X-Bianfa-Admin —— 跨源请求带自定义头必须先过 CORS 预检，而预检只放行 APP_ORIGIN。
 */
export function requireAdminActor(
  deps: AdminGuardDeps & {
    verify: BearerVerifier;
    resolveSession?: ServiceDeps["resolveSession"];
    appOrigins: readonly string[];
  },
): MiddlewareHandler<{ Variables: AdminVariables }> {
  return async (c, next) => {
    if (!deps.enabled) throw new ApiFailure(404, "not_found");

    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
    if (m) {
      const ctx = await deps.verify(m[1] as string, c);
      if (!ctx) {
        c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
        throw new ApiFailure(401, "unauthorized");
      }
      c.set("auth", ctx);
      return next();
    }

    // 自定义头：跨源请求要带它必须先过 CORS 预检，而预检只放行 APP_ORIGIN
    if (c.req.header("x-bianfa-admin") !== "1") throw new ApiFailure(401, "unauthorized");

    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      const origin = c.req.header("origin");
      if (!origin || !deps.appOrigins.includes(origin)) throw new ApiFailure(403, "bad_origin");
    }

    const session = await deps.resolveSession?.(c.req.raw.headers);
    if (!session) throw new ApiFailure(401, "unauthorized");
    c.set("auth", {
      userId: session.userId,
      sessionId: null,
      deviceId: null,
      email: session.email,
      emailVerified: session.emailVerified,
      scopes: [],
    });
    return next();
  };
}

/**
 * `/v1/admin/*` 的权限闸门。必须挂在 requireAdminActor 之后（它负责把 c.var.auth 填好）。
 * 管理面被关掉时一律 404 —— 这时端点在这个部署里确实不存在，不是权限问题。
 */
export function requireSuperAdmin(deps: AdminGuardDeps): MiddlewareHandler<{ Variables: AdminVariables }> {
  return async (c, next) => {
    if (!deps.enabled) throw new ApiFailure(404, "not_found");
    const auth = c.get("auth");
    if (!auth?.userId) throw new ApiFailure(401, "unauthorized");
    if (await isPlatformAdmin(deps.db, auth.userId)) {
      c.set("platformAdmin", true);
      return next();
    }
    const meta = requestMeta(c);
    // 被拒绝也要留痕：普通用户摸管理端点是值得看见的信号
    await deps.db
      .transaction((tx) =>
        audit(tx, {
          action: "authz.denied",
          actorId: auth.userId,
          actorDeviceId: auth.deviceId,
          actorIp: meta.ip,
          actorUa: meta.ua,
          targetType: "platform_admin",
          targetId: auth.userId,
          outcome: "denied",
          metadata: { required: "platform_admin", path: c.req.path, method: c.req.method },
          requestId: meta.requestId,
        }),
      )
      .catch(() => {
        /* 审计写失败不能把拒绝变成放行 */
      });
    throw new ApiFailure(403, "insufficient_role", { required: "platform_admin" });
  };
}
