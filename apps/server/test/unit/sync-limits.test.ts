import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import { ConnectionRegistry, type SyncConnection } from "../../src/sync/connections.js";
import {
  AWARENESS_BURST,
  classifyMessage,
  createAwarenessBucket,
  HANDSHAKE_BURST,
  MESSAGE_BURST,
  MESSAGE_RATE_PER_SECOND,
  messageTypeName,
  peekMessageType,
  peekSyncSubType,
  RATE_CLOSE_AFTER_MS,
  SocketLimiter,
  sanitizeAwarenessStates,
  TokenBucket,
} from "../../src/sync/limits.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("TokenBucket", () => {
  it("starts full, drains, and refills at the configured rate", () => {
    const c = clock();
    const b = new TokenBucket(30, 60, c.now);
    for (let i = 0; i < 60; i++) expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    c.advance(100); // 3 tokens
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    c.advance(10_000); // capped at capacity
    expect(b.available).toBe(60);
  });
});

describe("SocketLimiter (03 §7: 30 msg/s, bucket 60, close after 10 s over limit)", () => {
  it("rejects when the bucket is empty and escalates to close after 10 s of sustained overuse", () => {
    const c = clock();
    const l = new SocketLimiter(c.now);
    for (let i = 0; i < MESSAGE_BURST; i++) expect(l.takeMessage()).toBe("ok");
    expect(l.takeMessage()).toBe("reject");
    // 持续以 100 msg/s（> 30/s）发送：每 100 ms 补 3 个令牌、发 10 条 → 一直超限；不满 10 s 只 reject，满 10 s 升级为 close
    const verdicts = new Set<string>();
    let closedAt: number | null = null;
    for (let step = 1; step <= 120 && closedAt === null; step++) {
      c.advance(100);
      for (let i = 0; i < 10; i++) {
        const v = l.takeMessage();
        verdicts.add(v);
        if (v === "close") {
          closedAt = step * 100;
          break;
        }
      }
    }
    expect(closedAt).not.toBeNull();
    expect(closedAt as number).toBeGreaterThanOrEqual(RATE_CLOSE_AFTER_MS);
    expect(closedAt as number).toBeLessThan(RATE_CLOSE_AFTER_MS + 500);
    expect(verdicts.has("reject")).toBe(true);
  });
  it("starts a new streak after a quiet gap without rejections", () => {
    const c = clock();
    const l = new SocketLimiter(c.now);
    for (let i = 0; i < MESSAGE_BURST + 1; i++) l.takeMessage();
    const first = l.overLimitSince;
    expect(first).not.toBeNull();
    // 8 s 后再次超限：间隔 > 1 s → 新连击，起点重置，不会因为累计而关闭
    c.advance(8_000);
    for (let i = 0; i < MESSAGE_BURST + 1; i++) l.takeMessage();
    expect(l.overLimitSince).toBe(c.now());
    expect(l.overLimitSince).not.toBe(first);
    c.advance(3_000);
    for (let i = 0; i < MESSAGE_BURST + 1; i++) expect(l.takeMessage()).not.toBe("close");
    expect(MESSAGE_RATE_PER_SECOND).toBe(30);
  });
  it("keeps handshake traffic on its own bucket so opening 64 documents at once is not rate-limited", () => {
    const c = clock();
    const l = new SocketLimiter(c.now);
    for (let i = 0; i < 128; i++) expect(l.takeMessage("handshake")).toBe("ok");
    expect(l.takeMessage("data")).toBe("ok");
    expect(HANDSHAKE_BURST).toBeGreaterThanOrEqual(128);
  });
  it("awareness bucket (per document connection) allows a small burst then 2/s", () => {
    const c = clock();
    const b = createAwarenessBucket(c.now);
    for (let i = 0; i < AWARENESS_BURST; i++) expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    c.advance(500);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
  });
  it("classifies Hocuspocus messages into awareness / handshake / data", () => {
    expect(classifyMessage(frame("d", 1))).toBe("awareness");
    expect(classifyMessage(frame("d", 0, 0))).toBe("handshake"); // SyncStep1
    expect(classifyMessage(frame("d", 0, 1))).toBe("handshake"); // SyncStep2（每文档连接一条）
    expect(classifyMessage(frame("d", 0, 2))).toBe("data"); // Update
    for (const t of [3, 7, 8, 9, 10]) expect(classifyMessage(frame("d", t))).toBe("handshake");
    expect(classifyMessage(frame("d", 5))).toBe("data"); // Stateless
    expect(classifyMessage(new Uint8Array([0xff]))).toBe("data");
  });
});

function frame(documentName: string, type: number, sub?: number): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarString(enc, documentName);
  encoding.writeVarUint(enc, type);
  if (sub !== undefined) encoding.writeVarUint(enc, sub);
  return encoding.toUint8Array(enc);
}

