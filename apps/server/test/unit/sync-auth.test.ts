import { describe, expect, it } from "vitest";
import {
  checkOrigin,
  inboxDocumentName,
  isAllowedPath,
  noteDocumentName,
  parseDocumentName,
  permAtLeast,
  SyncAuthError,
} from "../../src/sync/auth.js";
import { DEV_SYNC_TOKEN_SECRET, loadSyncEnv, parseAllowedOrigins } from "../../src/sync/env.js";

const WS = "0192abcd-ef00-7000-8000-00000000000a";
const NOTE = "0192abcd-ef00-7000-8000-00000000000b";

describe("documentName parser (03 §1.2 / 08 X9)", () => {
  it("parses note:<ws>:<id> and inbox:<ws>", () => {
    expect(parseDocumentName(noteDocumentName(WS, NOTE))).toEqual({
      kind: "note",
      name: `note:${WS}:${NOTE}`,
      workspaceId: WS,
      noteId: NOTE,
    });
    expect(parseDocumentName(inboxDocumentName(WS))).toEqual({
      kind: "inbox",
      name: `inbox:${WS}`,
      workspaceId: WS,
      noteId: null,
    });
  });
  it("rejects everything else (no default document fallback)", () => {
    for (const bad of [
      "",
      "note",
      `note:${NOTE}`,
      `note:${WS}:${NOTE}:extra`,
      `note:${WS.toUpperCase()}:${NOTE}`,
      "note:foo:bar",
      `inbox:${WS}:x`,
      "inbox:nope",
      `room:${WS}`,
      `note:${WS}:../${NOTE}`,
    ]) {
      expect(parseDocumentName(bad), bad).toBeNull();
    }
  });
});

describe("upgrade path check (08 X2)", () => {
  it("accepts / and /ws/*", () => {
    expect(isAllowedPath("/")).toBe(true);
    expect(isAllowedPath("/ws")).toBe(true);
    expect(isAllowedPath("/ws/")).toBe(true);
    expect(isAllowedPath("/ws/v1")).toBe(true);
    expect(isAllowedPath("/ws/v1/anything")).toBe(true);
  });
  it("rejects other paths", () => {
    expect(isAllowedPath("/healthz")).toBe(false);
    expect(isAllowedPath("/wsx")).toBe(false);
    expect(isAllowedPath("/api/ws")).toBe(false);
  });
});

describe("origin check (03 §1.1, 08 X12)", () => {
  const allowed = parseAllowedOrigins(
    " https://app.bianfa.app/, tauri://localhost ,http://tauri.localhost,,",
  );
  it("parses the allow list normalized", () => {
    expect(allowed).toEqual(
      new Set(["https://app.bianfa.app", "tauri://localhost", "http://tauri.localhost"]),
    );
    expect(parseAllowedOrigins(undefined)).toBeNull();
    expect(parseAllowedOrigins(" , ")).toBeNull();
  });
  it("allows missing Origin (desktop Rust/Tauri) and listed origins; rejects others", () => {
    expect(checkOrigin(undefined, allowed)).toBe(true);
    expect(checkOrigin("", allowed)).toBe(true);
    expect(checkOrigin("https://app.bianfa.app", allowed)).toBe(true);
    expect(checkOrigin("HTTPS://APP.BIANFA.APP/", allowed)).toBe(true);
    expect(checkOrigin("tauri://localhost", allowed)).toBe(true);
    expect(checkOrigin("https://evil.example", allowed)).toBe(false);
    expect(checkOrigin("null", allowed)).toBe(false);
  });
  it("is disabled when WS_ALLOWED_ORIGINS is unset", () => {
    expect(checkOrigin("https://evil.example", null)).toBe(true);
    expect(checkOrigin(undefined, null)).toBe(true);
  });
});

describe("SyncAuthError", () => {
  it("carries reason (for the PermissionDenied frame) and a close code", () => {
    expect(new SyncAuthError("forbidden", "x").reason).toBe("forbidden");
    expect(new SyncAuthError("forbidden", "x").code).toBe(4403);
    expect(new SyncAuthError("gone", "x").code).toBe(4410);
    expect(new SyncAuthError("too_many_documents", "x").code).toBe(4429);
    expect(new SyncAuthError("expired", "x")).toBeInstanceOf(Error);
  });
  it("ranks permissions", () => {
    expect(permAtLeast("viewer", "editor")).toBe(false);
    expect(permAtLeast("commenter", "editor")).toBe(false);
    expect(permAtLeast("editor", "editor")).toBe(true);
    expect(permAtLeast("manager", "editor")).toBe(true);
    expect(permAtLeast(null, "viewer")).toBe(false);
  });
});

describe("sync env", () => {
  const base = { DATABASE_URL: "postgres://x@127.0.0.1:5432/db" };
  it("defaults PORT=4000 and the fixed dev SYNC_TOKEN_SECRET outside production", () => {
    const env = loadSyncEnv({ ...base, NODE_ENV: "development" });
    expect(env.PORT).toBe(4000);
    expect(env.SYNC_TOKEN_SECRET).toBe(DEV_SYNC_TOKEN_SECRET);
    expect(env.SYNC_TOKEN_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.WS_ALLOWED_ORIGINS).toBeUndefined();
  });
  it("folds DATABASE_DIRECT_URL into DATABASE_URL_DIRECT and coerces PORT", () => {
    const env = loadSyncEnv({
      ...base,
      NODE_ENV: "development",
      PORT: "4100",
      DATABASE_DIRECT_URL: "postgres://x@127.0.0.1:5432/direct",
      REDIS_URL: "redis://127.0.0.1:6379",
    });
    expect(env.PORT).toBe(4100);
    expect(env.DATABASE_URL_DIRECT).toBe("postgres://x@127.0.0.1:5432/direct");
    expect(env.REDIS_URL).toBe("redis://127.0.0.1:6379");
  });
  it("refuses the dev secret in production and bad Redis URLs", () => {
    expect(() => loadSyncEnv({ ...base, NODE_ENV: "production" })).toThrow(/SYNC_TOKEN_SECRET/);
    expect(() => loadSyncEnv({ ...base, NODE_ENV: "development", REDIS_URL: "http://nope" })).toThrow();
  });
});
