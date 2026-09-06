// worker 任务直接调用（不经 pg-boss）：note.project（真实 Y.Doc → 投影列 + checklist + notes_changed NOTIFY、幂等、编辑胜）、
// note.purge（清正文留墓碑）、note.expire（归档 + 到期通知）、export.build（ZIP 落盘）、attachments.gc、account.purge（列缺失时空转）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNoteDoc,
  encodeStateV2,
  getMetaMap,
  Origins,
  setBodyFromPmJson,
  writeMeta,
} from "@bianfa/shared";
import { sql } from "drizzle-orm";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool, type Db } from "../../src/db/client.js";
import { createDirectClient, type DirectClient } from "../../src/db/direct.js";
import { uuidv7 } from "../../src/db/ids.js";
import { purgeAccounts } from "../../src/jobs/account-purge.js";
import { gcAttachments } from "../../src/jobs/attachments-gc.js";
import type { WorkerDeps } from "../../src/jobs/context.js";
import { buildExport } from "../../src/jobs/export.js";
import { projectNote, reprojectAll } from "../../src/jobs/project.js";
import { expireNotes, purgeNotes } from "../../src/jobs/purge.js";
import { listZip } from "../../src/jobs/zip.js";
import { createLocalStorage } from "../../src/services/storage.js";
import { seedNote, seedUserV7, waitFor } from "./api-helpers.js";
import { DIRECT_URL, type Fixture, hasDb, openAdmin, POOLED_URL, truncateAll } from "./helpers.js";

const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

