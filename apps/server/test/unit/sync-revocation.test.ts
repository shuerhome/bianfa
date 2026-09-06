import { describe, expect, it } from "vitest";
import { createHealth } from "../../src/sync/health.js";
import { parseRedisUrl } from "../../src/sync/redis.js";
import {
  bumpStateless,
  parseNotesChanged,
  parseRevocation,
  revokedStateless,
  scopeToAction,
} from "../../src/sync/revocation.js";

describe("authz_revoked scope → action (08 X4)", () => {
  it("note closes only that document; every other scope closes all of the user's connections", () => {
    expect(scopeToAction("note", "n1")).toEqual({ kind: "close_document", noteId: "n1" });
    for (const scope of ["org", "team", "workspace", "session", "user"] as const) {
      expect(scopeToAction(scope, "x")).toEqual({ kind: "close_user" });
    }
  });
  it("parses payloads produced by notify_authz_revoked()", () => {
    expect(parseRevocation('{"user_id":"u1","scope":"note","id":"n1"}')).toEqual({
      user_id: "u1",
      scope: "note",
      id: "n1",
    });
    expect(parseRevocation('{"user_id":"u1","scope":"user","id":null}')).toEqual({
      user_id: "u1",
      scope: "user",
      id: "*",
    });
    expect(parseRevocation('{"user_id":"u1","scope":"galaxy","id":"n1"}')).toBeNull();
    expect(parseRevocation('{"scope":"note"}')).toBeNull();
    expect(parseRevocation("not json")).toBeNull();
  });
  it("parses notes_changed and builds stateless payloads", () => {
    expect(parseNotesChanged('{"workspace_id":"w","note_id":"n","version":7}')).toEqual({
      workspace_id: "w",
      note_id: "n",
      version: 7,
    });
    expect(parseNotesChanged("{}")).toBeNull();
    expect(JSON.parse(bumpStateless("w", 7))).toEqual({ t: "bump", workspace_id: "w", version: 7 });
    expect(JSON.parse(revokedStateless("n"))).toEqual({ t: "authz.revoked", note_id: "n" });
  });
});

describe("/healthz rules (03 §1.9)", () => {
  const okPool = { query: async () => ({ rows: [{ "?column?": 1 }] }) } as never;
  const badPool = { query: async () => Promise.reject(new Error("down")) } as never;
  const slowPool = { query: () => new Promise(() => {}) } as never;
  let t = 1_000_000;
  const now = () => t;

  it("200 only when db ok, redis ok (if configured), listen up or down < grace, and not stopping", async () => {
    const h = createHealth({
      pool: okPool,
      listenStatus: () => ({ enabled: true, up: true, downSince: null }),
      stopping: () => false,
      now,
    });
    expect((await h.check()).ok).toBe(true);
  });
  it("503 when the database is unreachable or too slow (2 s budget)", async () => {
    const h1 = createHealth({
      pool: badPool,
      listenStatus: () => ({ enabled: false, up: false, downSince: null }),
      stopping: () => false,
      now,
    });
    expect((await h1.check()).checks.db).toBe(false);
    const h2 = createHealth({
      pool: slowPool,
      listenStatus: () => ({ enabled: false, up: false, downSince: null }),
      stopping: () => false,
      timeoutMs: 20,
      now,
    });
    const r = await h2.check();
    expect(r.ok).toBe(false);
    expect(r.checks.db).toBe(false);
  });
  it("tolerates a LISTEN outage shorter than 60 s, fails after", async () => {
    let downSince = 1_000_000 - 30_000;
    const h = createHealth({
      pool: okPool,
      listenStatus: () => ({ enabled: true, up: false, downSince }),
      stopping: () => false,
      now,
    });
    expect((await h.check()).ok).toBe(true);
    downSince = 1_000_000 - 61_000;
    expect((await h.check()).ok).toBe(false);
    t += 1;
  });
  it("fails on redis ping failure and while stopping", async () => {
    const h = createHealth({
      pool: okPool,
      redisPing: async () => Promise.reject(new Error("no redis")),
      listenStatus: () => ({ enabled: false, up: false, downSince: null }),
      stopping: () => false,
      now,
    });
    const r = await h.check();
    expect(r.checks.redis).toBe(false);
    expect(r.ok).toBe(false);
    const stopping = createHealth({
      pool: okPool,
      listenStatus: () => ({ enabled: false, up: false, downSince: null }),
      stopping: () => true,
      now,
    });
    expect((await stopping.check()).ok).toBe(false);
  });
});

describe("REDIS_URL → extension-redis host/port/options", () => {
  it("parses password, db and tls", () => {
    expect(parseRedisUrl("redis://:s3cret@redis:6379/0")).toEqual({
      host: "redis",
      port: 6379,
      options: { password: "s3cret", db: 0 },
    });
    expect(parseRedisUrl("rediss://user:p%40ss@host.example:6380/2")).toEqual({
      host: "host.example",
      port: 6380,
      options: { username: "user", password: "p@ss", db: 2, tls: {} },
    });
    expect(parseRedisUrl("redis://localhost")).toEqual({ host: "localhost", port: 6379, options: {} });
    expect(() => parseRedisUrl("http://x")).toThrow();
  });
});
