// projector（规格 03 §4 / 02 §3 / 08 X1）：note.project {note_id, seq}，singletonKey=note_id（sync-ws 入队）。
//   1. SELECT … FOR UPDATE；projected_seq >= seq 且非 force → 幂等跳过
//   2. loadNoteDoc（快照 + 增量）→ @bianfa/shared projectNoteDoc → content / content_text / checklist_items / attachment_refs
//   3. meta → color / z_mode / schema_version / created_at / updated_at；deleted_at 按「编辑胜」：bodyEditedAt > deletedAt → 清除
//   4. lsn = nextval('global_lsn')、projected_seq = max(seq, head_seq)；pg_notify('notes_changed', {workspace_id, note_id, version})
// 保险箱（encryption='e2ee'）永不投影正文（01 C13）；已 purge 的墓碑跳过。
import { getMetaMap, projectNoteDoc } from "@bianfa/shared";
import { sql } from "drizzle-orm";
import { withWorkerTx } from "../db/client.js";
import { loadNoteDoc } from "../notes/doc-store.js";
import { num, one, pgArray, rows, toDate } from "../services/db-util.js";
import { notifyNotesChanged, TRASH_RETENTION_DAYS } from "../services/notes.js";
import type { WorkerDeps } from "./context.js";

export interface ProjectJobData {
  note_id: string;
  seq: number;
  /** note.reproject_all 用：忽略 projected_seq 幂等检查 */
  force?: boolean;
}

export type ProjectResult = "projected" | "skipped" | "missing";

interface NoteRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  projected_seq: string | number;
  head_seq: string | number;
  purged_at: Date | null;
  deleted_at: Date | null;
  encryption: string;
  created_at: Date;
}

const msOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;

/** 「编辑胜」判定（规格 03 §3 / 08 X1）：返回投影后的 deleted_at（ms）或 null */
export function resolveDeletedAt(
  metaDeletedAt: number | null,
  bodyEditedAt: number | null,
  existingDeletedAtMs: number | null,
): number | null {
  if (metaDeletedAt !== null) {
    return bodyEditedAt !== null && bodyEditedAt > metaDeletedAt ? null : metaDeletedAt;
  }
  if (existingDeletedAtMs !== null) {
    // 服务端 REST 软删（无 CRDT 墓碑）：只有删除之后的编辑才复活
    return bodyEditedAt !== null && bodyEditedAt > existingDeletedAtMs ? null : existingDeletedAtMs;
  }
  return null;
}

