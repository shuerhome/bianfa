// RLS 活性（规格 01 §11-8 / 规格 02 §1.8）：用 NOSUPERUSER NOBYPASSRLS 的非 owner 角色 bianfa_rls_test（成员于 bianfa_app）连接。
import { and, eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, createPool, type Db, withUserTx, withWorkerTx } from "../../src/db/client.js";
import { uuidv7 } from "../../src/db/ids.js";
import { notePins, notes, noteUpdates, shares, workspaces } from "../../src/db/schema/index.js";
import {
  DIRECT_URL,
  ensureTestRoles,
  expectRlsViolation,
  type Fixture,
  hasDb,
  openAdmin,
  RLS_PASSWORD,
  RLS_ROLE,
  seedUser,
  truncateAll,
  WORKER_PASSWORD,
  WORKER_ROLE,
  withCredentials,
} from "./helpers.js";

describe.skipIf(!hasDb)("RLS（bianfa_app 成员角色，非 owner，NOBYPASSRLS）", () => {
  let f: Fixture;
  let rlsPool: pg.Pool;
  let rlsDb: Db;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let ua: { userId: string; workspaceId: string };
  let ub: { userId: string; workspaceId: string };
  const noteA1 = uuidv7();
  const noteB1 = uuidv7(); // 共享给 A
  const noteB2 = uuidv7(); // 不共享
  let shareId: string;

  beforeAll(async () => {
    f = openAdmin();
    await ensureTestRoles(f.admin);
    await truncateAll(f.admin);
    ua = await seedUser(f.adminDb, "user_a");
    ub = await seedUser(f.adminDb, "user_b");
    const now = new Date();
    await f.adminDb.insert(notes).values([
      {
        id: noteA1,
        workspaceId: ua.workspaceId,
        createdBy: ua.userId,
        contentText: "A1",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: noteB1,
        workspaceId: ub.workspaceId,
        createdBy: ub.userId,
        contentText: "B1",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: noteB2,
        workspaceId: ub.workspaceId,
        createdBy: ub.userId,
        contentText: "B2",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    shareId = uuidv7();
    await f.adminDb.insert(shares).values({
      id: shareId,
      noteId: noteB1,
      granteeKind: "user",
      granteeUserId: ua.userId,
      perm: "viewer",
      createdBy: ub.userId,
    });
    rlsPool = createPool(withCredentials(DIRECT_URL as string, RLS_ROLE, RLS_PASSWORD), { max: 2 });
    rlsDb = createDb(rlsPool);
    workerPool = createPool(withCredentials(DIRECT_URL as string, WORKER_ROLE, WORKER_PASSWORD), { max: 1 });
    workerDb = createDb(workerPool);
  });

  afterAll(async () => {
    await rlsPool?.end();
    await workerPool?.end();
    await truncateAll(f.admin);
    await f.admin.end();
    await closeDb();
  });

  it("裸连接（不带 SET LOCAL）SELECT * FROM notes 返回 0 行；其它 RLS 表同样为 0（fail-closed）", async () => {
    for (const table of ["notes", "workspaces", "shares", "note_updates", "note_pins", "attachments"]) {
      const r = await rlsPool.query(`SELECT * FROM ${table}`);
      expect(r.rows, table).toHaveLength(0);
    }
    // 超级用户视角确认数据确实存在
    const all = await f.admin.query("SELECT count(*)::int AS n FROM notes");
    expect(all.rows[0]?.n).toBe(3);
  });

  it("withUserTx：只看到自己 workspace 的便笺 + 共享给自己的便笺；看不到别人的", async () => {
    const seenByA = await withUserTx(ua.userId, (tx) => tx.select({ id: notes.id }).from(notes), rlsDb);
    expect(seenByA.map((r) => r.id).sort()).toEqual([noteA1, noteB1].sort());
    const seenByB = await withUserTx(ub.userId, (tx) => tx.select({ id: notes.id }).from(notes), rlsDb);
    expect(seenByB.map((r) => r.id).sort()).toEqual([noteB1, noteB2].sort());

    const wsA = await withUserTx(ua.userId, (tx) => tx.select({ id: workspaces.id }).from(workspaces), rlsDb);
    expect(wsA.map((r) => r.id)).toEqual([ua.workspaceId]);
  });

  it("同一连接：事务结束后 GUC 失效，下一条裸查询又是 0 行（NULLIF 处理空串）", async () => {
    const pool1 = createPool(withCredentials(DIRECT_URL as string, RLS_ROLE, RLS_PASSWORD), { max: 1 });
    try {
      const db1 = createDb(pool1);
      const inTx = await withUserTx(ua.userId, (tx) => tx.select({ id: notes.id }).from(notes), db1);
      expect(inTx.length).toBeGreaterThan(0);
      const guc = await pool1.query("SELECT current_setting('app.user_id', true) AS v");
      expect(guc.rows[0]?.v).toBe(""); // 设置过又释放 → 空串，而不是 NULL
      const after = await pool1.query("SELECT id FROM notes");
      expect(after.rows).toHaveLength(0);
    } finally {
      await pool1.end();
    }
  });

  it("插入 note_updates 受 notes 可见性约束：自己的 / 共享给自己的可以写，不可见的便笺被 RLS 拒绝", async () => {
    const seq = await withUserTx(
      ua.userId,
      (tx) =>
        tx
          .insert(noteUpdates)
          .values({ noteId: noteA1, seq: 1, updateV2: Buffer.from([0, 0]), authorId: ua.userId })
          .returning({ seq: noteUpdates.seq, lsn: noteUpdates.lsn }),
      rlsDb,
    );
    expect(seq[0]?.seq).toBe(1);
    expect(seq[0]?.lsn).toEqual(expect.any(Number));

    // 共享（viewer）在 RLS 层是"可见"——viewer/editor 的区分是应用层 authorize() 的职责，不是 RLS 的
    await expect(
      withUserTx(
        ua.userId,
        (tx) => tx.insert(noteUpdates).values({ noteId: noteB1, seq: 1, updateV2: Buffer.from([0]) }),
        rlsDb,
      ),
    ).resolves.toBeDefined();

    await expectRlsViolation(
      withUserTx(
        ua.userId,
        (tx) => tx.insert(noteUpdates).values({ noteId: noteB2, seq: 1, updateV2: Buffer.from([0]) }),
        rlsDb,
      ),
    );

    // 往别人的 workspace 里建便笺同样被拒
    const now = new Date();
    await expectRlsViolation(
      withUserTx(
        ua.userId,
        (tx) =>
          tx.insert(notes).values({
            id: uuidv7(),
            workspaceId: ub.workspaceId,
            createdBy: ua.userId,
            createdAt: now,
            updatedAt: now,
          }),
        rlsDb,
      ),
    );
  });

  it("共享撤销 / 过期后立即不可见", async () => {
    await f.adminDb.update(shares).set({ revokedAt: new Date() }).where(eq(shares.id, shareId));
    let seen = await withUserTx(ua.userId, (tx) => tx.select({ id: notes.id }).from(notes), rlsDb);
    expect(seen.map((r) => r.id)).toEqual([noteA1]);

    await f.adminDb
      .update(shares)
      .set({ revokedAt: null, expiresAt: new Date(Date.now() - 1000) })
      .where(eq(shares.id, shareId));
    seen = await withUserTx(ua.userId, (tx) => tx.select({ id: notes.id }).from(notes), rlsDb);
    expect(seen.map((r) => r.id)).toEqual([noteA1]);

    await f.adminDb.update(shares).set({ expiresAt: null }).where(eq(shares.id, shareId));
    seen = await withUserTx(ua.userId, (tx) => tx.select({ id: notes.id }).from(notes), rlsDb);
    expect(seen.map((r) => r.id).sort()).toEqual([noteA1, noteB1].sort());
  });

  it("note_pins：只能钉自己可见的便笺，且只看到自己的钉放", async () => {
    await withUserTx(
      ua.userId,
      (tx) => tx.insert(notePins).values({ userId: ua.userId, noteId: noteA1 }),
      rlsDb,
    );
    await expectRlsViolation(
      withUserTx(ua.userId, (tx) => tx.insert(notePins).values({ userId: ua.userId, noteId: noteB2 }), rlsDb),
    );
    await expectRlsViolation(
      withUserTx(ua.userId, (tx) => tx.insert(notePins).values({ userId: ub.userId, noteId: noteA1 }), rlsDb),
    );
    const pinsB = await withUserTx(ub.userId, (tx) => tx.select().from(notePins), rlsDb);
    expect(pinsB).toHaveLength(0);
    const pinsA = await withUserTx(
      ua.userId,
      (tx) =>
        tx
          .select({ noteId: notePins.noteId })
          .from(notePins)
          .where(and(eq(notePins.userId, ua.userId), eq(notePins.noteId, noteA1))),
      rlsDb,
    );
    expect(pinsA).toHaveLength(1);
  });

  it("withUserTx 拒绝空 userId", async () => {
    await expect(withUserTx("", async () => 1, rlsDb)).rejects.toThrow(TypeError);
  });

  it("worker 角色（BYPASSRLS）不设 GUC 即可看到全部行：withWorkerTx", async () => {
    const all = await withWorkerTx((tx) => tx.select({ id: notes.id }).from(notes), workerDb);
    expect(all).toHaveLength(3);
    const raw = await workerPool.query("SELECT count(*)::int AS n FROM shares");
    expect(raw.rows[0]?.n).toBe(1);
  });
});
