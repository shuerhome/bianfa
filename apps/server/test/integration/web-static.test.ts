// Web 面静态托管（src/http/web-static.ts）：临时 dist 目录 + fakeAuth 的 app：
//   /login → index.html + 页面 CSP + no-store；/assets/x.js → immutable；/web-config.json → JSON；
//   /v1/me 仍 401 JSON；/healthz 不受影响；无产物时 /login → 404 JSON。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isWebPagePath, WEB_PAGE_CSP } from "../../src/http/web-static.js";
import { buildTestApp, type TestApp } from "./api-helpers.js";
import { hasDb } from "./helpers.js";

const INDEX_HTML =
  '<!doctype html><html><head><title>bianfa</title></head><body><div id="root"></div></body></html>';

describe.runIf(hasDb)("web static", () => {
  let dir: string;
  let t: TestApp;
  let bare: TestApp;
  const prevDist = process.env.WEB_DIST_DIR;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "bianfa-web-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), INDEX_HTML);
    writeFileSync(join(dir, "assets", "x.js"), "console.log('x')");
    process.env.WEB_DIST_DIR = dir;
    t = buildTestApp();
    // 没有产物的 app：中间件空操作
    process.env.WEB_DIST_DIR = join(dir, "missing");
    bare = buildTestApp();
    if (prevDist === undefined) delete process.env.WEB_DIST_DIR;
    else process.env.WEB_DIST_DIR = prevDist;
  });

  afterAll(async () => {
    await Promise.allSettled([t?.close(), bare?.close()]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("isWebPagePath 只认清单里的页面与 /invite/:token", () => {
    for (const p of ["/", "/login", "/signup", "/device", "/account", "/invite/abc-DEF_123", "/login/"])
      expect(isWebPagePath(p), p).toBe(true);
    for (const p of [
      "/api/auth/get-session",
      "/v1/me",
      "/healthz",
      "/ws/x",
      "/invite",
      "/invite/a/b",
      "/assets/x.js",
    ])
      expect(isWebPagePath(p), p).toBe(false);
  });

  it("SPA 路由回 index.html：no-store + 页面 CSP + 安全头", async () => {
    for (const path of ["/login", "/device?user_code=ABCDEFGH", "/invite/tok_abc", "/"]) {
      const res = await t.app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toMatch(/^text\/html/);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("content-security-policy"), path).toBe(WEB_PAGE_CSP);
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("strict-transport-security"), path).toBeNull();
      expect(await res.text()).toBe(INDEX_HTML);
    }
  });

  it("/assets/* 不可变缓存；越权路径与未知文件 404 JSON", async () => {
    const ok = await t.app.request("/assets/x.js");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(ok.headers.get("content-type")).toMatch(/javascript/);
    expect(await ok.text()).toBe("console.log('x')");

    const missing = await t.app.request("/assets/nope.js");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not_found" });

    const traversal = await t.app.request("/assets/../index.html");
    expect(traversal.status).toBe(404);
  });

  it("/web-config.json：providers 按环境变量推导，app_origin = APP_ORIGIN 首项", async () => {
    const res = await t.app.request("/web-config.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/json/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = (await res.json()) as {
      providers: string[];
      app_origin: string;
      download_url: string | null;
    };
    expect(body.app_origin).toBe("http://localhost:5173");
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.download_url).toBeNull();
  });

  it("/v1/me 仍是 401 JSON；/healthz 与 POST /login 不被静态层吞掉", async () => {
    const me = await t.app.request("/v1/me");
    expect(me.status).toBe(401);
    expect(me.headers.get("content-type")).toMatch(/json/);
    expect(await me.json()).toMatchObject({ error: "unauthorized" });

    const health = await t.app.request("/healthz");
    expect([200, 503]).toContain(health.status);
    expect(health.headers.get("content-type")).toMatch(/json/);

    const post = await t.app.request("/login", { method: "POST" });
    expect(post.status).toBe(404);
    expect(await post.json()).toMatchObject({ error: "not_found" });

    const unknown = await t.app.request("/definitely-not-a-page");
    expect(unknown.status).toBe(404);
  });

  it("没有产物时 /login → 404 JSON，/web-config.json 照常", async () => {
    const res = await bare.app.request("/login");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
    const cfg = await bare.app.request("/web-config.json");
    expect(cfg.status).toBe(200);
  });
});