describe("message peeking", () => {
  it("reads the Hocuspocus message type after the document name", () => {
    expect(peekMessageType(frame("note:a:b", 0, 2))).toBe(0);
    expect(peekSyncSubType(frame("note:a:b", 0, 2))).toBe(2);
    expect(peekMessageType(frame("x", 1))).toBe(1);
    expect(peekMessageType(new Uint8Array([0xff]))).toBe(-1);
    expect(messageTypeName(0)).toBe("sync");
    expect(messageTypeName(1)).toBe("awareness");
    expect(messageTypeName(2)).toBe("auth");
    expect(messageTypeName(99)).toBe("unknown");
  });
});

describe("awareness sanitizer (03 §1.8 fields {userId,name,color,editing})", () => {
  it("drops unknown keys, pins userId, truncates strings, coerces editing", () => {
    const states = new Map<number, Record<string, unknown>>([
      [
        1,
        {
          userId: "spoof",
          name: "x".repeat(200),
          color: "#fff",
          editing: "yes",
          cursor: { a: 1 },
          avatarUrl: "u",
        },
      ],
      [2, { name: 42 }],
      [3, null as unknown as Record<string, unknown>],
    ]);
    sanitizeAwarenessStates(states, "u1");
    expect(states.get(1)).toEqual({ userId: "u1", name: "x".repeat(64), color: "#fff", editing: false });
    expect(states.get(2)).toEqual({ userId: "u1", name: "" });
    expect(states.has(3)).toBe(false);
  });
});

function fakeConnection(
  userId: string,
  noteId: string,
  documentName: string,
  closed: string[],
): SyncConnection {
  return {
    context: {
      userId,
      deviceId: null,
      sessionId: null,
      msv: 1,
      kind: "note",
      workspaceId: "ws",
      noteId,
      perm: "editor",
      readOnly: false,
      createIfMissing: false,
    },
    document: { name: documentName },
    readOnly: false,
    webSocket: {
      readyState: 1,
      send() {},
      close(code?: number, reason?: string) {
        closed.push(`${code}:${reason}`);
      },
    },
  } as unknown as SyncConnection;
}

describe("ConnectionRegistry (per-user / per-socket limits)", () => {
  it("tracks sockets per user and closes the oldest beyond the limit", () => {
    const c = clock();
    const reg = new ConnectionRegistry(c.now);
    const closed: string[] = [];
    for (let i = 0; i < 4; i++) {
      c.advance(10);
      reg.addConnection(`s${i}`, fakeConnection("u1", "n1", "note:ws:n1", closed));
    }
    expect(reg.socketsOf("u1").length).toBe(4);
    const victims = reg.enforceUserSocketLimit("u1", 2, "s3");
    expect(victims.map((v) => v.socketId)).toEqual(["s0", "s1"]);
    expect(closed).toEqual(["4429:too_many_connections", "4429:too_many_connections"]);
    expect(
      reg
        .socketsOf("u1")
        .map((s) => s.socketId)
        .sort(),
    ).toEqual(["s2", "s3"]);
  });
  it("reserves document slots at auth time so a burst of opens cannot exceed the per-socket limit", () => {
    const c = clock();
    const reg = new ConnectionRegistry(c.now);
    const closed: string[] = [];
    for (let i = 0; i < 3; i++) expect(reg.reserveDocument("s1", 3)).toBe(true);
    expect(reg.reserveDocument("s1", 3)).toBe(false);
    // connected 转正后仍然满
    reg.addConnection("s1", fakeConnection("u1", "n1", "note:ws:n1", closed));
    expect(reg.documentCount("s1")).toBe(1);
    expect(reg.reserveDocument("s1", 3)).toBe(false);
    // 预占 30 s 未转正 → 失效
    c.advance(31_000);
    expect(reg.reserveDocument("s1", 3)).toBe(true);
  });
  it("counts documents per socket and finds connections per (user, note)", () => {
    const reg = new ConnectionRegistry();
    const closed: string[] = [];
    reg.addConnection("s1", fakeConnection("u1", "n1", "note:ws:n1", closed));
    reg.addConnection("s1", fakeConnection("u1", "n2", "note:ws:n2", closed));
    reg.addConnection("s2", fakeConnection("u2", "n1", "note:ws:n1", closed));
    expect(reg.documentCount("s1")).toBe(2);
    expect(reg.connectionsOf("u1", "n1").length).toBe(1);
    expect(reg.connectionsOf("u2", "n2").length).toBe(0);
    expect([...reg.allConnections()].length).toBe(3);
    reg.removeConnection("s1", "note:ws:n1");
    expect(reg.documentCount("s1")).toBe(1);
    reg.removeConnection("s1", "note:ws:n2");
    expect(reg.sockets.has("s1")).toBe(false);
    expect(reg.socketsOf("u1")).toEqual([]);
  });
});
