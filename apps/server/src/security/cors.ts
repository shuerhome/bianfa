// CORS（规格 04 §7.2）：origin 与 APP_ORIGIN 列表精确匹配，credentials: true，不通配、不反射；
// 桌面端请求由 Rust 发起不涉及 CORS。APP_ORIGIN 是逗号分隔列表（规格 01 §3.2），api 自己 split。
import type { MiddlewareHandler } from "hono";

export const CORS_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
export const CORS_ALLOWED_HEADERS =
  "Authorization, Content-Type, X-Organization-Id, X-Request-Id, Idempotency-Key";
export const CORS_EXPOSED_HEADERS = "X-Request-Id, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining";

/** 把 APP_ORIGIN（单值或逗号列表）规整成去重后的 origin 数组；空串忽略；尾部斜杠去掉 */
export function parseOrigins(input: string | readonly string[] | undefined): string[] {
  const list = typeof input === "string" ? input.split(",") : [...(input ?? [])];
  const out = new Set<string>();
  for (const raw of list) {
    const v = raw.trim().replace(/\/+$/, "");
    if (v) out.add(v);
  }
  return [...out];
}

export function corsFor(appOrigins: string | readonly string[] | undefined): MiddlewareHandler {
  const allowed = new Set(parseOrigins(appOrigins));
  return async (c, next) => {
    const origin = c.req.header("origin");
    const match = origin !== undefined && allowed.has(origin.replace(/\/+$/, ""));
    if (c.req.method === "OPTIONS") {
      // 预检：只对白名单 origin 给出允许头；其余 204 无头（浏览器会拒绝）
      const res = new Response(null, { status: 204 });
      res.headers.set("Vary", "Origin");
      if (match) applyCors(res.headers, origin as string, true);
      return res;
    }
    await next();
    c.res.headers.append("Vary", "Origin");
    if (match) applyCors(c.res.headers, origin as string, false);
  };
}

function applyCors(h: Headers, origin: string, preflight: boolean): void {
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Access-Control-Allow-Credentials", "true");
  if (preflight) {
    h.set("Access-Control-Allow-Methods", CORS_METHODS);
    h.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
    h.set("Access-Control-Max-Age", "600");
  } else {
    h.set("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS);
  }
}
