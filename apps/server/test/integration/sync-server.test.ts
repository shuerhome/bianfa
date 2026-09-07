// sync-ws 服务端集成（规格 03 §8「服务端集成」行）：认证/授权、持久化、收敛、撤销、重校验、inbox、限流、限额。
// 进程内起 Hocuspocus（临时端口），客户端用 @hocuspocus/provider + ws，DB 为 DATABASE_URL 指向的库（global-setup 已迁移）。
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { withUserTx } from "../../src/db/client.js";
import { uuidv7 } from "../../src/db/ids.js";
import { loadNoteDoc } from "../../src/notes/doc-store.js";
import { inboxDocumentName, noteDocumentName } from "../../src/sync/auth.js";
import { type Fixture, hasDb, openAdmin, seedUser, truncateAll } from "./helpers.js";
import {
  badAudienceToken,
  bodyText,
  type Client,
  connectClient,
  ensureProjectQueue,
  type Harness,
  httpGet,
  openSocket,
  projectJobs,
  readNote,
  seedNote,
  seedTeamWorkspace,
  shareNote,
  sleep,
  startSync,
  tokenFor,
  typeText,
  updateRows,
  waitFor,
} from "./sync-harness.js";

type Seeded = { userId: string; workspaceId: string };

describe.skipIf(!hasDb)("sync-ws server", () => {
  let f: Fixture;
  let h: Harness;
  let owner: Seeded;
  let stranger: Seeded;
  let viewer: Seeded;
  const clients: Client[] = [];
  const track = (c: Client) => {
    clients.push(c);
    return c;
  };

  async function counter(name: "authFailures" | "rejected" | "authzRevoked", label: string): Promise<number> {
    const data = await h.sync.metrics[name].get();
    return data.values.find((v) => Object.values(v.labels).includes(label))?.value ?? 0;
  }

  beforeAll(async () => {
    f = openAdmin();
    await truncateAll(f.admin);
    await ensureProjectQueue();
    const tag = uuidv7().slice(-8);
    owner = await seedUser(f.adminDb, `owner-${tag}`);
    stranger = await seedUser(f.adminDb, `stranger-${tag}`);
    viewer = await seedUser(f.adminDb, `viewer-${tag}`);
    h = await startSync({ recheckIntervalMs: 400 });
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
  });

  afterAll(async () => {
    await h.stop();
    await f.admin.end();
  });

  it("serves /healthz 200 and /metrics with the spec metric names; 404 elsewhere", async () => {
    await waitFor(
      async () => (await h.sync.metrics.listenUp.get()).values[0]?.value === 1,
      5_000,
      "listen up",
    );
    const hz = await httpGet(h.port, "/healthz");
    expect(hz.status).toBe(200);
    expect(JSON.parse(hz.body)).toMatchObject({ ok: true, service: "sync" });
    const m = await httpGet(h.port, "/metrics");
    expect(m.status).toBe(200);
    for (const name of [
      "bianfa_ws_connections",
      "bianfa_ws_documents",
      "bianfa_ws_messages_total",
      "bianfa_ws_auth_failures_total",
      "bianfa_ws_store_seconds",
      "bianfa_ws_store_failures_total",
      "bianfa_ws_rejected_total",
      "bianfa_ws_authz_revoked_total",
      "bianfa_ws_listen_up",
    ]) {
      expect(m.body, name).toContain(name);
    }
    expect(m.body).toMatch(/bianfa_ws_listen_up 1/);
    expect((await httpGet(h.port, "/nope")).status).toBe(404);
  });

  it("accepts upgrades on /ws/v1 (08 X2)", async () => {
    const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    const c = track(
      connectClient(
        `${h.url}/ws/v1`,
        noteDocumentName(owner.workspaceId, noteId),
        await tokenFor(owner.userId),
      ),
    );
    await waitFor(() => c.events.synced > 0, 5_000, "synced via /ws/v1");
    const ws = new WebSocket(`${h.url}/other`);
    const closed = await new Promise<string>((resolve) => {
      ws.on("error", (e) => resolve(e.message));
      ws.on("unexpected-response", (_req, res) => resolve(`status ${res.statusCode}`));
      ws.on("open", () => resolve("open"));
    });
    expect(closed).toMatch(/404/);
  });

  it("persists edits: note_updates rows, notes.head_seq / crdt_sv, and a note.project job", async () => {
    const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    const name = noteDocumentName(owner.workspaceId, noteId);
    const c = track(connectClient(h.url, name, await tokenFor(owner.userId)));
    await waitFor(() => c.events.synced > 0, 5_000, "synced");
    expect(c.events.authenticated).toEqual(["read-write"]);

    typeText(c.doc, "第一行 👋");
    await waitFor(async () => (await readNote(f.admin, noteId))?.head_seq === 1, 5_000, "seq 1 stored");
    const row = await readNote(f.admin, noteId);
    expect(row?.crdt_sv).toBeInstanceOf(Buffer);
    expect(row?.crdt_bytes).toBeGreaterThan(0);
    expect(await updateRows(f.admin, noteId)).toEqual([{ seq: 1, author_id: owner.userId }]);
    const jobs = await projectJobs(f.admin, noteId);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs[0]).toMatchObject({ note_id: noteId, seq: 1 });

    typeText(c.doc, "第二行");
    await waitFor(async () => (await readNote(f.admin, noteId))?.head_seq === 2, 5_000, "seq 2 stored");
    expect((await updateRows(f.admin, noteId)).map((r) => r.seq)).toEqual([1, 2]);

    // 从存储重建 == 客户端文档
    const { doc } = await withUserTx(owner.userId, (tx) => loadNoteDoc(tx, noteId), h.db);
    expect(bodyText(doc)).toBe(bodyText(c.doc));
    expect(bodyText(doc)).toContain("第一行 👋");
    expect(
      Buffer.from(Y.encodeStateAsUpdateV2(doc)).equals(Buffer.from(Y.encodeStateAsUpdateV2(c.doc))),
    ).toBe(true);
    doc.destroy();
  });

  it("reloads the persisted state when the document is opened again", async () => {
    const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    const name = noteDocumentName(owner.workspaceId, noteId);
    const c = track(connectClient(h.url, name, await tokenFor(owner.userId)));
    await waitFor(() => c.events.synced > 0);
    typeText(c.doc, "persist me");
    await waitFor(async () => (await readNote(f.admin, noteId))?.head_seq === 1);
    c.destroy();
    clients.length = 0;
    await waitFor(() => !h.sync.hocuspocus.documents.has(name), 5_000, "document unloaded");
    const again = track(connectClient(h.url, name, await tokenFor(owner.userId)));
    await waitFor(() => again.events.synced > 0);
    await waitFor(() => bodyText(again.doc).includes("persist me"), 5_000, "state reloaded");
    // 未改动 → 不产生新 update 行
    await sleep(300);
    expect((await readNote(f.admin, noteId))?.head_seq).toBe(1);
  });

  it("two providers on one note converge byte-identically", async () => {
    const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    const name = noteDocumentName(owner.workspaceId, noteId);
    const c1 = track(connectClient(h.url, name, await tokenFor(owner.userId)));
    const c2 = track(connectClient(h.url, name, await tokenFor(owner.userId)));
    await waitFor(() => c1.events.synced > 0 && c2.events.synced > 0);
    typeText(c1.doc, "from one 🇨🇳");
    typeText(c2.doc, "from two 便笺");
    await waitFor(
      () =>
        bodyText(c1.doc) === bodyText(c2.doc) &&
        bodyText(c1.doc).includes("from one") &&
        bodyText(c1.doc).includes("from two"),
      5_000,
      "convergence",
    );
    expect(
      Buffer.from(Y.encodeStateAsUpdateV2(c1.doc)).equals(Buffer.from(Y.encodeStateAsUpdateV2(c2.doc))),
    ).toBe(true);
    const serverDoc = h.sync.hocuspocus.documents.get(name);
    expect(serverDoc && bodyText(serverDoc)).toBe(bodyText(c1.doc));
    await waitFor(async () => ((await readNote(f.admin, noteId))?.head_seq ?? 0) >= 1);
  });

  it("creates the notes row on first connect for the workspace owner and refuses a stranger", async () => {
    const noteId = uuidv7();
    const name = noteDocumentName(owner.workspaceId, noteId);
    expect(await readNote(f.admin, noteId)).toBeNull();
    const forbiddenBefore = await counter("authFailures", "forbidden");

    const c = track(connectClient(h.url, name, await tokenFor(owner.userId)));
    await waitFor(() => c.events.synced > 0);
    expect(await readNote(f.admin, noteId)).toMatchObject({
      created_by: owner.userId,
      workspace_id: owner.workspaceId,
      head_seq: 0,
    });
    typeText(c.doc, "offline-created note");
    await waitFor(async () => (await readNote(f.admin, noteId))?.head_seq === 1);

    const s = track(connectClient(h.url, name, await tokenFor(stranger.userId)));
    await waitFor(() => s.events.authFailed.length > 0);
    expect(s.events.authFailed[0]).toBe("forbidden");
    expect(await counter("authFailures", "forbidden")).toBeGreaterThanOrEqual(forbiddenBefore + 1);

    // 陌生人也不能在别人的工作区里"离线新建"
    const fresh = uuidv7();
    const s2 = track(
      connectClient(h.url, noteDocumentName(owner.workspaceId, fresh), await tokenFor(stranger.userId)),
    );
    await waitFor(() => s2.events.authFailed.length > 0);
    expect(s2.events.authFailed[0]).toBe("forbidden");
    expect(await readNote(f.admin, fresh)).toBeNull();

    // documentName 里的 workspace 与行不符 → forbidden
    const s3 = track(
      connectClient(h.url, noteDocumentName(stranger.workspaceId, noteId), await tokenFor(stranger.userId)),
    );
    await waitFor(() => s3.events.authFailed.length > 0);
    expect(s3.events.authFailed[0]).toBe("forbidden");
  });

  it("rejects expired / bad-audience / wrong-secret tokens and malformed document names", async () => {
    const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    const name = noteDocumentName(owner.workspaceId, noteId);
    const expiredBefore = await counter("authFailures", "expired");
    const badBefore = await counter("authFailures", "bad_token");
    const expired = track(
      connectClient(h.url, name, await tokenFor(owner.userId, { now: Math.floor(Date.now() / 1000) - 600 })),
    );
    const badAud = track(connectClient(h.url, name, await badAudienceToken(owner.userId)));
    const wrong = track(
      connectClient(
        h.url,
        name,
        await tokenFor(owner.userId, { secret: "another-secret-that-is-long-enough-0123456789abcdef" }),
      ),
    );
    const badName = track(connectClient(h.url, `note:${noteId}`, await tokenFor(owner.userId)));
    await waitFor(
      () => [expired, badAud, wrong, badName].every((c) => c.events.authFailed.length > 0),
      5_000,
      "all rejected",
    );
    expect(expired.events.authFailed[0]).toBe("expired");
    expect(badAud.events.authFailed[0]).toBe("bad_token");
    expect(wrong.events.authFailed[0]).toBe("bad_token");
    expect(badName.events.authFailed[0]).toBe("forbidden");
    expect(await counter("authFailures", "expired")).toBeGreaterThanOrEqual(expiredBefore + 1);
    expect(await counter("authFailures", "bad_token")).toBeGreaterThanOrEqual(badBefore + 2);
  });

  it("answers gone for purged notes and never recreates them", async () => {
    const noteId = await seedNote(f.adminDb, {
      workspaceId: owner.workspaceId,
      userId: owner.userId,
      purgedAt: new Date(),
      purgeAfter: new Date(Date.now() - 60_000),
    });
    const goneBefore = await counter("authFailures", "gone");
    const c = track(
      connectClient(h.url, noteDocumentName(owner.workspaceId, noteId), await tokenFor(owner.userId)),
    );
    await waitFor(() => c.events.authFailed.length > 0);
    expect(c.events.authFailed[0]).toBe("gone");
    expect(await counter("authFailures", "gone")).toBeGreaterThanOrEqual(goneBefore + 1);
    expect((await readNote(f.admin, noteId))?.head_seq).toBe(0);
  });

  it("gives viewers a read-only connection whose updates are never persisted", async () => {
    const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    await shareNote(f.adminDb, {
      noteId,
      granteeUserId: viewer.userId,
      perm: "viewer",
      createdBy: owner.userId,
    });
    const name = noteDocumentName(owner.workspaceId, noteId);
    const v = track(connectClient(h.url, name, await tokenFor(viewer.userId)));
    await waitFor(() => v.events.authenticated.length > 0);
    expect(v.events.authenticated).toEqual(["readonly"]);
    await waitFor(() => v.events.synced > 0);
    typeText(v.doc, "viewer tries to write");
    await sleep(600);
    expect(await updateRows(f.admin, noteId)).toEqual([]);
    expect((await readNote(f.admin, noteId))?.head_seq).toBe(0);
    const serverDoc = h.sync.hocuspocus.documents.get(name);
    expect(serverDoc && bodyText(serverDoc)).toBe("");
  });

  it("forces read-only when the client's max schema version is below the note's", async () => {
    const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    await f.admin.query("UPDATE notes SET schema_version = 3 WHERE id = $1", [noteId]);
    const c = track(
      connectClient(
        h.url,
        noteDocumentName(owner.workspaceId, noteId),
        await tokenFor(owner.userId, { msv: 2 }),
      ),
    );
    await waitFor(() => c.events.authenticated.length > 0);
    expect(c.events.authenticated).toEqual(["readonly"]);
    const ok = track(
      connectClient(
        h.url,
        noteDocumentName(owner.workspaceId, noteId),
        await tokenFor(owner.userId, { msv: 3 }),
      ),
    );
    await waitFor(() => ok.events.authenticated.length > 0);
    expect(ok.events.authenticated).toEqual(["read-write"]);
  });

  it("authz_revoked(scope=note) closes only that document within 1 s and notifies the client", async () => {
    const noteA = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    const noteB = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    await shareNote(f.adminDb, {
      noteId: noteA,
      granteeUserId: viewer.userId,
      perm: "editor",
      createdBy: owner.userId,
    });
    await shareNote(f.adminDb, {
      noteId: noteB,
      granteeUserId: viewer.userId,
      perm: "editor",
      createdBy: owner.userId,
    });
    const socket = openSocket(h.url);
    const token = await tokenFor(viewer.userId);
    const a = track(connectClient(h.url, noteDocumentName(owner.workspaceId, noteA), token, { socket }));
    const b = track(connectClient(h.url, noteDocumentName(owner.workspaceId, noteB), token, { socket }));
    await waitFor(() => a.events.synced > 0 && b.events.synced > 0);
    expect(h.sync.registry.connectionsOf(viewer.userId, noteA).length).toBe(1);
    const revokedBefore = await counter("authzRevoked", "note");

    const t0 = Date.now();
    await f.admin.query("SELECT notify_authz_revoked($1, 'note', $2)", [viewer.userId, noteA]);
    await waitFor(
      () => h.sync.registry.connectionsOf(viewer.userId, noteA).length === 0,
      1_000,
      "document closed",
    );
    expect(Date.now() - t0).toBeLessThan(1_000);
    await waitFor(
      () =>
        a.events.stateless.some((p) => {
          const j = JSON.parse(p) as { t: string; note_id: string };
          return j.t === "authz.revoked" && j.note_id === noteA;
        }) && a.events.closes.some((c) => c.endsWith(":authz_revoked")),
      2_000,
      "client notified",
    );
    // 同一 socket 上的另一文档不受影响
    expect(h.sync.registry.connectionsOf(viewer.userId, noteB).length).toBe(1);
    expect(b.events.closes).toEqual([]);
    typeText(b.doc, "still editable");
    await waitFor(async () => (await readNote(f.admin, noteB))?.head_seq === 1);
    expect(await counter("authzRevoked", "note")).toBe(revokedBefore + 1);
    socket.destroy();
  });

  it("the periodic recheck closes a connection whose share was revoked without NOTIFY", async () => {
    const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    await shareNote(f.adminDb, {
      noteId,
      granteeUserId: viewer.userId,
      perm: "editor",
      createdBy: owner.userId,
    });
    const v = track(
      connectClient(h.url, noteDocumentName(owner.workspaceId, noteId), await tokenFor(viewer.userId)),
    );
    await waitFor(() => v.events.synced > 0);
    await f.admin.query("UPDATE shares SET revoked_at = now() WHERE note_id = $1 AND grantee_user_id = $2", [
      noteId,
      viewer.userId,
    ]);
    await waitFor(
      () => h.sync.registry.connectionsOf(viewer.userId, noteId).length === 0,
      3_000,
      "recheck kicked",
    );
    await waitFor(() => v.events.closes.some((c) => c.endsWith(":authz_revoked")), 2_000);
    // 重连后重新 Auth → forbidden（缓存已被重校验刷新，无需等 TTL）
    const again = track(
      connectClient(h.url, noteDocumentName(owner.workspaceId, noteId), await tokenFor(viewer.userId)),
    );
    await waitFor(() => again.events.authFailed.length > 0, 5_000, "forbidden after reconnect");
    expect(again.events.authFailed[0]).toBe("forbidden");
  });

  it("the periodic recheck downgrades a read-write connection whose permission dropped to viewer", async () => {
    const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    await shareNote(f.adminDb, {
      noteId,
      granteeUserId: viewer.userId,
      perm: "editor",
      createdBy: owner.userId,
    });
    const v = track(
      connectClient(h.url, noteDocumentName(owner.workspaceId, noteId), await tokenFor(viewer.userId)),
    );
    await waitFor(() => v.events.synced > 0);
    expect(v.events.authenticated).toEqual(["read-write"]);
    await f.admin.query("UPDATE shares SET perm = 'viewer' WHERE note_id = $1 AND grantee_user_id = $2", [
      noteId,
      viewer.userId,
    ]);
    await waitFor(() => v.events.closes.some((c) => c.endsWith(":downgraded")), 3_000, "downgraded");
    const again = track(
      connectClient(h.url, noteDocumentName(owner.workspaceId, noteId), await tokenFor(viewer.userId)),
    );
    await waitFor(() => again.events.authenticated.length > 0, 5_000, "readonly after reconnect");
    expect(again.events.authenticated).toEqual(["readonly"]);
  });

  it("authz_revoked with any other scope closes all of the user's sockets", async () => {
    const noteA = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    const noteB = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    const token = await tokenFor(owner.userId);
    const socket = openSocket(h.url, { maxAttempts: 1 });
    const a = track(connectClient(h.url, noteDocumentName(owner.workspaceId, noteA), token, { socket }));
    const b = track(connectClient(h.url, noteDocumentName(owner.workspaceId, noteB), token, { socket }));
    const c = track(connectClient(h.url, noteDocumentName(owner.workspaceId, noteA), token));
    await waitFor(() => a.events.synced > 0 && b.events.synced > 0 && c.events.synced > 0);
    expect(h.sync.registry.socketsOf(owner.userId).length).toBe(2);

    await f.admin.query("SELECT notify_authz_revoked($1, 'user', '*')", [owner.userId]);
    await waitFor(
      () =>
        a.events.closes.some((x) => x.startsWith("4403:")) &&
        b.events.closes.some((x) => x.startsWith("4403:")) &&
        c.events.closes.some((x) => x.startsWith("4403:")),
      2_000,
      "all sockets closed",
    );
    expect(await counter("authzRevoked", "user")).toBeGreaterThanOrEqual(1);
    socket.destroy();
  });

  it("inbox:<workspace> relays notes_changed bumps and refuses strangers", async () => {
    const ib = track(
      connectClient(h.url, inboxDocumentName(owner.workspaceId), await tokenFor(owner.userId)),
    );
    await waitFor(() => ib.events.synced > 0);
    expect(ib.events.authenticated).toEqual(["readonly"]);
    await f.admin.query("SELECT pg_notify('notes_changed', $1)", [
      JSON.stringify({ workspace_id: owner.workspaceId, note_id: uuidv7(), version: 42 }),
    ]);
    await waitFor(
      () =>
        ib.events.stateless.some((p) => {
          const j = JSON.parse(p) as { t: string; workspace_id: string; version: number };
          return j.t === "bump" && j.workspace_id === owner.workspaceId && j.version === 42;
        }),
      2_000,
      "bump received",
    );
    const s = track(
      connectClient(h.url, inboxDocumentName(owner.workspaceId), await tokenFor(stranger.userId)),
    );
    await waitFor(() => s.events.authFailed.length > 0);
    expect(s.events.authFailed[0]).toBe("forbidden");
    // inbox 从不持久化
    expect(
      (
        await f.admin.query(
          "SELECT count(*)::int AS n FROM notes WHERE workspace_id = $1 AND created_by IS NULL",
          [owner.workspaceId],
        )
      ).rows[0]?.n,
    ).toBe(0);
  });

  it("team workspaces: members with editor default may create notes; viewer default may only read", async () => {
    const editorWs = await seedTeamWorkspace(f.adminDb, {
      ownerUserId: owner.userId,
      memberUserIds: [viewer.userId],
      defaultNotePerm: "editor",
    });
    const created = uuidv7();
    const m = track(
      connectClient(h.url, noteDocumentName(editorWs.workspaceId, created), await tokenFor(viewer.userId)),
    );
    await waitFor(() => m.events.synced > 0);
    expect(m.events.authenticated).toEqual(["read-write"]);
    expect(await readNote(f.admin, created)).toMatchObject({
      created_by: viewer.userId,
      workspace_id: editorWs.workspaceId,
    });

    const viewerWs = await seedTeamWorkspace(f.adminDb, {
      ownerUserId: owner.userId,
      memberUserIds: [viewer.userId],
      defaultNotePerm: "viewer",
    });
    const denied = track(
      connectClient(h.url, noteDocumentName(viewerWs.workspaceId, uuidv7()), await tokenFor(viewer.userId)),
    );
    await waitFor(() => denied.events.authFailed.length > 0);
    expect(denied.events.authFailed[0]).toBe("forbidden");

    const existing = await seedNote(f.adminDb, { workspaceId: viewerWs.workspaceId, userId: owner.userId });
    const ro = track(
      connectClient(h.url, noteDocumentName(viewerWs.workspaceId, existing), await tokenFor(viewer.userId)),
    );
    await waitFor(() => ro.events.authenticated.length > 0);
    expect(ro.events.authenticated).toEqual(["readonly"]);
    const outsider = track(
      connectClient(h.url, noteDocumentName(viewerWs.workspaceId, existing), await tokenFor(stranger.userId)),
    );
    await waitFor(() => outsider.events.authFailed.length > 0);
    expect(outsider.events.authFailed[0]).toBe("forbidden");
  });

  it("limits a socket to 64 documents", async () => {
    const socket = openSocket(h.url);
    const token = await tokenFor(owner.userId);
    const many: Client[] = [];
    for (let i = 0; i < 64; i++) {
      many.push(
        track(connectClient(h.url, noteDocumentName(owner.workspaceId, uuidv7()), token, { socket })),
      );
    }
    // 64 次鉴权各建一行 notes，机器忙时 20 s 不够（与其它套件并行跑时出现过超时）；放宽到 60 s，
    // 第 65 个连接换新 token，避免前面耗时过长导致 60 s JWT 过期而把 too_many_documents 误判成 expired
    await waitFor(
      () => many.every((c) => c.events.authenticated.length > 0),
      60_000,
      "64 documents authenticated",
    );
    // 鉴权通过 ≠ 已登记：socket 是在 connected 里登记的（文档还要加载一会儿），
    // 认证完立刻读 sockets.size 是在赌一个时序。等它出现，断言的内容没变，只是不再假设它是瞬时的。
    await waitFor(() => h.sync.registry.sockets.size >= 1, 10_000, "socket 登记");
    const limitBefore = await counter("rejected", "limit");
    const freshToken = await tokenFor(owner.userId);
    const extra = track(
      connectClient(h.url, noteDocumentName(owner.workspaceId, uuidv7()), freshToken, { socket }),
    );
    await waitFor(() => extra.events.authFailed.length > 0, 5_000, "65th rejected");
    expect(extra.events.authFailed[0]).toBe("too_many_documents");
    expect(await counter("rejected", "limit")).toBe(limitBefore + 1);
    socket.destroy();
  });

  it("limits a user to 10 sockets by closing the oldest", async () => {
    const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    const name = noteDocumentName(owner.workspaceId, noteId);
    const token = await tokenFor(owner.userId);
    const socks: Client[] = [];
    for (let i = 0; i < 10; i++) {
      socks.push(track(connectClient(h.url, name, token, { socket: openSocket(h.url, { maxAttempts: 1 }) })));
      await waitFor(() => (socks[i] as Client).events.authenticated.length > 0, 5_000, `socket ${i}`);
    }
    expect(h.sync.registry.socketsOf(owner.userId).length).toBe(10);
    const eleventh = track(
      connectClient(h.url, name, token, { socket: openSocket(h.url, { maxAttempts: 1 }) }),
    );
    await waitFor(() => eleventh.events.authenticated.length > 0);
    await waitFor(
      () => (socks[0] as Client).events.closes.some((c) => c.startsWith("4429:")),
      3_000,
      "oldest closed",
    );
    expect((socks[1] as Client).events.closes).toEqual([]);
    await waitFor(() => h.sync.registry.socketsOf(owner.userId).length === 10, 3_000);
    for (const c of socks) c.socket.destroy();
    eleventh.socket.destroy();
  });

  it("closes the socket for frames larger than 1 MiB (too_large)", async () => {
    const ws = new WebSocket(h.url);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
      ws.send(Buffer.alloc(1024 * 1024 + 16, 1));
    });
    expect(code).toBe(1009);
  });

  it("rate-limits a flooding connection (30 msg/s, burst 60) and closes that document", async () => {
    const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    const name = noteDocumentName(owner.workspaceId, noteId);
    const c = track(connectClient(h.url, name, await tokenFor(owner.userId)));
    await waitFor(() => c.events.synced > 0);
    const rateBefore = await counter("rejected", "rate");
    const text = c.doc.getXmlFragment("body");
    for (let i = 0; i < 150; i++) {
      c.doc.transact(() => {
        const p = new Y.XmlElement("paragraph");
        p.insert(0, [new Y.XmlText(`${i}`)]);
        text.insert(text.length, [p]);
      }, "local");
    }
    await waitFor(() => c.events.closes.some((x) => x.endsWith(":rate")), 5_000, "rate close");
    expect(await counter("rejected", "rate")).toBeGreaterThan(rateBefore);
  });
});
