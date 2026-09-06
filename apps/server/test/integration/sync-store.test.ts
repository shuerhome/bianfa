// sync-ws 持久化与运维行为：doc-store 压缩数学（真实 DB）、两副本并发 onStore 的 seq 唯一、Redis 跨副本收敛、
// 服务端压缩接线、SIGTERM flush、LISTEN 断线重连后全量重校验、/healthz 503 条件。
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createDb, createPool, withUserTx } from "../../src/db/client.js";
import { uuidv7 } from "../../src/db/ids.js";
import { createLogger } from "../../src/log.js";
import {
  appendNoteUpdate,
  COMPACT_UPDATE_COUNT,
  loadNoteDoc,
  loadNoteState,
  lockNoteHead,
} from "../../src/notes/doc-store.js";
import { noteDocumentName } from "../../src/sync/auth.js";
import { createSyncServer } from "../../src/sync/server.js";
import { type Fixture, hasDb, openAdmin, seedUser, truncateAll } from "./helpers.js";
import {
  bodyText,
  type Client,
  connectClient,
  ensureProjectQueue,
  type Harness,
  httpGet,
  readNote,
  seedNote,
  shareNote,
  startSync,
  TEST_SECRET,
  tokenFor,
  typeText,
  updateRows,
  waitFor,
} from "./sync-harness.js";

type Seeded = { userId: string; workspaceId: string };

