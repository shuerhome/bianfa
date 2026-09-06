// 服务端中文检索（第 1 章 C6）：pg_bigm GIN 索引存在，content_text LIKE likequery($1) 走通。
import { and, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb, withWorkerTx } from "../../src/db/client.js";
import { uuidv7 } from "../../src/db/ids.js";
import { notes } from "../../src/db/schema/index.js";
import { type Fixture, hasDb, openAdmin, seedUser, truncateAll } from "./helpers.js";

describe.skipIf(!hasDb)("pg_bigm 检索", () => {
  let f: Fixture;
  let ws: { userId: string; workspaceId: string };
  const hit = uuidv7();
  const miss = uuidv7();
  const deleted = uuidv7();

  beforeAll(async () => {
    f = openAdmin();
    await truncateAll(f.admin);
    ws = await seedUser(f.adminDb, "user_search");
    const now = new Date();
    await f.adminDb.insert(notes).values([
      { id: hit, workspaceId: ws.workspaceId, createdBy: ws.userId, contentText: "今天要买的东西：便笺纸、胶带 100%", createdAt: now, updatedAt: now },
      { id: miss, workspaceId: ws.workspaceId, createdBy: ws.userId, contentText: "会议纪要：下周排期", createdAt: now, updatedAt: now },
      { id: deleted, workspaceId: ws.workspaceId, createdBy: ws.userId, contentText: "已删除的便笺", createdAt: now, updatedAt: now, deletedAt: now },
    ]);
  });

  afterAll(async () => {
    await truncateAll(f.admin);
    await f.admin.end();
    await closeDb();
  });

  it("notes_content_bigm_idx 是 gin (content_text gin_bigm_ops) 的部分索引", async () => {
    const r = await f.admin.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'notes' AND indexname = 'notes_content_bigm_idx'",
    );
    expect(r.rows[0]?.indexdef).toMatch(/USING gin \(content_text gin_bigm_ops\) WHERE \(deleted_at IS NULL\)/);
  });

  it("content_text LIKE likequery($1)：命中 2 字中文词，排除未命中与已删除", async () => {
    const q = (term: string) =>
      getDb()
        .select({ id: notes.id })
        .from(notes)
        .where(and(sql`${notes.contentText} LIKE likequery(${term})`, isNull(notes.deletedAt)));
    expect((await q("便笺")).map((r) => r.id)).toEqual([hit]);
    expect((await q("排期")).map((r) => r.id)).toEqual([miss]);
    expect(await q("不存在的词")).toEqual([]);
    // likequery 会转义 % _ \，所以用户输入的 "100%" 不会变成通配
    expect((await q("100%")).map((r) => r.id)).toEqual([hit]);
    expect(await q("100_")).toEqual([]);
  });

  it("关掉顺序扫描与 btree 索引扫描后，计划走 notes_content_bigm_idx 的 Bitmap Index Scan", async () => {
    const plan = await withWorkerTx(async (tx) => {
      // SET LOCAL：事务内生效，与 PgBouncer transaction 模式相容
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      await tx.execute(sql`SET LOCAL enable_indexscan = off`);
      await tx.execute(sql`SET LOCAL enable_indexonlyscan = off`);
      const rows = await tx.execute<{ "QUERY PLAN": string }>(
        sql`EXPLAIN (COSTS OFF) SELECT id FROM notes WHERE content_text LIKE likequery('便笺') AND deleted_at IS NULL`,
      );
      return rows.rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toMatch(/Bitmap Index Scan on notes_content_bigm_idx/);
  });
});
