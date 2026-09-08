// `/v1` 的同源会话通道（apps/server/src/auth/web-session.ts）。
//
// 为什么会有这条通道：/v1 原本只认 Bearer，而 Bearer 是 oauth-provider 给桌面端签的令牌，
// 浏览器拿不到。网页端（含 iOS 上「添加到主屏幕」的 PWA）要能读写便笺，就得有一条自己的路。
// 选 HttpOnly 会话 cookie 而不是给浏览器发 OAuth 令牌：令牌进了 JS 能碰到的地方，一次 XSS 即全失守。
//
// 这个文件钉的是「这条口子没有开大」——它开在整个 /v1 上，比管理台那条宽得多，所以每一层都要有用例：
//   ① 通道确实通（不然网页端是个摆设）；
//   ② 缺 X-Bianfa-Web 头一律 401 —— 跨源请求要带自定义头必须先过 CORS 预检，预检只放行 APP_ORIGIN；
//   ③ 非 GET 的 Origin 必须在 APP_ORIGIN 里，否则 403（CSRF 的第二道，第一道是 SameSite=Lax cookie）；
//   ④ 被冻结的账号走这条路一样进不来（getSession 不看账号状态，闸门必须自己补这条判定）；
//   ⑤ 没注入 resolveSession 的部署里这条通道不存在；
//   ⑥ 数据是按会话里那个用户隔离的，不是随便谁都能读。
//
// 端点选的是这个脚手架里真实挂载的那些（/v1/me、/v1/orgs）。便笺路由在另一个 builder 里，
// 不在这里；这个文件要钉的是**通道本身**，不是某个具体端点。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdminHarness, openHarness, req, resetRateLimit } from "./admin-helpers.js";
import { seedUserV7 } from "./api-helpers.js";
import { type Fixture, hasDb, openAdmin, truncateAll } from "./helpers.js";

describe.skipIf(!hasDb)("/v1 的同源会话通道（网页端 / PWA）", () => {
  let f: Fixture;
  let h: AdminHarness;
  let me: { userId: string; workspaceId: string };
  let other: { userId: string; workspaceId: string };

  beforeAll(async () => {
    resetRateLimit();
    f = openAdmin();
    await truncateAll(f.admin);
    me = await seedUserV7(f.adminDb, "web-me");
    other = await seedUserV7(f.adminDb, "web-other");
    h = openHarness({ sessionFromCookie: true });
  });
  afterAll(async () => {
    await h?.close();
    await f?.admin.end();
  });

  const web = <T = Record<string, unknown>>(
    method: string,
    path: string,
    opts: Record<string, unknown> = {},
  ) => req<T>(h.app, method, path, { cookieAs: me.userId, webHeader: true, ...opts });

  it("带会话 cookie + X-Bianfa-Web 能过闸门并读到真数据", async () => {
    const r = await web<{ user?: { id?: string } }>("GET", "/v1/me");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it("缺 X-Bianfa-Web 头 → 401（跨源要带自定义头必须先过 CORS 预检）", async () => {
    const r = await req(h.app, "GET", "/v1/me", { cookieAs: me.userId, webHeader: false });
    expect(r.status).toBe(401);
  });

  it("非 GET 缺 Origin → 403 bad_origin", async () => {
    const r = await web("POST", "/v1/orgs", { origin: null, body: { name: "无 Origin" } });
    expect(r.status).toBe(403);
    expect((r.body as { error?: string }).error).toBe("bad_origin");
  });

  it("非 GET 的 Origin 不在 APP_ORIGIN 里 → 403 bad_origin", async () => {
    const r = await web("POST", "/v1/orgs", {
      origin: "https://evil.example",
      body: { name: "坏 Origin" },
    });
    expect(r.status).toBe(403);
    expect((r.body as { error?: string }).error).toBe("bad_origin");
  });

  it("Origin 合法时非 GET 能过（真的写进去了）", async () => {
    const r = await web("POST", "/v1/orgs", { body: { name: "网页端建的组织" } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("被冻结的账号走这条路进不来（403 account_frozen）", async () => {
    // getSession 只回用户基本资料、不看账号状态。闸门不自己补这条判定的话，
    // 一个被冻结甚至被注销的账号，只要浏览器里那份会话没过期，就还能照常读写便笺。
    await f.admin.query('UPDATE "user" SET frozen_at = now(), banned = true WHERE id = $1', [me.userId]);
    try {
      const r = await web("GET", "/v1/me");
      expect(r.status).toBe(403);
      expect((r.body as { error?: string }).error).toBe("account_frozen");
    } finally {
      await f.admin.query('UPDATE "user" SET frozen_at = NULL, banned = false WHERE id = $1', [me.userId]);
    }
  });

  it("没注入 resolveSession 的部署里，这条通道不存在（401）", async () => {
    const noSession = openHarness();
    try {
      const r = await req(noSession.app, "GET", "/v1/me", { cookieAs: me.userId, webHeader: true });
      expect(r.status).toBe(401);
    } finally {
      await noSession.close();
    }
  });

  it("身份取自会话里那个用户，不是随便谁", async () => {
    const mine = await web<{ user: { id: string } }>("GET", "/v1/me");
    expect(mine.body.user.id).toBe(me.userId);
    // 换一个 cookie 就是另一个人，互不串味
    const theirs = await req<{ user: { id: string } }>(h.app, "GET", "/v1/me", {
      cookieAs: other.userId,
      webHeader: true,
    });
    expect(theirs.body.user.id).toBe(other.userId);
  });
});
