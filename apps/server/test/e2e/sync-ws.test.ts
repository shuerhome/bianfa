// sync-ws e2e（backend.yml e2e 步骤）：对真实 dist/sync.js 进程（SYNC_WS_URL，缺省 skip）做冒烟：
// /healthz、/metrics、/ws/v1 升级、Auth 帧被拒的 reason。token 用与进程相同的 .env.test 密钥签（NODE_ENV=test）。
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { uuidv7 } from "../../src/db/ids.js";
import { noteDocumentName } from "../../src/sync/auth.js";
import { loadSyncEnv } from "../../src/sync/env.js";
import { signSyncToken } from "../../src/sync/token.js";

const WS_URL = process.env.SYNC_WS_URL;

function httpBase(wsUrl: string): string {
  return wsUrl.replace(/^ws/, "http").replace(/\/+$/, "");
}

async function authResult(url: string, name: string, token: string): Promise<string> {
  const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: WebSocket, maxAttempts: 1 });
  const doc = new Y.Doc();
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no auth result within 10 s")), 10_000);
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name,
      document: doc,
      token,
      onAuthenticationFailed: ({ reason }: { reason: string }) => {
        clearTimeout(timer);
        provider.destroy();
        socket.destroy();
        resolve(`failed:${reason}`);
      },
      onAuthenticated: ({ scope }: { scope: string }) => {
        clearTimeout(timer);
        provider.destroy();
        socket.destroy();
        resolve(`ok:${scope}`);
      },
    });
    provider.attach();
  });
}

describe.skipIf(!WS_URL)("sync-ws e2e", () => {
  const url = WS_URL as string;

  it("GET /healthz is 2xx and /metrics exposes bianfa_ws_* metrics", async () => {
    const hz = await fetch(`${httpBase(url)}/healthz`);
    expect(hz.ok).toBe(true);
    expect(await hz.json()).toMatchObject({ ok: true, service: "sync" });
    const m = await fetch(`${httpBase(url)}/metrics`);
    expect(m.status).toBe(200);
    const body = await m.text();
    expect(body).toContain("bianfa_ws_connections");
    expect(body).toContain("bianfa_ws_listen_up");
  });

  it("accepts the upgrade on /ws/v1 and rejects a bogus token with bad_token", async () => {
    const name = noteDocumentName(uuidv7(), uuidv7());
    expect(await authResult(`${url.replace(/\/+$/, "")}/ws/v1`, name, "not-a-jwt")).toBe("failed:bad_token");
  });

  it("rejects a valid token for an unknown workspace with forbidden", async () => {
    const env = loadSyncEnv({
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://unused@127.0.0.1:5432/unused",
    });
    const { token } = await signSyncToken(env.SYNC_TOKEN_SECRET, {
      sub: `e2e-${uuidv7()}`,
      did: null,
      sid: null,
      msv: 1,
    });
    const name = noteDocumentName(uuidv7(), uuidv7());
    expect(await authResult(`${url.replace(/\/+$/, "")}/ws/v1`, name, token)).toBe("failed:forbidden");
  });
});
