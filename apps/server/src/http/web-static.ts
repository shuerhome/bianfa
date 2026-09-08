// =============================================================================
// Web 面静态托管（specs/04 §1.5 / §7.2）：apps/web（Vite 产物）由 api 进程在 APP_ORIGIN 同源托管，cookie 全程同源。
// -----------------------------------------------------------------------------
// * 目录：WEB_DIST_DIR 环境变量 > <apps/server>/public/web（scripts/build.mjs 把 apps/web/dist 复制到这里；Docker 同）。
//   目录里没有 index.html → 整个中间件是空操作（开发 / 测试没构建 Web 也不影响 API）。
// * /assets/*              → Vite 内容哈希文件：Cache-Control: public, max-age=31536000, immutable
// * WEB_PAGE_PATHS（SPA 路由）→ index.html：Cache-Control: no-store + 页面 CSP（WEB_PAGE_CSP）
// * 其它路径一律 next()：/api/auth/*、/v1/*、/healthz、/ws/*、/metrics 不受影响；只处理 GET / HEAD。
// * 必须挂在 securityHeaders() **之前**：hono secureHeaders 在 next() 之后 set 头，会把页面 CSP 覆盖成 API 的
//   default-src 'none'。所以本文件对自己产出的响应补齐同一套安全头（SECURITY_HEADERS + 生产 HSTS）。
// * GET /web-config.json（web-config.ts）也挂在这里（同样早于 securityHeaders，自己带安全头）。
// =============================================================================
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { SECURITY_HEADERS } from "../security/headers.js";
import { computeWebConfig, WEB_CONFIG_PATH } from "./web-config.js";

/** 规格 04 §7.2 的 Web 页 CSP（同源托管 → connect-src / form-action 只需 'self'；favicon 是 data: URI） */
export const WEB_PAGE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
  "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'";

export const HSTS = "max-age=63072000; includeSubDomains; preload";

/** 与 apps/web/src/router.ts 的 matchRoute 一致；/invite/:token 单独用正则 */
export const WEB_PAGE_PATHS = [
  "/",
  // 总管理员管理台：全部视图收在 /admin 一个路径 + 查询串，所以这一条就够
  "/admin",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/change-email",
  "/consent",
  "/device",
  "/account",
  // 便笺列表（网页 / PWA）：全部视图收在 /notes 一个路径 + 查询串
  "/notes",
] as const;

const INVITE_RE = /^\/invite\/[A-Za-z0-9_-]{1,128}$/;
const ASSETS_PREFIX = "/assets/";

/**
 * 根目录下必须原样放行的几个文件（apps/web/public/ 里的东西，Vite 会原样拷到 dist 根）。
 * 白名单而不是"根目录随便读"：这个中间件挂在 /v1、/api/auth、/ws 之前，
 * 放开成通配等于把产物目录整个暴露出去。
 *
 * 这些文件的名字里没有内容哈希（manifest 和图标的路径是写死在 index.html 与 manifest 里的），
 * 所以缓存只能是"可缓存但要回源确认"，不能用 assets 那套 immutable。
 */
const ROOT_FILES = new Set([
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/icon-32.png",
  "/icon-192.png",
  "/icon-512.png",
]);

export function isWebRootFile(path: string): boolean {
  return ROOT_FILES.has(path);
}

export function isWebPagePath(path: string): boolean {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if ((WEB_PAGE_PATHS as readonly string[]).includes(p)) return true;
  return INVITE_RE.test(p);
}

/** WEB_DIST_DIR > <apps/server>/public/web（dist/api.js → ../public/web；src/http/*.ts → ../../public/web） */
export function resolveWebDistDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WEB_DIST_DIR) return resolve(env.WEB_DIST_DIR);
  const here = dirname(fileURLToPath(import.meta.url));
  const fromDist = resolve(here, "../public/web");
  const fromSrc = resolve(here, "../../public/web");
  return existsSync(fromDist) ? fromDist : existsSync(fromSrc) ? fromSrc : fromDist;
}

export function applyWebSecurityHeaders(
  headers: Headers,
  opts: { production: boolean; csp: string | null; cacheControl: string },
): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  if (opts.production) headers.set("Strict-Transport-Security", HSTS);
  if (opts.csp) headers.set("Content-Security-Policy", opts.csp);
  else headers.delete("Content-Security-Policy");
  headers.set("Cache-Control", opts.cacheControl);
  headers.set("X-Robots-Tag", "noindex");
}

export interface WebStaticOptions {
  /** 产物目录；缺省 resolveWebDistDir() */
  dir?: string | undefined;
  production?: boolean | undefined;
}

/**
 * @hono/node-server 的 serveStatic 先 c.body() 再调 onFound，此时 c.header() 已经进不了那个 Response；
 * 所以在这里拿到它返回的 Response 再补头。没命中文件时它会调 next() 并返回 undefined，原样放行。
 */
async function serveAndStamp(
  mw: MiddlewareHandler,
  c: Context,
  next: () => Promise<void>,
  stamp: (headers: Headers) => void,
): Promise<Response | undefined> {
  const res = await mw(c, next);
  if (res instanceof Response) {
    stamp(res.headers);
    return res;
  }
  return undefined;
}

export function webStatic(opts: WebStaticOptions = {}): MiddlewareHandler {
  const dir = opts.dir ?? resolveWebDistDir();
  const production = opts.production ?? false;
  if (!existsSync(resolve(dir, "index.html"))) {
    return async (_c, next) => next();
  }
  const assets = serveStatic({ root: dir });
  const index = serveStatic({ root: dir, path: "index.html" });
  const stampAsset = (h: Headers) =>
    applyWebSecurityHeaders(h, {
      production,
      csp: null,
      cacheControl: "public, max-age=31536000, immutable",
    });
  const stampPage = (h: Headers) =>
    applyWebSecurityHeaders(h, { production, csp: WEB_PAGE_CSP, cacheControl: "no-store" });
  const stampRoot = (h: Headers) =>
    applyWebSecurityHeaders(h, { production, csp: null, cacheControl: "public, max-age=3600" });
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const path = c.req.path;
    if (path.startsWith(ASSETS_PREFIX)) return serveAndStamp(assets, c, next, stampAsset);
    if (isWebRootFile(path)) return serveAndStamp(assets, c, next, stampRoot);
    if (isWebPagePath(path)) return serveAndStamp(index, c, next, stampPage);
    return next();
  };
}

export interface WebRoutesOptions extends WebStaticOptions {
  /** CORS 白名单里的第一个 origin = Web 面的 APP_ORIGIN（邮件链接 / loginPage 都用它） */
  appOrigins: readonly string[];
  /** 环境变量原文（GOOGLE_* / APPLE_* / DESKTOP_DOWNLOAD_URL）；缺省 process.env */
  raw?: NodeJS.ProcessEnv | undefined;
}

/** app.ts 里一行挂载：app.route("/", webRoutes({...}))（放在 securityHeaders 之前） */
export function webRoutes(opts: WebRoutesOptions): Hono {
  const app = new Hono();
  const production = opts.production ?? false;
  const raw = opts.raw ?? process.env;
  app.get(WEB_CONFIG_PATH, (c) => {
    const res = c.json(computeWebConfig(raw, opts.appOrigins));
    applyWebSecurityHeaders(res.headers, { production, csp: null, cacheControl: "public, max-age=300" });
    return res;
  });
  app.use("*", webStatic({ dir: opts.dir, production }));
  return app;
}
