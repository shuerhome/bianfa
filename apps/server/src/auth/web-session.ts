// `/v1` 的同源会话通道：让浏览器里的网页端（含 PWA）能调便笺接口。
//
// 背景：/v1 原本只认 Bearer（规格 04 §1.5），而 Bearer 是 oauth-provider 给桌面端签的不透明令牌
// （bootstrap 里唯一的 client 是 native + PKCE、回调 127.0.0.1）。浏览器拿不到那种令牌。
//
// 为什么不给网页端注册一个 Web OAuth client：那等于把一份可长期使用的凭据放进 JS 能碰到的地方，
// 一次 XSS 即全失守。HttpOnly 的会话 cookie 是更小的攻击面——这个取舍在管理台（requireAdminActor）
// 时就做过一次，这里沿用同一套判据。
//
// CSRF 由三层一起挡，缺一不可：
//   ① Better Auth 的会话 cookie 是 SameSite=Lax，跨站的表单 POST 根本不带 cookie；
//   ② 非 GET 请求强制校验 Origin ∈ APP_ORIGIN；
//   ③ 要求自定义头 X-Bianfa-Web —— 跨源请求带自定义头必须先过 CORS 预检，而预检只放行 APP_ORIGIN。
//
// 与管理台那条通道刻意用不同的头（X-Bianfa-Admin / X-Bianfa-Web）：两条通道的权限判定完全不同
// （管理台之后还要过 requireSuperAdmin），共用一个头会让「哪个口子开到哪里」在读代码时变得含糊。
import type { MiddlewareHandler } from "hono";
import type { Db } from "../db/client.js";
import { accountUsable } from "./admin-guard.js";
import { ApiFailure } from "./http.js";
import type { AuthVariables, BearerVerifier } from "./index.js";
import type { ServiceDeps } from "./services/context.js";

export interface WebSessionDeps {
  db: Db;
  verify: BearerVerifier;
  /** 没注入就等于这条通道不存在（只剩 Bearer），部署可以据此关掉网页端 */
  resolveSession?: ServiceDeps["resolveSession"];
  appOrigins: readonly string[];
}

/**
 * Bearer 优先；没有 Bearer 时走同源会话 cookie。
 *
 * Bearer 那一支的行为与 requireBearer 逐字一致（不加额外判定），避免桌面端的行为被这次改动波及。
 */
export function requireBearerOrWebSession(
  deps: WebSessionDeps,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
    if (m) {
      const ctx = await deps.verify(m[1] as string, c);
      if (!ctx) {
        c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
        return c.json({ error: "unauthorized" }, 401);
      }
      c.set("auth", ctx);
      await next();
      return;
    }

    // 以下是同源会话通道。任何一层不满足都不放行。
    if (c.req.header("x-bianfa-web") !== "1") {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return c.json({ error: "unauthorized" }, 401);
    }
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      const origin = c.req.header("origin");
      if (!origin || !deps.appOrigins.includes(origin)) throw new ApiFailure(403, "bad_origin");
    }
    const session = await deps.resolveSession?.(c.req.raw.headers);
    if (!session) {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return c.json({ error: "unauthorized" }, 401);
    }
    // getSession 只回用户基本资料、不看账号状态。不补这一条的话，被冻结或已注销的账号
    // 只要浏览器里那份会话没过期，就还能照常读写便笺。
    if (!(await accountUsable(deps.db, session.userId))) throw new ApiFailure(403, "account_frozen");
    c.set("auth", {
      userId: session.userId,
      sessionId: null,
      deviceId: null,
      email: session.email,
      emailVerified: session.emailVerified,
      scopes: [],
    });
    await next();
  };
}
