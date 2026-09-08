// bearerOnly 是 /v1 的"有没有凭据"这一步。它有两个例外，两个都必须钉住：
//   ① isAnonymousV1Path（/v1/notice、/v1/admin/* 等）；
//   ② X-Bianfa-Web —— 网页端 / PWA 的同源会话通道，真正的判定在 requireBearerOrWebSession。
// 曾经漏掉 ② 的后果：网页端每一个 /v1 请求都在这里被 401，而所有单测都挂在这道中间件后面，全绿。
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { isAnonymousV1Path } from "../../src/app.js";
import { bearerOnly } from "../../src/http/middleware.js";

function app() {
  const v1 = new Hono();
  v1.use("*", bearerOnly(isAnonymousV1Path));
  v1.all("*", (c) => c.json({ reached: true }));
  const root = new Hono();
  root.route("/v1", v1);
  return root;
}

describe("bearerOnly", () => {
  it("裸 cookie（没有 Authorization、没有 X-Bianfa-Web）→ 401", async () => {
    const res = await app().request("/v1/notes", { headers: { cookie: "session=x" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("X-Bianfa-Web: 1 放行到后面的真实校验（网页端 / PWA）", async () => {
    for (const [method, path] of [
      ["GET", "/v1/notes"],
      ["GET", "/v1/workspaces"],
      ["POST", "/v1/sync/token"],
    ] as const) {
      const res = await app().request(path, {
        method,
        headers: { cookie: "session=x", "x-bianfa-web": "1" },
      });
      expect(res.status, `${method} ${path}`).toBe(200);
    }
  });

  // 注意不要拿 "1 " 当反例：HTTP 头的值在解析时就会被去掉首尾空白（Fetch 规范如此，
  // Request 构造出来就已经是 "1"），所以那不是"别的值"，而是同一个值。
  it("X-Bianfa-Web 只认字面量 1，别的值不放行", async () => {
    for (const v of ["0", "true", "", "yes", "11"]) {
      const res = await app().request("/v1/notes", { headers: { "x-bianfa-web": v } });
      expect(res.status, JSON.stringify(v)).toBe(401);
    }
  });

  it("Bearer 照常放行；格式不对的 Authorization 仍然 401", async () => {
    expect((await app().request("/v1/notes", { headers: { authorization: "Bearer abc" } })).status).toBe(200);
    expect((await app().request("/v1/notes", { headers: { authorization: "Basic abc" } })).status).toBe(401);
  });

  it("匿名路径不受影响", async () => {
    expect((await app().request("/v1/notice")).status).toBe(200);
    expect((await app().request("/v1/admin/admins")).status).toBe(200);
  });
});
