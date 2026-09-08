// 同步凭据。三件事必须成立，否则表现全都是"连上一分钟就掉，然后再也连不上"：
//   ① 走同源会话通道（X-Bianfa-Web + cookie），绝不能出现 Bearer；
//   ② 显式带 max_schema_version：不带的话服务端按 1 算，将来遇到 v2 的便笺会被静默降成只读；
//   ③ 缓存 + 单飞：provider 每次开 socket 都会取一次，重连风暴不能变成打限流（30 次/分钟，
//      而且网页会话没有 device id / session id，一个账号的所有标签页共用这一个桶）。
import { SCHEMA_VERSION } from "@bianfa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSyncToken, invalidateSyncToken, resetSyncTokenCacheForTest } from "../sync/token.js";

interface Seen {
  url: string;
  init: RequestInit | undefined;
}
const seen: Seen[] = [];

function mockToken(expiresInMs: number, body?: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    seen.push({ url: String(input), init: init as RequestInit | undefined });
    return new Response(
      JSON.stringify(
        body ?? {
          token: `t${seen.length}`,
          expires_in: 60,
          expires_at: Date.now() + expiresInMs,
        },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
}

beforeEach(() => {
  seen.length = 0;
  resetSyncTokenCacheForTest();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("getSyncToken", () => {
  it("① 走同源会话通道，不带 Authorization", async () => {
    mockToken(60_000);
    await getSyncToken();
    const h = seen[0]?.init?.headers as Record<string, string> | undefined;
    expect(seen[0]?.url).toBe("/v1/sync/token");
    expect(seen[0]?.init?.method).toBe("POST");
    expect(h?.["x-bianfa-web"]).toBe("1");
    expect(seen[0]?.init?.credentials).toBe("same-origin");
    expect(h?.authorization).toBeUndefined();
  });

  it("② 显式带上 max_schema_version", async () => {
    mockToken(60_000);
    await getSyncToken();
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ max_schema_version: SCHEMA_VERSION });
  });

  it("③ 还没过期就复用，不重复请求", async () => {
    mockToken(60_000);
    const a = await getSyncToken();
    const b = await getSyncToken();
    expect(a).toBe(b);
    expect(seen).toHaveLength(1);
  });

  it("③ 并发只发一次（单飞）", async () => {
    mockToken(60_000);
    const [a, b, c] = await Promise.all([getSyncToken(), getSyncToken(), getSyncToken()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(seen).toHaveLength(1);
  });

  it("剩余寿命不足 10 秒就换新的（避开时钟偏差与往返）", async () => {
    mockToken(5_000);
    await getSyncToken();
    await getSyncToken();
    expect(seen).toHaveLength(2);
  });

  it("expires_at 给的是秒也认（< 1e12 视为秒）", async () => {
    mockToken(0, {
      token: "t-secs",
      expires_in: 60,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    });
    await getSyncToken();
    await getSyncToken();
    // 换算正确的话这个 token 还有约 60 秒，不该再请求
    expect(seen).toHaveLength(1);
  });

  it("invalidateSyncToken() 之后强制重取", async () => {
    mockToken(60_000);
    await getSyncToken();
    invalidateSyncToken();
    await getSyncToken();
    expect(seen).toHaveLength(2);
  });

  it("失败时抛出的错误只带错误码，绝不带 token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(getSyncToken()).rejects.toThrow("sync_token_unauthorized");
  });

  it("失败之后不会把 inflight 卡住，下一次还能再试", async () => {
    const fail = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(getSyncToken()).rejects.toThrow();
    await expect(getSyncToken()).rejects.toThrow();
    expect(fail).toHaveBeenCalledTimes(2);
  });
});
