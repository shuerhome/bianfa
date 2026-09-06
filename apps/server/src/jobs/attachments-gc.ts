// attachments.gc（规格 02 §8 第 6 条 / 01 C10）：mark-and-sweep，禁止引用计数。
//   (a) status='pending' 且 created_at < now()-24h → 删行
//   (b) committed 行无 attachment_refs 且 created_at < now()-30d 且最后引用 > 30d → deleted_at = now()
//   (c) deleted_at 非空超过 24 h 宽限、且 storage_key 不再被任何未删除行引用 → 删 R2 对象 → 删行
// 硬删顺序：先 note 引用（projector 维护），后附件；R2 缺失时 (c) 只删行不删对象（对象由下次配置 R2 后的 GC 收）。
import { sql } from "drizzle-orm";
import { withWorkerTx } from "../db/client.js";
import { pgArray, rows } from "../services/db-util.js";
import type { WorkerDeps } from "./context.js";

export interface GcOptions {
  pendingHours?: number;
  unreferencedDays?: number;
  graceHours?: number;
  batch?: number;
}

export interface GcResult {
  pendingDeleted: number;
  marked: number;
  swept: number;
  objectsDeleted: number;
}

export async function gcAttachments(deps: WorkerDeps, opts: GcOptions = {}): Promise<GcResult> {
  const pendingHours = opts.pendingHours ?? 24;
  const unreferencedDays = opts.unreferencedDays ?? 30;
  const graceHours = opts.graceHours ?? 24;
  const batch = Math.min(1000, Math.max(1, opts.batch ?? 200));
  const result: GcResult = { pendingDeleted: 0, marked: 0, swept: 0, objectsDeleted: 0 };

  // (a) + (b)：单事务、分批
  await withWorkerTx(async (tx) => {
    const pending = await rows<{ id: string }>(
      tx,
      sql`DELETE FROM attachments WHERE id IN (
            SELECT id FROM attachments WHERE status = 'pending' AND created_at < now() - make_interval(hours => ${pendingHours})
            ORDER BY created_at LIMIT ${batch})
          RETURNING id`,
    );
    result.pendingDeleted = pending.length;
    const marked = await rows<{ id: string }>(
      tx,
      sql`UPDATE attachments a SET deleted_at = now()
           WHERE a.id IN (
             SELECT a2.id FROM attachments a2
              WHERE a2.status = 'committed' AND a2.deleted_at IS NULL
                AND a2.created_at < now() - make_interval(days => ${unreferencedDays})
                AND NOT EXISTS (SELECT 1 FROM attachment_refs r WHERE r.attachment_id = a2.id
                                   AND r.last_referenced_at > now() - make_interval(days => ${unreferencedDays}))
                AND NOT EXISTS (SELECT 1 FROM attachment_refs r JOIN notes n ON n.id = r.note_id
                                 WHERE r.attachment_id = a2.id AND n.purged_at IS NULL AND n.deleted_at IS NULL)
              LIMIT ${batch})
           RETURNING a.id`,
    );
    result.marked = marked.length;
  }, deps.db);

  // (c)：先找出可回收的对象（storage_key 不再被任何未删除行引用），删对象成功后再删行
  const sweepable = await withWorkerTx(
    (tx) =>
      rows<{ id: string; storage_key: string }>(
        tx,
        sql`SELECT a.id, a.storage_key FROM attachments a
             WHERE a.deleted_at IS NOT NULL AND a.deleted_at < now() - make_interval(hours => ${graceHours})
               AND NOT EXISTS (SELECT 1 FROM attachments b WHERE b.storage_key = a.storage_key AND b.deleted_at IS NULL)
             ORDER BY a.deleted_at LIMIT ${batch}`,
      ),
    deps.db,
  );
  const byKey = new Map<string, string[]>();
  for (const s of sweepable) byKey.set(s.storage_key, [...(byKey.get(s.storage_key) ?? []), s.id]);
  for (const [key, ids] of byKey) {
    if (deps.storage) {
      try {
        await deps.storage.delete(key);
        result.objectsDeleted += 1;
      } catch (err) {
        deps.log.warn(
          { err: (err as Error).message, key },
          "attachment object delete failed; keeping rows for retry",
        );
        continue;
      }
    }
    await withWorkerTx(
      (tx) => tx.execute(sql`DELETE FROM attachments WHERE id = ANY(${pgArray(ids)}::uuid[])`),
      deps.db,
    );
    result.swept += ids.length;
  }
  if (result.pendingDeleted || result.marked || result.swept) deps.log.info(result, "attachments gc");
  return result;
}
