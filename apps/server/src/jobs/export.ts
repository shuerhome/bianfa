// export.build（规格 04 §7.9）：ZIP = notes.json（含 shares/comments 引用）+ notes/<id>.md（pmJsonToMarkdown）
//   + attachments.json（清单；对象本身经 5 min 签名 URL 另取）+ audit_log.csv（本人相关）+ ai_history.json（空数组）
//   → R2 exports/<user>/<job>.zip（或 EXPORT_LOCAL_DIR 落盘）→ 预签名 24 h → 邮件 export_ready + 站内通知。
// 任何角色不能导出他人个人 workspace：scope='user' 只取该用户 owner 的 personal 工作区。
import { pmJsonToMarkdown } from "@bianfa/shared";
import { sql } from "drizzle-orm";
import { audit } from "../audit/index.js";
import { withWorkerTx } from "../db/client.js";
import { iso, num, one, pgArray, rows, toDate } from "../services/db-util.js";
import { notify } from "../services/notify.js";
import { createLocalStorage, exportStorageKey, PRESIGN_EXPORT_SECONDS } from "../services/storage.js";
import type { WorkerDeps } from "./context.js";
import { createZip, type ZipEntry } from "./zip.js";

export interface ExportJobData {
  job_id: string;
  user_id?: string;
}

export type ExportResult = "ready" | "skipped" | "failed";

interface JobRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  scope: string;
  status: string;
  email: string;
  name: string;
}

