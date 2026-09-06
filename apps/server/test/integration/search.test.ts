// 服务端中文检索（第 1 章 C6）：pg_bigm GIN 索引存在，content_text LIKE likequery($1) 走通。
import { and, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../../src/db/client.js";
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
      {
        id: hit,
        workspaceId: ws.workspaceId,
        createdBy: ws.userId,
        contentText: "今天要买的东西：便笺纸、胶带 100%",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: miss,
        workspaceId: ws.workspaceId,
        createdBy: ws.userId,
        contentText: "会议纪要：下周排期",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: deleted,
        workspaceId: ws.workspaceId,
        createdBy: ws.userId,
        contentText: "已删除的便笺",
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
      },
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
    expect(r.rows[0]?.indexdef).toMatch(
      /USING gin \(content_text gin_bigm_ops\) WHERE \(deleted_at IS NULL\)/,
    );
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

  it("GIN 索引能承接这条查询：临时去掉另一张部分索引（事务内 DROP INDEX 再 ROLLBACK）后计划走 notes_content_bigm_idx", async () => {
    // 规格只要求"走通"，EXPLAIN 不强制；小表上规划器会偏好 notes_list_idx（同样是 deleted_at IS NULL 的部分索引），
    // 所以这里在一个会回滚的事务里把它拿掉，只剩 GIN 索引可选，断言计划确实用到了它。DDL 在 PG 里是事务性的。
    const c = await f.admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL enable_seqscan = off");
      await c.query("DROP INDEX notes_list_idx");
      const r = await c.query<{ "QUERY PLAN": string }>(
        "EXPLAIN (COSTS OFF) SELECT id FROM notes WHERE content_text LIKE likequery('便笺') AND deleted_at IS NULL",
      );
      await c.query("ROLLBACK");
      expect(r.rows.map((row) => row["QUERY PLAN"]).join("\n")).toMatch(
        /Bitmap Index Scan on notes_content_bigm_idx/,
      );
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
    const stillThere = await f.admin.query("SELECT to_regclass('public.notes_list_idx') IS NOT NULL AS ok");
    expect(stillThere.rows[0]?.ok).toBe(true);
  });
});
