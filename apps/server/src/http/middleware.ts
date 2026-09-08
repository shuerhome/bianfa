// /v1 通用中间件（规格 04 §6 约定 / §7.2）：X-Request-Id、安全头、CORS 精确匹配、cookie 拒绝、server_time 注入。
// 若 B1 的 src/security/** 提供同类中间件，装配层择一即可（本文件自足，不依赖它）。
import type { Context, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { uuidv7 } from "../db/ids.js";

export type RequestVariables = { requestId: string };

/** X-Request-Id：沿用客户端/Caddy 传入的（≤ 128 字符可打印 ASCII），否则生成 UUIDv7 */
export function requestIdMiddleware(): MiddlewareHandler {
  return requestId({
    headerName: "X-Request-Id",
    limitLength: 128,
    generator: () => uuidv7(),
  });
}

/** 规格 04 §7.2 安全头；HSTS 只在 production（本地 http 联调不该带） */
export function securityHeaders(opts: { production: boolean }): MiddlewareHandler {
  return secureHeaders({
    xContentTypeOptions: "nosniff",
    referrerPolicy: "strict-origin-when-cross-origin",
    crossOriginOpenerPolicy: "same-origin",
    crossOriginResourcePolicy: "same-site",
    xFrameOptions: "DENY",
    strictTransportSecurity: opts.production ? "max-age=63072000; includeSubDomains; preload" : false,
    permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
    // API 不出 HTML；仍给一个最小 CSP 防止意外渲染
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
    removePoweredBy: true,
    xXssProtection: false,
    xDnsPrefetchControl: false,
    xDownloadOptions: false,
    xPermittedCrossDomainPolicies: false,
    originAgentCluster: false,
    crossOriginEmbedderPolicy: false,
  });
}

/** CORS：origin ∈ APP_ORIGIN 列表精确匹配；不通配、不反射；桌面端（Rust 发起）无 Origin 不走 CORS */
export function corsMiddleware(allowedOrigins: readonly string[]): MiddlewareHandler {
  const allow = new Set(allowedOrigins);
  return cors({
    origin: (origin) => (allow.has(origin) ? origin : null),
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Authorization", "Content-Type", "X-Organization-Id", "X-Request-Id", "Idempotency-Key"],
    exposeHeaders: ["X-Request-Id", "Retry-After"],
    maxAge: 600,
  });
}

/**
 * /v1/* 只认 Bearer（规格 04 §6、§7.11 ⑮）：带 Cookie 但无 Authorization → 401；
 * 完全没有 Authorization 的非匿名路径也直接 401（便宜的存在性检查；真正的校验在各路由的 requireBearer）。
 *
 * 例外一：X-Bianfa-Web —— 浏览器里的网页端 / PWA 拿不到 Bearer（那是 oauth-provider 签给桌面端的
 * 不透明令牌），它走 requireBearerOrWebSession 的同源会话通道。这里只放过「有没有凭据」这一步，
 * **不做任何授权判定**：自定义头、非 GET 的 Origin 校验、账号可用性三层全在 web-session.ts 里，
 * 而且 /v1 的每条路由后面都还挂着 requireBearer 或 requireBearerOrWebSession。
 * 故意不把这些路径加进 isAnonymousV1Path —— 那个名字的意思是「不需要凭据」，
 * 而 /v1/notes、/v1/sync/token 永远不该是那种东西。
 */
export function bearerOnly(anonymousPaths: (path: string) => boolean): MiddlewareHandler {
  return async (c, next) => {
    if (anonymousPaths(c.req.path)) return next();
    if (c.req.header("x-bianfa-web") === "1") return next();
    const auth = c.req.header("authorization");
    if (!auth || !/^Bearer\s+\S+$/i.test(auth.trim())) {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      c.header("Cache-Control", "no-store");
      return c.json({ error: "unauthorized", server_time: Date.now() }, 401);
    }
    return next();
  };
}

const JSON_RE = /^application\/json\b/i;

/**
 * 给每个 JSON 对象响应补 `server_time`（Unix ms；规格 03 §2.7 / 05 §4.3.8）。已带的不覆盖。
 * 只重写小体积的 application/json 对象；数组/非 JSON/流式响应原样放行。
 */
export function serverTime(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const res = c.res;
    const ct = res.headers.get("content-type") ?? "";
    if (!JSON_RE.test(ct) || res.body === null) return;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > 1_048_576) return;
    let text: string;
    try {
      text = await res.clone().text();
    } catch {
      return;
    }
    if (!text.startsWith("{")) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const obj = parsed as Record<string, unknown>;
    if ("server_time" in obj) return;
    obj.server_time = Date.now();
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    c.res = new Response(JSON.stringify(obj), { status: res.status, statusText: res.statusText, headers });
  };
}

/** 取客户端 IP：Caddy 已把 CF-Connecting-IP / X-Forwarded-For 列为可信头（规格 01 §4）；直连时退回 socket 地址 */
export function clientIp(c: Context): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = c.req.header("x-forwarded-for");
  if (xff) return (xff.split(",")[0] ?? "").trim() || "unknown";
  const info = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket
    ?.remoteAddress;
  return info ?? "unknown";
}
