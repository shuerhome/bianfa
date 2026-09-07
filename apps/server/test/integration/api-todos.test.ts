// 团队待办（GET /v1/todos、GET /v1/todos/summary）：可见性（陌生人 404 / 成员 200）、排除软删与归档、
// include_done、created_by、keyset 分页（游标往返无重复无遗漏）、汇总按成员分组。
// checklist_items 直接插行（投影 job 的写法见 api-worker.test.ts；这里只测读路径）。
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, call, seedNote, seedOrg, seedUserV7, type TestApp } from "./api-helpers.js";
import { type Fixture, hasDb, openAdmin, truncateAll } from "./helpers.js";

interface TodoItem {
  note_id: string;
  note_title: string;
  note_color: string;
  workspace_id: string;
  created_by: string;
  block_id: string;
  text: string;
  checked: boolean;
  ordinal: number;
  note_updated_at: string;
}
interface Page {
  items: TodoItem[];
  next_cursor: string | null;
  has_more: boolean;
}
interface Summary {
  open: number;
  done: number;
  by_member: { user_id: string; name: string | null; open: number; done: number }[];
}
interface ErrBody {
  error: string;
  issues?: { path: string }[];
}

describe.skipIf(!hasDb)("todos", () => {
  let f: Fixture;
  let t: TestApp;
  let me: { userId: string; workspaceId: string };
  let other: { userId: string; workspaceId: string };
  let stranger: { userId: string; workspaceId: string };
  let org: { orgId: string; workspaceId: string };
  /** A：me 建，较旧；B：other 建，较新；C：me 建但已软删；D：other 建但已归档；P：me 个人区 */
  let noteA: string;
  let noteB: string;

  async function setNote(
    id: string,
    patch: { updatedAt: string; color: string; deleted?: boolean; archived?: boolean },
  ) {
    await t.db.execute(
      sql`UPDATE notes SET updated_at = ${patch.updatedAt}::timestamptz, color = ${patch.color},
                 deleted_at = CASE WHEN ${patch.deleted ?? false} THEN now() ELSE NULL END,
                 archived_at = CASE WHEN ${patch.archived ?? false} THEN now() ELSE NULL END
           WHERE id = ${id}::uuid`,
    );
  }

  async function addItems(noteId: string, items: [blockId: string, text: string, checked: boolean][]) {
    for (const [i, [blockId, text, checked]] of items.entries()) {
      await t.db.execute(
        sql`INSERT INTO checklist_items (note_id, block_id, text, checked, ordinal)
            VALUES (${noteId}::uuid, ${blockId}, ${text}, ${checked}, ${i})`,
      );
    }
  }

  beforeAll(async () => {
    f = openAdmin();
    await truncateAll(f.admin);
    t = buildTestApp();
    me = await seedUserV7(t.db, "me");
    other = await seedUserV7(t.db, "other");
    stranger = await seedUserV7(t.db, "stranger");
    org = await seedOrg(t.db, "org", [
      { userId: me.userId, role: "owner" },
      { userId: other.userId, role: "member" },
    ]);

    noteA = await seedNote(t.db, org.workspaceId, me.userId, "发布清单\n正文");
    await setNote(noteA, { updatedAt: "2026-09-01T10:00:00Z", color: "teal" });
    await addItems(noteA, [
      ["aaaaaaaaaa", "确认色板", false],
      ["aaaaaaaaab", "补 macOS 验证", true],
      ["aaaaaaaaac", "写发布说明", false],
    ]);

    noteB = await seedNote(t.db, org.workspaceId, other.userId, "评审\n");
    await setNote(noteB, { updatedAt: "2026-09-02T10:00:00Z", color: "amber" });
    await addItems(noteB, [
      ["bbbbbbbbba", "整理问题清单", true],
      ["bbbbbbbbbb", "约时间", false],
    ]);

    const noteC = await seedNote(t.db, org.workspaceId, me.userId, "已删\n");
    await setNote(noteC, { updatedAt: "2026-09-03T10:00:00Z", color: "rose", deleted: true });
    await addItems(noteC, [["cccccccccc", "不该出现（软删）", false]]);

    const noteD = await seedNote(t.db, org.workspaceId, other.userId, "已归档\n");
    await setNote(noteD, { updatedAt: "2026-09-04T10:00:00Z", color: "rose", archived: true });
    await addItems(noteD, [["dddddddddd", "不该出现（归档）", false]]);

    const noteP = await seedNote(t.db, me.workspaceId, me.userId, "个人\n");
    await addItems(noteP, [["pppppppppp", "不该出现（别的工作区）", false]]);
  });

  afterAll(async () => {
    await t.close();
    await truncateAll(f.admin);
    await f.admin.end();
  });

  it("校验与可见性：缺 workspace_id 400；陌生人 404；普通成员 200", async () => {
    const bad = await call<ErrBody>(t, "GET", "/v1/todos", { as: me.userId });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("validation_error");

    const denied = await call<ErrBody>(t, "GET", `/v1/todos?workspace_id=${org.workspaceId}`, {
      as: stranger.userId,
    });
    expect(denied.status).toBe(404);
    expect(denied.body.error).toBe("not_found");

    const asMember = await call<Page>(t, "GET", `/v1/todos?workspace_id=${org.workspaceId}`, {
      as: other.userId,
    });
    expect(asMember.status).toBe(200);
    expect(asMember.body.items.length).toBe(3);

    const anon = await call<ErrBody>(t, "GET", `/v1/todos?workspace_id=${org.workspaceId}`);
    expect(anon.status).toBe(401);
  });

  it("默认只返回未完成项：按 notes.updated_at 倒序、便笺内按 ordinal；排除软删 / 归档 / 别的工作区", async () => {
    const r = await call<Page>(t, "GET", `/v1/todos?workspace_id=${org.workspaceId}`, { as: me.userId });
    expect(r.status).toBe(200);
    expect(r.body.items.map((i) => i.block_id)).toEqual(["bbbbbbbbbb", "aaaaaaaaaa", "aaaaaaaaac"]);
    expect(r.body.items.every((i) => i.checked === false)).toBe(true);
    expect(r.body.has_more).toBe(false);
    expect(r.body.next_cursor).toBeNull();
    expect(r.body.items[0]).toEqual({
      note_id: noteB,
      note_title: "评审",
      note_color: "amber",
      workspace_id: org.workspaceId,
      created_by: other.userId,
      block_id: "bbbbbbbbbb",
      text: "约时间",
      checked: false,
      ordinal: 1,
      note_updated_at: "2026-09-02T10:00:00.000Z",
    });
    expect((r.body as unknown as { server_time: number }).server_time).toBeTypeOf("number");
  });

  it("include_done=true：未完成在前、已完成在后，各自再按 updated_at 倒序", async () => {
    const r = await call<Page>(t, "GET", `/v1/todos?workspace_id=${org.workspaceId}&include_done=true`, {
      as: me.userId,
    });
    expect(r.status).toBe(200);
    expect(r.body.items.map((i) => i.block_id)).toEqual([
      "bbbbbbbbbb",
      "aaaaaaaaaa",
      "aaaaaaaaac",
      "bbbbbbbbba",
      "aaaaaaaaab",
    ]);
    expect(r.body.items.map((i) => i.checked)).toEqual([false, false, false, true, true]);

    const junk = await call<ErrBody>(t, "GET", `/v1/todos?workspace_id=${org.workspaceId}&include_done=yes`, {
      as: me.userId,
    });
    expect(junk.status).toBe(400);
  });

  it("created_by 只看某个成员建的便笺", async () => {
    const mine = await call<Page>(
      t,
      "GET",
      `/v1/todos?workspace_id=${org.workspaceId}&created_by=${me.userId}&include_done=true`,
      { as: other.userId },
    );
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((i) => i.block_id)).toEqual(["aaaaaaaaaa", "aaaaaaaaac", "aaaaaaaaab"]);
    expect(mine.body.items.every((i) => i.created_by === me.userId && i.note_id === noteA)).toBe(true);

    const theirsOpen = await call<Page>(
      t,
      "GET",
      `/v1/todos?workspace_id=${org.workspaceId}&created_by=${other.userId}`,
      { as: me.userId },
    );
    expect(theirsOpen.body.items.map((i) => i.block_id)).toEqual(["bbbbbbbbbb"]);

    const nobody = await call<Page>(
      t,
      "GET",
      `/v1/todos?workspace_id=${org.workspaceId}&created_by=${stranger.userId}`,
      { as: me.userId },
    );
    expect(nobody.body.items).toEqual([]);
  });

  it("分页：limit=2 游标翻页，跨便笺 / 跨 checked 边界不重不漏；坏游标 400", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/v1/todos?workspace_id=${org.workspaceId}&include_done=true&limit=2${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;
      const r: { status: number; body: Page } = await call<Page>(t, "GET", url, { as: me.userId });
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeLessThanOrEqual(2);
      seen.push(...r.body.items.map((i) => i.block_id));
      cursor = r.body.next_cursor;
      pages++;
      if (r.body.has_more) expect(cursor).toBeTypeOf("string");
      else expect(cursor).toBeNull();
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(["bbbbbbbbbb", "aaaaaaaaaa", "aaaaaaaaac", "bbbbbbbbba", "aaaaaaaaab"]);

    const bad = await call<ErrBody>(t, "GET", `/v1/todos?workspace_id=${org.workspaceId}&cursor=%21%21%21`, {
      as: me.userId,
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("validation_error");
    expect(bad.body.issues?.[0]?.path).toBe("cursor");

    const tooBig = await call<ErrBody>(t, "GET", `/v1/todos?workspace_id=${org.workspaceId}&limit=501`, {
      as: me.userId,
    });
    expect(tooBig.status).toBe(400);
  });

  it("summary：open/done 总数与按成员分组（名字来自 user）；陌生人 404", async () => {
    const r = await call<Summary>(t, "GET", `/v1/todos/summary?workspace_id=${org.workspaceId}`, {
      as: other.userId,
    });
    expect(r.status).toBe(200);
    expect(r.body.open).toBe(3);
    expect(r.body.done).toBe(2);
    expect(r.body.by_member).toEqual([
      { user_id: me.userId, name: "me", open: 2, done: 1 },
      { user_id: other.userId, name: "other", open: 1, done: 1 },
    ]);

    const denied = await call<ErrBody>(t, "GET", `/v1/todos/summary?workspace_id=${org.workspaceId}`, {
      as: stranger.userId,
    });
    expect(denied.status).toBe(404);

    const empty = await call<Summary>(t, "GET", `/v1/todos/summary?workspace_id=${stranger.workspaceId}`, {
      as: stranger.userId,
    });
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ open: 0, done: 0, by_member: [] });
  });
});