export async function projectNote(deps: WorkerDeps, data: ProjectJobData): Promise<ProjectResult> {
  const seq = Math.max(0, Math.trunc(Number(data.seq) || 0));
  return withWorkerTx(async (tx) => {
    const row = await one<NoteRow>(
      tx,
      sql`SELECT id, workspace_id, projected_seq, head_seq, purged_at, deleted_at, encryption, created_at
            FROM notes WHERE id = ${data.note_id}::uuid FOR UPDATE`,
    );
    if (!row) return "missing";
    if (row.purged_at || row.encryption === "e2ee") return "skipped";
    if (!data.force && num(row.projected_seq) >= seq && seq > 0) return "skipped";

    const { doc, headSeq } = await loadNoteDoc(tx, row.id);
    try {
      const p = projectNoteDoc(doc);
      const metaMap = getMetaMap(doc);
      const bodyEditedAt = msOrNull(metaMap.get("bodyEditedAt"));
      const deletedMs = resolveDeletedAt(
        p.meta.deletedAt,
        bodyEditedAt,
        toDate(row.deleted_at)?.getTime() ?? null,
      );
      const deletedAt = deletedMs === null ? null : new Date(deletedMs);
      const purgeAfter = deletedAt ? new Date(deletedAt.getTime() + TRASH_RETENTION_DAYS * 86_400_000) : null;
      const createdAt =
        p.meta.createdAt > 0 ? new Date(p.meta.createdAt) : (toDate(row.created_at) ?? new Date());
      const updatedAt = p.meta.updatedAt > 0 ? new Date(p.meta.updatedAt) : new Date();
      const projectedSeq = Math.max(seq, headSeq, num(row.head_seq));

      const updated = await one<{ lsn: string | number }>(
        tx,
        sql`UPDATE notes SET
              content = ${JSON.stringify(p.content)}::jsonb,
              content_text = ${p.contentText},
              color = ${p.meta.color},
              z_mode = ${p.meta.zMode},
              schema_version = ${p.meta.schemaVersion},
              created_at = ${createdAt},
              updated_at = ${updatedAt},
              deleted_at = ${deletedAt},
              purge_after = ${purgeAfter},
              projected_seq = ${projectedSeq},
              lsn = nextval('global_lsn')
            WHERE id = ${row.id}::uuid
            RETURNING lsn`,
      );

      await tx.execute(sql`DELETE FROM checklist_items WHERE note_id = ${row.id}::uuid`);
      for (const item of p.checklistItems) {
        await tx.execute(
          sql`INSERT INTO checklist_items (note_id, block_id, text, checked, ordinal)
              VALUES (${row.id}::uuid, ${item.blockId}, ${item.text}, ${item.checked}, ${item.ordinal})
              ON CONFLICT (note_id, block_id) DO UPDATE SET text = EXCLUDED.text, checked = EXCLUDED.checked, ordinal = EXCLUDED.ordinal`,
        );
      }

      const attachmentIds = p.attachmentIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
      const existing = attachmentIds.length
        ? (
            await rows<{ id: string }>(
              tx,
              sql`SELECT id FROM attachments WHERE id = ANY(${pgArray(attachmentIds)}::uuid[])`,
            )
          ).map((r) => r.id)
        : [];
      for (const attId of existing) {
        await tx.execute(
          sql`INSERT INTO attachment_refs (note_id, attachment_id, last_referenced_at) VALUES (${row.id}::uuid, ${attId}::uuid, now())
              ON CONFLICT (note_id, attachment_id) DO UPDATE SET last_referenced_at = now()`,
        );
      }
      await tx.execute(
        sql`DELETE FROM attachment_refs WHERE note_id = ${row.id}::uuid AND NOT (attachment_id = ANY(${pgArray(existing)}::uuid[]))`,
      );

      await notifyNotesChanged(tx, row.workspace_id, row.id, num(updated?.lsn));
      deps.log.debug({ note_id: row.id, seq: projectedSeq, deleted: deletedAt !== null }, "note projected");
      return "projected";
    } finally {
      doc.destroy();
    }
  }, deps.db);
}

export interface ReprojectAllData {
  schema_version?: number;
  batch?: number;
}

/** note.reproject_all：分批为全部未 purge 的服务端便笺入队 note.project(force)；返回入队数 */
export async function reprojectAll(
  deps: WorkerDeps,
  data: ReprojectAllData,
  enqueue: (job: ProjectJobData) => Promise<unknown>,
): Promise<number> {
  const batch = Math.min(1000, Math.max(50, data.batch ?? 500));
  let after: string | null = null;
  let total = 0;
  for (;;) {
    const page: { id: string; head_seq: string | number }[] = await withWorkerTx(
      (tx) =>
        rows<{ id: string; head_seq: string | number }>(
          tx,
          sql`SELECT id, head_seq FROM notes
               WHERE purged_at IS NULL AND encryption = 'server'
                 AND (${after}::uuid IS NULL OR id > ${after}::uuid)
                 AND (${data.schema_version ?? null}::int IS NULL OR schema_version <= ${data.schema_version ?? null}::int)
               ORDER BY id ASC LIMIT ${batch}`,
        ),
      deps.db,
    );
    if (page.length === 0) break;
    for (const n of page) {
      await enqueue({ note_id: n.id, seq: num(n.head_seq), force: true });
      total += 1;
    }
    after = page[page.length - 1]?.id ?? null;
    if (page.length < batch) break;
  }
  deps.log.info({ total, schema_version: data.schema_version ?? null }, "reproject_all enqueued");
  return total;
}