describe.skipIf(!hasDb)("sync-ws persistence and operations", () => {
  let f: Fixture;
  let owner: Seeded;
  let viewer: Seeded;
  const clients: Client[] = [];
  const harnesses: Harness[] = [];
  const track = (c: Client) => {
    clients.push(c);
    return c;
  };

  beforeAll(async () => {
    f = openAdmin();
    await truncateAll(f.admin);
    await ensureProjectQueue();
    const tag = uuidv7().slice(-8);
    owner = await seedUser(f.adminDb, `owner-${tag}`);
    viewer = await seedUser(f.adminDb, `viewer-${tag}`);
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    for (const h of harnesses.splice(0)) await h.stop();
  });

  afterAll(async () => {
    await f.admin.end();
  });

  describe("doc-store against the database", () => {
    it("assigns contiguous seqs, keeps crdt_sv, and compacts at 200 updates", async () => {
      const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
      const doc = new Y.Doc({ gc: true });
      let lastSv = Y.encodeStateVector(doc);
      let lastState: Uint8Array | null = null;
      for (let i = 1; i <= COMPACT_UPDATE_COUNT; i++) {
        typeText(doc, `行 ${i}`);
        const diff = Y.encodeStateAsUpdateV2(doc, lastSv);
        lastSv = Y.encodeStateVector(doc);
        lastState = Y.encodeStateAsUpdateV2(doc);
        const result = await withUserTx(
          owner.userId,
          (tx) =>
            appendNoteUpdate(tx, {
              noteId,
              updateV2: diff,
              authorId: owner.userId,
              deviceId: null,
              fullStateV2: lastState,
            }),
          f.adminDb,
        );
        expect(result.seq).toBe(i);
        expect(result.compacted).toBe(i === COMPACT_UPDATE_COUNT);
      }
      const snaps = await f.admin.query<{ upto_seq: number; byte_size: number }>(
        "SELECT upto_seq::int AS upto_seq, byte_size FROM note_snapshots WHERE note_id = $1",
        [noteId],
      );
      expect(snaps.rows).toEqual([
        { upto_seq: COMPACT_UPDATE_COUNT, byte_size: (lastState as Uint8Array).byteLength },
      ]);
      expect(await updateRows(f.admin, noteId)).toEqual([]);
      const head = await withUserTx(owner.userId, (tx) => lockNoteHead(tx, noteId), f.adminDb);
      expect(head?.headSeq).toBe(COMPACT_UPDATE_COUNT);
      expect(Buffer.from(head?.crdtSv as Uint8Array).equals(Buffer.from(lastSv))).toBe(true);
      expect(head?.crdtBytes).toBe((lastState as Uint8Array).byteLength);

      // 快照 == 完整状态；再追加一条后 load = 快照 + update
      const state = await withUserTx(owner.userId, (tx) => loadNoteState(tx, noteId), f.adminDb);
      expect(state.headSeq).toBe(COMPACT_UPDATE_COUNT);
      expect(Buffer.from(state.stateV2 as Uint8Array).equals(Buffer.from(lastState as Uint8Array))).toBe(
        true,
      );
      typeText(doc, "after snapshot");
      const diff = Y.encodeStateAsUpdateV2(doc, lastSv);
      await withUserTx(
        owner.userId,
        (tx) =>
          appendNoteUpdate(tx, {
            noteId,
            updateV2: diff,
            authorId: owner.userId,
            deviceId: null,
            fullStateV2: Y.encodeStateAsUpdateV2(doc),
          }),
        f.adminDb,
      );
      expect((await updateRows(f.admin, noteId)).map((r) => r.seq)).toEqual([COMPACT_UPDATE_COUNT + 1]);
      const loaded = await withUserTx(owner.userId, (tx) => loadNoteDoc(tx, noteId), f.adminDb);
      expect(loaded.headSeq).toBe(COMPACT_UPDATE_COUNT + 1);
      expect(bodyText(loaded.doc)).toBe(bodyText(doc));
      loaded.doc.destroy();
      doc.destroy();
    });

    it("compacts on the byte threshold too", async () => {
      const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
      const doc = new Y.Doc({ gc: true });
      let sv = Y.encodeStateVector(doc);
      let compactedAt = 0;
      for (let i = 1; i <= 10; i++) {
        typeText(doc, "x".repeat(300));
        const diff = Y.encodeStateAsUpdateV2(doc, sv);
        sv = Y.encodeStateVector(doc);
        const r = await withUserTx(
          owner.userId,
          (tx) =>
            appendNoteUpdate(tx, {
              noteId,
              updateV2: diff,
              authorId: owner.userId,
              deviceId: null,
              fullStateV2: Y.encodeStateAsUpdateV2(doc),
              thresholds: { bytes: 1_000 },
            }),
          f.adminDb,
        );
        if (r.compacted && compactedAt === 0) compactedAt = i;
      }
      expect(compactedAt).toBeGreaterThan(1);
      expect(compactedAt).toBeLessThanOrEqual(4);
      doc.destroy();
    });
  });

  it("two server instances storing the same note concurrently get unique seqs and lose nothing", async () => {
    const h1 = await startSync();
    const h2 = await startSync();
    harnesses.push(h1, h2);
    const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    const name = noteDocumentName(owner.workspaceId, noteId);
    const c1 = track(connectClient(h1.url, name, await tokenFor(owner.userId)));
    const c2 = track(connectClient(h2.url, name, await tokenFor(owner.userId)));
    await waitFor(() => c1.events.synced > 0 && c2.events.synced > 0);
    typeText(c1.doc, "replica one");
    typeText(c2.doc, "replica two");
    await waitFor(async () => (await readNote(f.admin, noteId))?.head_seq === 2, 5_000, "both stored");
    expect((await updateRows(f.admin, noteId)).map((r) => r.seq)).toEqual([1, 2]);
    const { doc } = await withUserTx(owner.userId, (tx) => loadNoteDoc(tx, noteId), f.adminDb);
    expect(bodyText(doc)).toContain("replica one");
    expect(bodyText(doc)).toContain("replica two");
    doc.destroy();
    expect((await h1.sync.metrics.storeFailures.get()).values[0]?.value ?? 0).toBe(0);
    expect((await h2.sync.metrics.storeFailures.get()).values[0]?.value ?? 0).toBe(0);
  });

  describe.skipIf(!process.env.REDIS_URL)("with extension-redis", () => {
    it("two instances relay updates through Redis and both persist", async () => {
      const prefix = `bianfa:sync:test:${uuidv7().slice(-8)}`;
      const url = process.env.REDIS_URL as string;
      const h1 = await startSync({ redis: { url, identifier: "instance-a", prefix } });
      const h2 = await startSync({ redis: { url, identifier: "instance-b", prefix } });
      harnesses.push(h1, h2);
      const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
      await shareNote(f.adminDb, {
        noteId,
        granteeUserId: viewer.userId,
        perm: "editor",
        createdBy: owner.userId,
      });
      const name = noteDocumentName(owner.workspaceId, noteId);
      const c1 = track(connectClient(h1.url, name, await tokenFor(owner.userId)));
      const c2 = track(connectClient(h2.url, name, await tokenFor(viewer.userId)));
      await waitFor(() => c1.events.synced > 0 && c2.events.synced > 0);
      typeText(c1.doc, "via redis");
      await waitFor(() => bodyText(c2.doc).includes("via redis"), 5_000, "relayed");
      typeText(c2.doc, "back again");
      await waitFor(() => bodyText(c1.doc).includes("back again"), 5_000, "relayed back");
      // 两副本各自 debounce；先落盘的副本可能已经包含经 Redis 收到的对方编辑（一条 update 覆盖两次编辑），
      // 后者在 FOR UPDATE 之后按 crdt_sv 求差为空 —— 所以判据是存储里的内容，而不是 head_seq 的具体值。
      const reload = async () => {
        const { doc } = await withUserTx(owner.userId, (tx) => loadNoteDoc(tx, noteId), f.adminDb);
        const text = bodyText(doc);
        doc.destroy();
        return text;
      };
      await waitFor(
        async () => {
          const text = await reload();
          return text.includes("via redis") && text.includes("back again");
        },
        5_000,
        "both edits persisted",
      );
      expect(await reload()).toBe(bodyText(c1.doc));
      const seqs = (await updateRows(f.admin, noteId)).map((r) => r.seq);
      expect(seqs.length).toBeGreaterThanOrEqual(1);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect((await readNote(f.admin, noteId))?.head_seq).toBe(seqs[seqs.length - 1]);
      expect((await h1.sync.metrics.storeFailures.get()).values[0]?.value ?? 0).toBe(0);
      expect((await h2.sync.metrics.storeFailures.get()).values[0]?.value ?? 0).toBe(0);
      const hz = await httpGet(h1.port, "/healthz");
      expect(hz.status).toBe(200);
      expect(JSON.parse(hz.body).checks.redis).toBe(true);
    });
  });

  it("wires compaction thresholds through onStoreDocument", async () => {
    const h = await startSync({ compaction: { updates: 3 } });
    harnesses.push(h);
    const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    const c = track(
      connectClient(h.url, noteDocumentName(owner.workspaceId, noteId), await tokenFor(owner.userId)),
    );
    await waitFor(() => c.events.synced > 0);
    for (let i = 1; i <= 4; i++) {
      typeText(c.doc, `edit ${i}`);
      await waitFor(async () => (await readNote(f.admin, noteId))?.head_seq === i, 5_000, `seq ${i}`);
    }
    const snaps = await f.admin.query<{ upto_seq: number }>(
      "SELECT upto_seq::int AS upto_seq FROM note_snapshots WHERE note_id = $1",
      [noteId],
    );
    expect(snaps.rows).toEqual([{ upto_seq: 3 }]);
    expect((await updateRows(f.admin, noteId)).map((r) => r.seq)).toEqual([4]);
    const { doc } = await withUserTx(owner.userId, (tx) => loadNoteDoc(tx, noteId), f.adminDb);
    expect(bodyText(doc)).toBe(bodyText(c.doc));
    doc.destroy();
  });

  it("shutdown flushes debounced stores before exiting (SIGTERM path)", async () => {
    const h = await startSync({ debounce: 5_000, maxDebounce: 10_000 });
    const noteId = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    const name = noteDocumentName(owner.workspaceId, noteId);
    const c = track(connectClient(h.url, name, await tokenFor(owner.userId)));
    await waitFor(() => c.events.synced > 0);
    typeText(c.doc, "flushed on shutdown");
    await waitFor(() => {
      const d = h.sync.hocuspocus.documents.get(name);
      return Boolean(d && bodyText(d).includes("flushed on shutdown"));
    });
    expect((await readNote(f.admin, noteId))?.head_seq).toBe(0);
    c.destroy();
    clients.length = 0;
    const t0 = Date.now();
    await h.sync.shutdown({ timeoutMs: 10_000 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect((await readNote(f.admin, noteId))?.head_seq).toBe(1);
    expect(h.sync.hocuspocus.getDocumentsCount()).toBe(0);
    expect((await h.sync.health()).checks.stopping).toBe(true);
    await h.pool.end();
  });

  it("reconnects the LISTEN connection after pg_terminate_backend and runs a full recheck", async () => {
    const h = await startSync({
      listenReconnectBaseMs: 400, // 掉线窗口须长于 revocation 的 100 ms 轮询，测试才能观察到 down
      listenReconnectMaxMs: 800,
      recheckIntervalMs: 600_000, // 只有重连触发的重校验能解释踢人
    });
    harnesses.push(h);
    const up = async () => (await h.sync.metrics.listenUp.get()).values[0]?.value === 1;
    await waitFor(up, 5_000, "listen up");
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

    const pids = await f.admin.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE 'LISTEN %' AND pid <> pg_backend_pid()",
    );
    expect(pids.rows.length).toBeGreaterThanOrEqual(1);
    for (const { pid } of pids.rows) await f.admin.query("SELECT pg_terminate_backend($1)", [pid]);
    await waitFor(async () => !(await up()), 5_000, "listen down");
    // 断线期间撤销共享（NOTIFY 丢失）
    await f.admin.query("UPDATE shares SET revoked_at = now() WHERE note_id = $1 AND grantee_user_id = $2", [
      noteId,
      viewer.userId,
    ]);
    await waitFor(up, 10_000, "listen back up");
    await waitFor(
      () => h.sync.registry.connectionsOf(viewer.userId, noteId).length === 0,
      3_000,
      "kicked by recheck",
    );
    expect((await h.sync.health()).ok).toBe(true);
    // 重连后 NOTIFY 通道照常
    const noteB = await seedNote(f.adminDb, { workspaceId: owner.workspaceId, userId: owner.userId });
    await shareNote(f.adminDb, {
      noteId: noteB,
      granteeUserId: viewer.userId,
      perm: "editor",
      createdBy: owner.userId,
    });
    const w = track(
      connectClient(h.url, noteDocumentName(owner.workspaceId, noteB), await tokenFor(viewer.userId)),
    );
    await waitFor(() => w.events.synced > 0);
    await f.admin.query("SELECT notify_authz_revoked($1, 'note', $2)", [viewer.userId, noteB]);
    await waitFor(
      () => h.sync.registry.connectionsOf(viewer.userId, noteB).length === 0,
      1_000,
      "notify after reconnect",
    );
  });

  it("/healthz is 503 when the database is unreachable", async () => {
    const badPool = createPool("postgres://postgres@127.0.0.1:1/nope", {
      max: 1,
      connectionTimeoutMillis: 300,
    });
    const sync = createSyncServer({
      port: 0,
      address: "127.0.0.1",
      pool: badPool,
      db: createDb(badPool),
      tokenSecret: TEST_SECRET,
      logger: createLogger({ name: "sync-test" }, "silent"),
    });
    const { port } = await sync.listen();
    try {
      const hz = await httpGet(port, "/healthz");
      expect(hz.status).toBe(503);
      expect(JSON.parse(hz.body)).toMatchObject({ ok: false, checks: { db: false } });
      // 直连缺失 → LISTEN 关闭但不影响健康判定的其它项
      expect((await sync.health()).listen.enabled).toBe(false);
    } finally {
      await sync.shutdown({ timeoutMs: 2_000 });
      await badPool.end();
    }
  });
});