function csvCell(v: unknown): string {
  const s =
    v === null || v === undefined
      ? ""
      : v instanceof Date
        ? v.toISOString()
        : typeof v === "object"
          ? JSON.stringify(v)
          : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function buildExport(
  deps: WorkerDeps,
  data: ExportJobData,
  opts: { localDir?: string } = {},
): Promise<ExportResult> {
  const job = await withWorkerTx(async (tx) => {
    const row = await one<JobRow>(
      tx,
      sql`SELECT j.id, j.user_id, j.scope, j.status, u.email, u.name FROM export_jobs j JOIN "user" u ON u.id = j.user_id
           WHERE j.id = ${data.job_id}::uuid FOR UPDATE`,
    );
    if (!row || (row.status !== "queued" && row.status !== "building")) return null;
    await tx.execute(sql`UPDATE export_jobs SET status = 'building' WHERE id = ${row.id}::uuid`);
    return row;
  }, deps.db);
  if (!job) return "skipped";

  try {
    const entries = await collectEntries(deps, job);
    const zip = createZip(entries);
    const key = exportStorageKey(job.user_id, job.id);
    const storage =
      deps.exportStorage ??
      createLocalStorage(opts.localDir ?? `${process.env.TMPDIR ?? "/tmp"}/bianfa-exports`);
    await storage.put(key, zip, "application/zip");
    const url = await storage.presignGet(key, {
      expiresIn: PRESIGN_EXPORT_SECONDS,
      downloadName: `bianfa-export-${job.id}.zip`,
    });

    await withWorkerTx(async (tx) => {
      await tx.execute(
        sql`UPDATE export_jobs SET status = 'ready', storage_key = ${key}, byte_size = ${zip.length},
              expires_at = now() + interval '24 hours', finished_at = now(), error = NULL
            WHERE id = ${job.id}::uuid`,
      );
      await notify(tx, {
        userId: job.user_id,
        kind: "export.ready",
        subjectType: "export_job",
        subjectId: job.id,
        payload: { byte_size: zip.length },
      });
      await audit(tx, {
        action: "export.ready",
        actorType: "system",
        actorId: job.user_id,
        targetType: "export_job",
        targetId: job.id,
      });
    }, deps.db);

    if (deps.mail) {
      await deps.mail.send(job.email, "export_ready", {
        name: job.name,
        url,
        expires_hours: 24,
        job_id: job.id,
      });
    } else {
      deps.log.info(
        { job_id: job.id, storage: storage.kind },
        "export ready (no mail provider; url not logged)",
      );
    }
    return "ready";
  } catch (err) {
    const message = ((err as Error).message ?? "export failed").slice(0, 500);
    deps.log.error({ err: message, job_id: job.id }, "export.build failed");
    await withWorkerTx(
      (tx) =>
        tx.execute(
          sql`UPDATE export_jobs SET status = 'failed', error = ${message}, finished_at = now() WHERE id = ${job.id}::uuid`,
        ),
      deps.db,
    );
    return "failed";
  }
}

async function collectEntries(deps: WorkerDeps, job: JobRow): Promise<ZipEntry[]> {
  return withWorkerTx(async (tx) => {
    const workspaces = await rows<{ id: string; name: string; kind: string }>(
      tx,
      job.scope === "org"
        ? sql`SELECT id, name, kind FROM workspaces WHERE kind = 'team' AND org_id = (SELECT org_id FROM export_jobs WHERE id = ${job.id}::uuid) AND deleted_at IS NULL`
        : sql`SELECT id, name, kind FROM workspaces WHERE kind = 'personal' AND owner_user_id = ${job.user_id} AND deleted_at IS NULL`,
    );
    const wsIds = workspaces.map((w) => w.id);
    const notes = wsIds.length
      ? await rows<{
          id: string;
          workspace_id: string;
          title_cache: string | null;
          content: Record<string, unknown>;
          content_text: string;
          color: string;
          z_mode: number;
          schema_version: number;
          created_at: Date;
          updated_at: Date;
          deleted_at: Date | null;
          expires_at: Date | null;
          archived_at: Date | null;
          purged_at: Date | null;
        }>(
          tx,
          sql`SELECT id, workspace_id, title_cache, content, content_text, color, z_mode, schema_version, created_at, updated_at,
                     deleted_at, expires_at, archived_at, purged_at
                FROM notes WHERE workspace_id = ANY(${pgArray(wsIds)}::uuid[]) AND purged_at IS NULL ORDER BY created_at`,
        )
      : [];
    const noteIds = notes.map((n) => n.id);
    const shares = noteIds.length
      ? await rows<{
          id: string;
          note_id: string;
          grantee_user_id: string | null;
          perm: string;
          created_at: Date;
          expires_at: Date | null;
        }>(
          tx,
          sql`SELECT id, note_id, grantee_user_id, perm, created_at, expires_at FROM shares
               WHERE note_id = ANY(${pgArray(noteIds)}::uuid[]) AND revoked_at IS NULL ORDER BY created_at`,
        )
      : [];
    const comments = noteIds.length
      ? await rows<{ id: string; note_id: string; author_id: string; body: string; created_at: Date }>(
          tx,
          sql`SELECT id, note_id, author_id, body, created_at FROM comments WHERE note_id = ANY(${pgArray(noteIds)}::uuid[]) ORDER BY created_at`,
        )
      : [];
    const attachments = noteIds.length
      ? await rows<{
          id: string;
          note_id: string;
          mime: string;
          byte_size: string;
          content_hash: Buffer;
          storage_key: string;
        }>(
          tx,
          sql`SELECT a.id, r.note_id, a.mime, a.byte_size::text AS byte_size, a.content_hash, a.storage_key
                FROM attachment_refs r JOIN attachments a ON a.id = r.attachment_id
               WHERE r.note_id = ANY(${pgArray(noteIds)}::uuid[]) AND a.deleted_at IS NULL ORDER BY a.created_at`,
        )
      : [];
    const auditRows = await rows<Record<string, unknown>>(
      tx,
      sql`SELECT at, action, target_type, target_id, outcome, metadata, request_id FROM audit_log
           WHERE actor_id = ${job.user_id} ORDER BY at DESC LIMIT 50000`,
    );

    const byNote = <T extends { note_id: string }>(list: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of list) m.set(x.note_id, [...(m.get(x.note_id) ?? []), x]);
      return m;
    };
    const sharesBy = byNote(shares);
    const commentsBy = byNote(comments);
    const attBy = byNote(attachments);

    const notesJson = {
      format: "bianfa-export",
      version: 1,
      exported_at: new Date().toISOString(),
      user_id: job.user_id,
      scope: job.scope,
      workspaces,
      notes: notes.map((n) => ({
        id: n.id,
        workspace_id: n.workspace_id,
        title: n.title_cache ?? "",
        color: n.color,
        z_mode: n.z_mode,
        schema_version: n.schema_version,
        created_at: iso(n.created_at),
        updated_at: iso(n.updated_at),
        deleted_at: iso(n.deleted_at),
        expires_at: iso(n.expires_at),
        archived_at: iso(n.archived_at),
        content: n.content,
        shares: (sharesBy.get(n.id) ?? []).map((s) => ({
          id: s.id,
          grantee_user_id: s.grantee_user_id,
          permission: s.perm,
          created_at: iso(s.created_at),
          expires_at: iso(s.expires_at),
        })),
        comments: (commentsBy.get(n.id) ?? []).map((cm) => ({
          id: cm.id,
          author_id: cm.author_id,
          body: cm.body,
          created_at: iso(cm.created_at),
        })),
        attachments: (attBy.get(n.id) ?? []).map((a) => a.id),
      })),
    };

    const entries: ZipEntry[] = [{ name: "notes.json", data: JSON.stringify(notesJson, null, 2) }];
    for (const n of notes) {
      let md: string;
      try {
        md = pmJsonToMarkdown(n.content as Parameters<typeof pmJsonToMarkdown>[0], {
          attachmentPath: (id) => `attachments/${id}`,
        });
      } catch {
        md = n.content_text;
      }
      const front = [
        "---",
        `id: ${n.id}`,
        `title: ${JSON.stringify(n.title_cache ?? "")}`,
        `color: ${n.color}`,
        `pinned: ${n.z_mode === 1}`,
        `created: ${iso(n.created_at)}`,
        `updated: ${iso(n.updated_at)}`,
        ...(n.deleted_at ? [`deleted: ${iso(n.deleted_at)}`] : []),
        "---",
        "",
      ].join("\n");
      entries.push({
        name: `notes/${n.id}.md`,
        data: `${front}${md}\n`,
        mtime: toDate(n.updated_at) ?? new Date(),
      });
    }
    entries.push({
      name: "attachments.json",
      data: JSON.stringify(
        attachments.map((a) => ({
          id: a.id,
          note_id: a.note_id,
          mime: a.mime,
          byte_size: num(a.byte_size),
          blake3: Buffer.from(a.content_hash).toString("hex"),
          storage_key: a.storage_key,
        })),
        null,
        2,
      ),
    });
    const header = ["at", "action", "target_type", "target_id", "outcome", "metadata", "request_id"];
    const csv = [header.join(","), ...auditRows.map((r) => header.map((h) => csvCell(r[h])).join(","))].join(
      "\r\n",
    );
    entries.push({ name: "audit_log.csv", data: `${csv}\r\n` });
    entries.push({ name: "ai_history.json", data: "[]\n" });
    return entries;
  }, deps.db);
}

/** 到期的导出：删对象（若有）并标记 expired */
export async function expireExports(deps: WorkerDeps): Promise<number> {
  const due = await withWorkerTx(
    (tx) =>
      rows<{ id: string; storage_key: string | null }>(
        tx,
        sql`SELECT id, storage_key FROM export_jobs WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at < now() LIMIT 200`,
      ),
    deps.db,
  );
  for (const j of due) {
    if (j.storage_key && deps.exportStorage) await deps.exportStorage.delete(j.storage_key).catch(() => {});
    await withWorkerTx(
      (tx) =>
        tx.execute(
          sql`UPDATE export_jobs SET status = 'expired', storage_key = NULL WHERE id = ${j.id}::uuid`,
        ),
      deps.db,
    );
  }
  return due.length;
}
