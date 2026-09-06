// 安全响应头（规格 04 §7.2）：API 全部响应统一加；Caddy 只删 Server。HSTS 由边缘（Cloudflare）负责，这里不重复。
import type { MiddlewareHandler } from "hono";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-site",
  "X-Frame-Options": "DENY",
};

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
    c.res.headers.delete("X-Powered-By");
    c.res.headers.delete("Server");
  };
}
