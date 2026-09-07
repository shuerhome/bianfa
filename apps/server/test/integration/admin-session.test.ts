// `/v1/admin/*` 的同源会话通道（apps/server/src/auth/admin-guard.ts 的 requireAdminActor）。
//
// 为什么会有这条通道：/v1 的其余部分按规格 04 §1.5 只认 Bearer，而 Bearer 是 oauth-provider 给桌面端签的
// 不透明令牌（bootstrap 里唯一的 client 是 native + PKCE、回调 127.0.0.1）。管理台跑在浏览器里拿不到那种令牌；
// 若为它注册一个 Web OAuth client，等于把一份可长期使用的凭据放进浏览器 JS 能碰到的地方，一次 XSS 即全失守。
// 所以这里改用 HttpOnly 的会话 cookie，并且**只在 /v1/admin/* 之下**开这一个口子。
//
// 这个文件钉的就是「这个口子没有开大」：
//   ① 通道确实通（不然管理台是个摆设）；
//   ② 缺少 X-Bianfa-Admin 头一律 401 —— 跨源请求要带自定义头必须先过 CORS 预检，预检只放行 APP_ORIGIN；
//   ③ 非 GET 请求的 Origin 必须在 APP_ORIGIN 里，否则 403（CSRF 的第二道，第一道是 SameSite=Lax cookie）；
//   ④ 走这条通道的人一样要过 requireSuperAdmin，普通用户拿不到任何东西；
//   ⑤ 这条通道没有蔓延到 /v1 的其它路径。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdminHarness, grantPlatformAdmin, openHarness, req, resetRateLimit } from "./admin-helpers.js";
import { seedUserV7 } from "./api-helpers.js";
import { type Fixture, hasDb, openAdmin, truncateAll } from "./helpers.js";

describe.skipIf(!hasDb)("/v1/admin/* 的同源会话通道", () => {
  let f: Fixture;
  let h: AdminHarness;
  let admin: { userId: string };
  let plain: { userId: string };

  beforeAll(async () => {
    resetRateLimit();
    f = openAdmin();
    await truncateAll(f.admin);
    await f.admin.query("TRUNCATE audit_log RESTART IDENTITY CASCADE");
    admin = await seedUserV7(f.adminDb, "console-admin");
    plain = await seedUserV7(f.adminDb, "console-plain");
    h = openHarness({ sessionFromCookie: true });
    await grantPlatformAdmin(f.admin, admin.userId);
  });

  afterAll(async () => {
    await h?.close();
    await f?.admin.end();
  });

  it("带会话 cookie + X-Bianfa-Admin 的管理员可以读", async () => {
    const r = await req<{ admins: unknown[] }>(h.app, "GET", "/v1/admin/admins", {
      cookieAs: admin.userId,
    });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.admins)).toBe(true);
  });

  it("缺 X-Bianfa-Admin 头 → 401（跨源要带自定义头必须先过 CORS 预检）", async () => {
    const r = await req(h.app, "GET", "/v1/admin/admins", {
      cookieAs: admin.userId,
      adminHeader: false,
    });
    expect(r.status).toBe(401);
  });

  it("非 GET 缺 Origin → 403 bad_origin", async () => {
    const r = await req(h.app, "POST", `/v1/admin/users/${plain.userId}/freeze`, {
      cookieAs: admin.userId,
      origin: null,
      body: {},
    });
    expect(r.status).toBe(403);
    expect((r.body as { error?: string }).error).toBe("bad_origin");
  });

  it("非 GET 的 Origin 不在 APP_ORIGIN 里 → 403 bad_origin", async () => {
    const r = await req(h.app, "POST", `/v1/admin/users/${plain.userId}/freeze`, {
      cookieAs: admin.userId,
      origin: "https://evil.example",
      body: {},
    });
    expect(r.status).toBe(403);
    expect((r.body as { error?: string }).error).toBe("bad_origin");
  });

  it("Origin 合法时非 GET 能过（冻结真的生效）", async () => {
    const r = await req<{ ok: boolean }>(h.app, "POST", `/v1/admin/users/${plain.userId}/freeze`, {
      cookieAs: admin.userId,
      body: { reason: "同源会话通道验证" },
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const back = await req<{ ok: boolean }>(h.app, "POST", `/v1/admin/users/${plain.userId}/unfreeze`, {
      cookieAs: admin.userId,
    });
    expect(back.status).toBe(200);
  });

  it("普通用户走这条通道一样是 403 insufficient_role", async () => {
    const r = await req(h.app, "GET", "/v1/admin/admins", { cookieAs: plain.userId });
    expect(r.status).toBe(403);
    expect((r.body as { error?: string }).error).toBe("insufficient_role");
  });

  it("没注入 resolveSession 的部署里，这条通道不存在（401）", async () => {
    const noSession = openHarness();
    try {
      const r = await req(noSession.app, "GET", "/v1/admin/admins", { cookieAs: admin.userId });
      expect(r.status).toBe(401);
    } finally {
      await noSession.close();
    }
  });

  it("这个口子没有蔓延到 /v1 的其它路径：带会话 cookie 打 /v1/me 仍然 401", async () => {
    const r = await req(h.app, "GET", "/v1/me", { cookieAs: admin.userId });
    expect(r.status).toBe(401);
  });
});
