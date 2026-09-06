// note.purge（每日，规格 03 §6 / 02 §0）：purge_after < now() → 删 note_updates / note_snapshots / attachment_refs / checklist_items，
//   清空投影列，notes 行保留为墓碑（purged_at）；此后 sync-ws onAuthenticate 回 gone。
// note.expire（每小时，规格 04 §4.6）：expires_at < now() → archived_at = now()；到期前 24 h 给作者 note.expiring 通知。
import { sql } from "drizzle-orm";
import { audit } from "../audit/index.js";
import { withWorkerTx } from "../db/client.js";
import { iso, num, rows } from "../services/db-util.js";
import { notifyNotesChanged, purgeNote } from "../services/notes.js";
import { notify } from "../services/notify.js";
import type { WorkerDeps } from "./context.js";

export interface PurgeOptions {
  batch?: number;
  /** 单次 job 最多处理的批数（每批一个事务，避免单语句超 60 s） */
  maxBatches?: number;
}

export async function purgeNotes(deps: WorkerDeps, opts: PurgeOptions = {}): Promise<number> {
  const batch = Math.min(500, Math.max(1, opts.batch ?? 100));
  const maxBatches = opts.maxBatches ?? 50;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await withWorkerTx(async (tx) => {
      const due = await rows<{ id: string; workspace_id: string }>(
        tx,
        sql`SELECT id, workspace_id FROM notes
             WHERE purge_after IS NOT NULL AND purge_after < now() AND purged_at IS NULL
             ORDER BY purge_after ASC LIMIT ${batch} FOR UPDATE SKIP LOCKED`,
      );
      for (const note of due) {
        await purgeNote(tx, note.id);
        const [after] = await rows<{ lsn: string | number }>(
          tx,
          sql`SELECT lsn FROM notes WHERE id = ${note.id}::uuid`,
        );
        await notifyNotesChanged(tx, note.workspace_id, note.id, num(after?.lsn));
        await audit(tx, {
          action: "note.purged",
          actorType: "system",
          targetType: "note",
          targetId: note.id,
        });
      }
      return due.length;
    }, deps.db);
    total += n;
    if (n < batch) break;
  }
  if (total > 0) deps.log.info({ total }, "notes purged");
  return total;
}

export interface ExpireResult {
  archived: number;
  notified: number;
}

export async function expireNotes(deps: WorkerDeps): Promise<ExpireResult> {
  return withWorkerTx(async (tx) => {
    const archived = await rows<{ id: string; workspace_id: string; lsn: string | number }>(
      tx,
      sql`UPDATE notes SET archived_at = now(), lsn = nextval('global_lsn'), updated_at = now()
           WHERE expires_at IS NOT NULL AND expires_at < now() AND archived_at IS NULL
           RETURNING id, workspace_id, lsn`,
    );
    for (const n of archived) await notifyNotesChanged(tx, n.workspace_id, n.id, num(n.lsn));

    const expiring = await rows<{
      id: string;
      created_by: string;
      workspace_id: string;
      org_id: string | null;
      expires_at: Date;
    }>(
      tx,
      sql`SELECT n.id, n.created_by, n.workspace_id, w.org_id, n.expires_at FROM notes n JOIN workspaces w ON w.id = n.workspace_id
           WHERE n.expires_at IS NOT NULL AND n.archived_at IS NULL AND n.deleted_at IS NULL AND n.purged_at IS NULL
             AND n.expires_at BETWEEN now() AND now() + interval '24 hours'
             AND NOT EXISTS (SELECT 1 FROM notifications x WHERE x.user_id = n.created_by AND x.group_key = 'note:' || n.id::text || ':expiring')
           LIMIT 1000`,
    );
    let notified = 0;
    for (const n of expiring) {
      const r = await notify(tx, {
        userId: n.created_by,
        kind: "note.expiring",
        orgId: n.org_id,
        subjectType: "note",
        subjectId: n.id,
        payload: { expires_at: iso(n.expires_at), workspace_id: n.workspace_id },
        groupKey: `note:${n.id}:expiring`,
      });
      if (r.inserted) notified += 1;
    }
    if (archived.length > 0 || notified > 0)
      deps.log.info({ archived: archived.length, notified }, "notes expired");
    return { archived: archived.length, notified };
  }, deps.db);
}
