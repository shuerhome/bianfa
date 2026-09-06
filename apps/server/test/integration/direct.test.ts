// 直连 LISTEN 客户端（规格 01 S3）：收通知、后端被杀后自动重连并重新 LISTEN。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDirectClient, type DirectClient } from "../../src/db/direct.js";
import { DIRECT_URL, type Fixture, hasDb, openAdmin } from "./helpers.js";

const CHANNEL = "bianfa_test_channel";

function waitFor<T>(register: (resolve: (v: T) => void) => void, timeoutMs = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
    register((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });
}

describe.skipIf(!hasDb)("direct LISTEN client", () => {
  let f: Fixture;
  let client: DirectClient;
  const received: string[] = [];
  let pending: ((payload: string) => void) | undefined;

  beforeAll(async () => {
    f = openAdmin();
    client = createDirectClient({ connectionString: DIRECT_URL as string, reconnectBaseMs: 50, reconnectMaxMs: 500 });
    await client.listen(CHANNEL, (payload) => {
      received.push(payload);
      pending?.(payload);
    });
    await client.waitConnected();
  });

  afterAll(async () => {
    await client.close();
    await f.admin.end();
  });

  it("收到 pg_notify 的 payload（NOTIFY 经业务连接发出即可，只有 LISTEN 必须直连）", async () => {
    const got = waitFor<string>((resolve) => {
      pending = resolve;
    });
    await f.admin.query("SELECT pg_notify($1, $2)", [CHANNEL, "hello"]);
    expect(await got).toBe("hello");
    pending = undefined;
  });

  it("后端连接被终止后自动重连并重新 LISTEN", async () => {
    const pids = await f.admin.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE $1 AND pid <> pg_backend_pid()`,
      [`LISTEN %${CHANNEL}%`],
    );
    expect(pids.rows.length).toBeGreaterThan(0);
    for (const { pid } of pids.rows) await f.admin.query("SELECT pg_terminate_backend($1)", [pid]);

    // 等它掉线再等它回来
    await waitFor<void>((resolve) => {
      const poll = () => (client.connected ? setTimeout(poll, 20) : resolve());
      poll();
    });
    await client.waitConnected(15_000);

    const got = waitFor<string>((resolve) => {
      pending = resolve;
    });
    await f.admin.query("SELECT pg_notify($1, $2)", [CHANNEL, "after-reconnect"]);
    expect(await got).toBe("after-reconnect");
    expect(received).toEqual(["hello", "after-reconnect"]);
  });
});
