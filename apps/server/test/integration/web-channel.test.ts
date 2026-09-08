// 网页端 / PWA 的同源会话通道，**走真实装配**（createApp）而不是裸的子路由。
//
// 为什么必须这么测：web-session.test.ts 挂的是 buildV1Routes（B1 那一批路由），
// 而浏览器真正要用的 /v1/notes、/v1/workspaces、/v1/sync/token 在另一条管线上，
// 前面还压着 bearerOnly（"/v1 只认 Bearer"）。第一次接这条通道时就是漏在这里：
// 单测全绿、部署上去每个请求 401。这个文件覆盖的正是那道缝。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, seedUserV7, type TestApp } from "./api-helpers.js";
import { type Fixture, hasDb, openAdmin, truncateAll } from "./helpers.js";

const ORIGIN = "http://localhost:5173";

describe.skipIf(!hasDb)("网页端同源会话通道（/v1，真实 createApp 管线）", () => {
  let f: Fixture;
  let t: TestApp;
  let me: { userId: string; workspaceId: string };

  beforeAll(async () => {
    f = openAdmin();
    await truncateAll(f.admin);
    t = buildTestApp();
    me = await seedUserV7(t.db, "webuser");
  });
  afterAll(async () => {
    await t.close();
    await truncateAll(f.admin);
    await f.admin.end();
  });

  /** 浏览器的一次请求：同源 cookie + X-Bianfa-Web，没有 Authorization */
  function web(method: string, path: string, opts: { origin?: string | null; body?: unknown } = {}) {
    const headers: Record<string, string> = {
      cookie: `session=${me.userId}`,
      "x-bianfa-web": "1",
    };
    if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    return t.app.request(path, { method, headers, ...(body !== undefined ? { body } : {}) });
  }

  it("GET /v1/workspaces：带 cookie + 头就能拿到自己的工作区", async () => {
    const res = await web("GET", "/v1/workspaces");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspaces: Array<{ id: string }> };
    expect(body.workspaces.map((w) => w.id)).toContain(me.workspaceId);
  });

  it("GET /v1/notes：便笺发现也走得通（这条曾经被 bearerOnly 挡在门外）", async () => {
    const res = await web("GET", `/v1/notes?workspace_id=${me.workspaceId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace_id: string; notes: unknown[] };
    expect(body.workspace_id).toBe(me.workspaceId);
    expect(Array.isArray(body.notes)).toBe(true);
  });

  it("POST /v1/sync/token：网页端能拿到同步凭据，did 为 null", async () => {
    const res = await web("POST", "/v1/sync/token", { body: { max_schema_version: 1 } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expires_in: number };
    expect(body.expires_in).toBe(60);
    const payload = JSON.parse(
      Buffer.from((body.token.split(".")[1] ?? "") as string, "base64url").toString("utf8"),
    ) as { sub: string; did: string | null };
    expect(payload.sub).toBe(me.userId);
    // 桌面端的 did 是设备 id；浏览器没有设备，同步服务对 null 是显式支持的（sync/token.ts 的注释）
    expect(payload.did).toBeNull();
  });

  it("没有 X-Bianfa-Web 的裸 cookie 请求一律 401（/v1 不接受环境凭据）", async () => {
    const res = await t.app.request(`/v1/notes?workspace_id=${me.workspaceId}`, {
      headers: { cookie: `session=${me.userId}` },
    });
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "unauthorized" });
  });

  it("有头但没有会话 cookie → 401，不是 500", async () => {
    const res = await t.app.request(`/v1/notes?workspace_id=${me.workspaceId}`, {
      headers: { "x-bianfa-web": "1" },
    });
    expect(res.status).toBe(401);
  });

  it("非 GET 的 Origin 不在 APP_ORIGIN 里 → 403 bad_origin（CSRF 第二层）", async () => {
    const res = await web("POST", "/v1/sync/token", { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "bad_origin" });
  });

  it("非 GET 完全不带 Origin → 403 bad_origin", async () => {
    const res = await web("POST", "/v1/sync/token", { origin: null });
    expect(res.status).toBe(403);
  });

  it("Bearer 那一支不受影响：桌面端仍然照旧", async () => {
    const res = await t.app.request("/v1/workspaces", {
      headers: { authorization: `Bearer test.${me.userId}` },
    });
    expect(res.status).toBe(200);
  });
});