describe.skipIf(!hasDb)("worker jobs", () => {
  let f: Fixture;
  let db: Db;
  let deps: WorkerDeps;
  let direct: DirectClient;
  const changed: { workspace_id: string; note_id: string; version: number }[] = [];
  let me: { userId: string; workspaceId: string };
  const dir = mkdtempSync(join(tmpdir(), "bianfa-worker-"));
  const sent: { to: string; template: string; vars: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    f = openAdmin();
    await truncateAll(f.admin);
    const pool = createPool(POOLED_URL as string, { max: 3 });
    db = createDb(pool);
    deps = {
      db,
      log: pino({ level: "silent" }),
      storage: null,
      exportStorage: createLocalStorage(dir),
      mail: {
        async send(to, template, vars) {
          sent.push({ to, template, vars });
        },
      },
    };
    me = await seedUserV7(db, "worker-me");
    direct = createDirectClient({ connectionString: DIRECT_URL as string, reconnectBaseMs: 50 });
    await direct.listen("notes_changed", (payload) => changed.push(JSON.parse(payload)));
    await direct.waitConnected();
  });

  afterAll(async () => {
    await direct.close();
    await truncateAll(f.admin);
    await f.admin.end();
    rmSync(dir, { recursive: true, force: true });
  });

  async function insertDocUpdate(noteId: string, update: Uint8Array): Promise<number> {
    const r = await f.admin.query<{ seq: number }>(
      `INSERT INTO note_updates (note_id, seq, update_v2, author_id)
       VALUES ($1, (SELECT head_seq + 1 FROM notes WHERE id = $1), $2, $3) RETURNING seq`,
      [noteId, Buffer.from(update), me.userId],
    );
    const seq = Number(r.rows[0]?.seq);
    await f.admin.query("UPDATE notes SET head_seq = $2, crdt_bytes = $3 WHERE id = $1", [
      noteId,
      seq,
      update.byteLength,
    ]);
    return seq;
  }

  it("note.project：真实 Y.Doc → content/content_text/color/z_mode/checklist_items/attachment_refs + notes_changed；幂等", async () => {
    const noteId = uuidv7();
    await f.admin.query(
      "INSERT INTO notes (id, workspace_id, created_by, created_at, updated_at) VALUES ($1, $2, $3, now(), now())",
      [noteId, me.workspaceId, me.userId],
    );
    const attId = uuidv7();
    await f.admin.query(
      `INSERT INTO attachments (id, workspace_id, created_by, content_hash, byte_size, mime, storage_key, status)
       VALUES ($1, $2, $3, decode($4, 'hex'), 10, 'image/png', 'ws/x', 'committed')`,
      [attId, me.workspaceId, me.userId, "ab".repeat(32)],
    );
    const doc = createNoteDoc(noteId, {
      meta: { color: "teal", zMode: 1, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000 },
    });
    setBodyFromPmJson(doc, {
      type: "doc",
      content: [
        p("周三 产品评审"),
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: false, id: "aaaaaaaaaa" }, content: [p("确认色板")] },
            { type: "taskItem", attrs: { checked: true, id: "bbbbbbbbbb" }, content: [p("补 macOS 验证")] },
          ],
        },
        { type: "image", attrs: { attachmentId: attId, w: 10, h: 10, blurhash: null, alt: "图" } },
        { type: "image", attrs: { attachmentId: uuidv7(), w: null, h: null, blurhash: null, alt: null } },
      ],
    });
    const seq = await insertDocUpdate(noteId, encodeStateV2(doc));
    doc.destroy();

    expect(await projectNote(deps, { note_id: noteId, seq })).toBe("projected");
    const row = await f.admin.query(
      "SELECT content, content_text, title_cache, color, z_mode, pinned, schema_version, projected_seq::int AS projected_seq, lsn::int AS lsn, created_at, updated_at, deleted_at FROM notes WHERE id = $1",
      [noteId],
    );
    const n = row.rows[0] as Record<string, unknown>;
    expect(n.content_text).toBe("周三 产品评审\n[ ] 确认色板\n[x] 补 macOS 验证\n\n");
    expect(n.title_cache).toBe("周三 产品评审");
    expect(n).toMatchObject({
      color: "teal",
      z_mode: 1,
      pinned: true,
      schema_version: 1,
      projected_seq: seq,
      deleted_at: null,
    });
    expect((n.content as { type: string }).type).toBe("doc");
    expect((n.created_at as Date).getTime()).toBe(1_700_000_000_000);
    expect((n.updated_at as Date).getTime()).toBe(1_700_000_100_000);
    const items = await f.admin.query(
      "SELECT block_id, text, checked, ordinal FROM checklist_items WHERE note_id = $1 ORDER BY ordinal",
      [noteId],
    );
    expect(items.rows).toEqual([
      { block_id: "aaaaaaaaaa", text: "确认色板", checked: false, ordinal: 0 },
      { block_id: "bbbbbbbbbb", text: "补 macOS 验证", checked: true, ordinal: 1 },
    ]);
    const refs = await f.admin.query("SELECT attachment_id FROM attachment_refs WHERE note_id = $1", [
      noteId,
    ]);
    expect(refs.rows.map((r) => r.attachment_id)).toEqual([attId]); // 不存在的附件 id 被过滤
    await waitFor(() => changed.some((c) => c.note_id === noteId && c.version === Number(n.lsn)));
    expect(changed.find((c) => c.note_id === noteId)).toMatchObject({ workspace_id: me.workspaceId });

    // 幂等：同 seq 再跑 → skipped，lsn 不变；force → 重投影
    expect(await projectNote(deps, { note_id: noteId, seq })).toBe("skipped");
    const same = await f.admin.query("SELECT lsn::int AS lsn FROM notes WHERE id = $1", [noteId]);
    expect(same.rows[0]?.lsn).toBe(Number(n.lsn));
    expect(await projectNote(deps, { note_id: noteId, seq, force: true })).toBe("projected");
    expect(await projectNote(deps, { note_id: uuidv7(), seq: 1 })).toBe("missing");
  });

  it("编辑胜：meta.deletedAt 之后有 bodyEditedAt → 投影不删除；否则 deleted_at + purge_after(+30d)", async () => {
    const noteId = uuidv7();
    await f.admin.query(
      "INSERT INTO notes (id, workspace_id, created_by, created_at, updated_at) VALUES ($1, $2, $3, now(), now())",
      [noteId, me.workspaceId, me.userId],
    );
    const doc = createNoteDoc(noteId);
    setBodyFromPmJson(doc, { type: "doc", content: [p("要删的")] });
    writeMeta(doc, { deletedAt: 2_000_000 }, Origins.local);
    let seq = await insertDocUpdate(noteId, encodeStateV2(doc));
    await projectNote(deps, { note_id: noteId, seq });
    let r = await f.admin.query("SELECT deleted_at, purge_after FROM notes WHERE id = $1", [noteId]);
    const first = r.rows[0] as { deleted_at: Date; purge_after: Date };
    expect(first.deleted_at.getTime()).toBe(2_000_000);
    expect(first.purge_after.getTime() - first.deleted_at.getTime()).toBe(30 * 86_400_000);

    doc.transact(() => getMetaMap(doc).set("bodyEditedAt", 3_000_000), Origins.local);
    seq = await insertDocUpdate(noteId, encodeStateV2(doc));
    await projectNote(deps, { note_id: noteId, seq });
    r = await f.admin.query("SELECT deleted_at, purge_after FROM notes WHERE id = $1", [noteId]);
    expect(r.rows[0]).toEqual({ deleted_at: null, purge_after: null });
    doc.destroy();
  });

  it("note.reproject_all 为每条便笺入队 force 任务", async () => {
    const jobs: { note_id: string; force?: boolean }[] = [];
    const n = await reprojectAll(deps, { batch: 50 }, async (j) => {
      jobs.push(j);
    });
    expect(n).toBeGreaterThanOrEqual(2);
    expect(jobs.every((j) => j.force === true)).toBe(true);
  });

  it("note.purge：purge_after 过期 → 删 updates/snapshots/refs/checklist，清投影列，墓碑 purged_at，NOTIFY + 审计", async () => {
    const noteId = uuidv7();
    await f.admin.query(
      `INSERT INTO notes (id, workspace_id, created_by, content_text, created_at, updated_at, deleted_at, purge_after)
       VALUES ($1, $2, $3, '要清掉的正文', now(), now(), now() - interval '31 days', now() - interval '1 day')`,
      [noteId, me.workspaceId, me.userId],
    );
    await f.admin.query("INSERT INTO note_updates (note_id, seq, update_v2) VALUES ($1, 1, '\\x00')", [
      noteId,
    ]);
    await f.admin.query(
      "INSERT INTO checklist_items (note_id, block_id, text, checked, ordinal) VALUES ($1, 'b', 't', false, 0)",
      [noteId],
    );
    const keep = await seedNote(db, me.workspaceId, me.userId, "留着的");
    expect(await purgeNotes(deps)).toBe(1);
    const r = await f.admin.query(
      "SELECT content_text, content, purged_at, deleted_at FROM notes WHERE id = $1",
      [noteId],
    );
    expect(r.rows[0]).toMatchObject({ content_text: "", content: { type: "doc", content: [] } });
    expect(r.rows[0]?.purged_at).toBeTruthy();
    expect(
      (await f.admin.query("SELECT count(*)::int AS n FROM note_updates WHERE note_id = $1", [noteId]))
        .rows[0]?.n,
    ).toBe(0);
    expect(
      (await f.admin.query("SELECT count(*)::int AS n FROM checklist_items WHERE note_id = $1", [noteId]))
        .rows[0]?.n,
    ).toBe(0);
    expect(
      (await f.admin.query("SELECT content_text FROM notes WHERE id = $1", [keep])).rows[0]?.content_text,
    ).toBe("留着的");
    await waitFor(() => changed.some((c) => c.note_id === noteId));
    const audit = await f.admin.query(
      "SELECT actor_type FROM audit_log WHERE action = 'note.purged' AND target_id = $1",
      [noteId],
    );
    expect(audit.rows[0]?.actor_type).toBe("system");
    expect(await purgeNotes(deps)).toBe(0);
  });

  it("note.expire：过期归档 + 24h 内到期通知（去重）", async () => {
    const expired = await seedNote(db, me.workspaceId, me.userId, "过期");
    const soon = await seedNote(db, me.workspaceId, me.userId, "快过期");
    await f.admin.query("UPDATE notes SET expires_at = now() - interval '1 hour' WHERE id = $1", [expired]);
    await f.admin.query("UPDATE notes SET expires_at = now() + interval '2 hours' WHERE id = $1", [soon]);
    const r1 = await expireNotes(deps);
    expect(r1).toEqual({ archived: 1, notified: 1 });
    expect(
      (await f.admin.query("SELECT archived_at FROM notes WHERE id = $1", [expired])).rows[0]?.archived_at,
    ).toBeTruthy();
    const r2 = await expireNotes(deps);
    expect(r2).toEqual({ archived: 0, notified: 0 });
    const notif = await f.admin.query(
      "SELECT kind, group_key FROM notifications WHERE user_id = $1 AND kind = 'note.expiring'",
      [me.userId],
    );
    expect(notif.rows).toEqual([{ kind: "note.expiring", group_key: `note:${soon}:expiring` }]);
  });

  it("export.build：ZIP 含 notes.json / notes/*.md / attachments.json / audit_log.csv / ai_history.json；job ready + 通知 + 邮件", async () => {
    const jobId = uuidv7();
    await f.admin.query(
      "INSERT INTO export_jobs (id, user_id, scope, status) VALUES ($1, $2, 'user', 'queued')",
      [jobId, me.userId],
    );
    expect(await buildExport(deps, { job_id: jobId })).toBe("ready");
    const job = await f.admin.query(
      "SELECT status, storage_key, byte_size::int AS byte_size, expires_at FROM export_jobs WHERE id = $1",
      [jobId],
    );
    expect(job.rows[0]).toMatchObject({ status: "ready", storage_key: `exports/${me.userId}/${jobId}.zip` });
    expect(job.rows[0]?.expires_at).toBeTruthy();
    const { readFileSync } = await import("node:fs");
    const zip = readFileSync(join(dir, `exports/${me.userId}/${jobId}.zip`));
    expect(zip.length).toBe(job.rows[0]?.byte_size);
    const names = listZip(zip).map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining(["notes.json", "attachments.json", "audit_log.csv", "ai_history.json"]),
    );
    expect(names.filter((n) => n.startsWith("notes/") && n.endsWith(".md")).length).toBeGreaterThanOrEqual(3);
    expect(sent.at(-1)).toMatchObject({
      template: "export_ready",
      vars: expect.objectContaining({ job_id: jobId }),
    });
    const notif = await f.admin.query(
      "SELECT kind FROM notifications WHERE user_id = $1 AND kind = 'export.ready'",
      [me.userId],
    );
    expect(notif.rows).toHaveLength(1);
    expect(await buildExport(deps, { job_id: jobId })).toBe("skipped");
  });

  it("attachments.gc：过期 pending 删行；无引用 committed 标记删除；宽限后清行", async () => {
    const pending = uuidv7();
    const orphan = uuidv7();
    await f.admin.query(
      `INSERT INTO attachments (id, workspace_id, created_by, content_hash, byte_size, mime, storage_key, status, created_at)
       VALUES ($1, $2, $3, decode($4, 'hex'), 10, 'image/png', 'ws/p', 'pending', now() - interval '2 days'),
              ($5, $2, $3, decode($6, 'hex'), 10, 'image/png', 'ws/o', 'committed', now() - interval '40 days')`,
      [pending, me.workspaceId, me.userId, "cd".repeat(32), orphan, "ef".repeat(32)],
    );
    const r1 = await gcAttachments(deps, { graceHours: 1 });
    expect(r1.pendingDeleted).toBe(1);
    expect(r1.marked).toBe(1);
    expect(r1.swept).toBe(0); // 刚标记，仍在 1 h 宽限内
    const r2 = await gcAttachments(deps, { graceHours: -1 });
    expect(r2.swept).toBe(1);
    expect(
      (
        await f.admin.query("SELECT count(*)::int AS n FROM attachments WHERE id IN ($1, $2)", [
          pending,
          orphan,
        ])
      ).rows[0]?.n,
    ).toBe(0);
  });

  it("account.purge：user.deletion_due_at 列不存在（迁移 0004 未合并）时空转返回 0，不抛错", async () => {
    const cols = await f.admin.query(
      "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'user' AND column_name IN ('deletion_due_at','deletionDueAt')",
    );
    const n = await purgeAccounts(deps);
    if (cols.rows[0]?.n === 0) expect(n).toBe(0);
    else expect(n).toBeGreaterThanOrEqual(0);
  });

  it("purgeNote 后 SQL 层：worker 未加 GUC 也能操作（BYPASSRLS 语义由超级用户模拟）", async () => {
    const r = await db.execute(sql`SELECT count(*)::int AS n FROM notes`);
    expect(Number((r.rows[0] as { n: number }).n)).toBeGreaterThan(0);
  });
});
