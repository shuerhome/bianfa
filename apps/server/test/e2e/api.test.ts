// e2e（backend.yml e2e job）：对真实启动的 dist/api.js 冒烟。读 API_BASE_URL（缺省 skip）。
import { describe, expect, it } from "vitest";

const BASE = process.env.API_BASE_URL;
const WS = process.env.SYNC_WS_URL;

describe.skipIf(!BASE)("api e2e", () => {
  it("GET /healthz → 200 + server_time", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; server_time: number };
    expect(body.ok).toBe(true);
    expect(typeof body.server_time).toBe("number");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("GET /v1/notice → 204（无公告）或 200 信封", async () => {
    const res = await fetch(`${BASE}/v1/notice`);
    expect([200, 204]).toContain(res.status);
    if (res.status === 200) {
      const body = (await res.json()) as { v: number; payload: string; sig: string };
      expect(body.v).toBe(1);
      expect(res.headers.get("cache-control")).toContain("max-age=300");
    }
  });

  it("GET /v1/me 无 Bearer → 401 + WWW-Authenticate；带 cookie 亦 401", async () => {
    const res = await fetch(`${BASE}/v1/me`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
    const withCookie = await fetch(`${BASE}/v1/me`, { headers: { cookie: "better-auth.session_token=abc" } });
    expect(withCookie.status).toBe(401);
  });

  it("安全头存在，X-Powered-By 不存在", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it.skipIf(!WS)("sync-ws /healthz 可达", async () => {
    const http = (WS as string).replace(/^ws/, "http");
    const res = await fetch(`${http}/healthz`);
    expect(res.status).toBeLessThan(300);
  });
});
