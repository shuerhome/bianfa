// 便笺服务（规格 03 §2.6 发现、04 §6.4 元数据/软删/恢复/硬删/移动）。
// 投影列（content/content_text/color/z_mode/checklist_items）只由 projector 写；这里只写元数据列与 lsn 水位。
// notes.expires_at / archived_at / projected_seq 由迁移 0005 追加，drizzle notes 表对象不含它们，故本文件全部用原生 SQL。
import { sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import type { NotePerm } from "../db/schema/enums.js";
import { errors } from "../http/errors.js";
import { iso, num, one, rows } from "./db-util.js";

export const TRASH_RETENTION_DAYS = 30;

export interface NoteListRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  created_by: string;
  title_cache: string | null;
  content_text: string;
  content: Record<string, unknown>;
  color: string;
  z_mode: number;
  pinned: boolean;
  schema_version: number;
  head_seq: string | number;
  projected_seq: string | number;
  crdt_bytes: number;
  lsn: string | number;
  encryption: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  purge_after: Date | null;
  purged_at: Date | null;
  expires_at: Date | null;
  archived_at: Date | null;
  import_source: string | null;
  import_external_id: string | null;
}

const NOTE_COLUMNS = sql`n.id, n.workspace_id, n.created_by, n.title_cache, n.content_text, n.content, n.color, n.z_mode, n.pinned,
  n.schema_version, n.head_seq, n.projected_seq, n.crdt_bytes, n.lsn, n.encryption, n.created_at, n.updated_at, n.deleted_at,
  n.purge_after, n.purged_at, n.expires_at, n.archived_at, n.import_source, n.import_external_id`;

/** 列表/发现 DTO：不含正文（正文走 WS；列表只读投影列，规格 03 §7） */
export function noteMetaDto(n: NoteListRow, extra: Record<string, unknown> = {}) {
  return {
    id: n.id,
    workspace_id: n.workspace_id,
    created_by: n.created_by,
    title: n.title_cache ?? "",
    excerpt: excerpt(n.content_text),
    color: n.color,
    z_mode: n.z_mode,
    pinned: n.pinned,
    schema_version: n.schema_version,
    head_seq: num(n.head_seq),
    projected_seq: num(n.projected_seq),
    crdt_bytes: n.crdt_bytes,
    version: num(n.lsn),
    encryption: n.encryption,
    created_at: iso(n.created_at),
    updated_at: iso(n.updated_at),
    deleted_at: iso(n.deleted_at),
    purge_after: iso(n.purge_after),
    purged_at: iso(n.purged_at),
    expires_at: iso(n.expires_at),
    archived_at: iso(n.archived_at),
    import_source: n.import_source,
    import_external_id: n.import_external_id,
    ...extra,
  };
}

function excerpt(text: string): string {
  const rest = text.split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim();
  return Array.from(rest).slice(0, 120).join("");
}

/** 发现：workspace 内 lsn > since 的行按 lsn 升序（含墓碑，客户端做 union），返回新水位 */
export async function discoverNotes(
  tx: Tx,
  workspaceId: string,
  sinceVersion: number,
  limit: number,
): Promise<{ notes: NoteListRow[]; nextVersion: number; hasMore: boolean }> {
  const list = await rows<NoteListRow>(
    tx,
    sql`SELECT ${NOTE_COLUMNS} FROM notes n
         WHERE n.workspace_id = ${workspaceId}::uuid AND n.lsn > ${sinceVersion}
         ORDER BY n.lsn ASC LIMIT ${limit + 1}`,
  );
  const hasMore = list.length > limit;
  const page = hasMore ? list.slice(0, limit) : list;
  const last = page[page.length - 1];
  return { notes: page, nextVersion: last ? num(last.lsn) : sinceVersion, hasMore };
}

export async function getNoteRow(tx: Tx, noteId: string): Promise<NoteListRow | undefined> {
  return one<NoteListRow>(tx, sql`SELECT ${NOTE_COLUMNS} FROM notes n WHERE n.id = ${noteId}::uuid`);
}

export interface CreateNoteInput {
  id: string;
  workspaceId: string;
  createdBy: string;
  color?: string | undefined;
  zMode?: number | undefined;
  expiresAt?: Date | null | undefined;
}

/** 幂等建行：同 id 已存在且在同一 workspace → 返回已有行（created=false）；在别的 workspace → 409 */
export async function createNote(
  tx: Tx,
  input: CreateNoteInput,
): Promise<{ note: NoteListRow; created: boolean }> {
  const inserted = await one<{ id: string }>(
    tx,
    sql`INSERT INTO notes (id, workspace_id, created_by, color, z_mode, expires_at, created_at, updated_at)
        VALUES (${input.id}::uuid, ${input.workspaceId}::uuid, ${input.createdBy}, ${input.color ?? "graphite"},
                ${input.zMode ?? 0}, ${input.expiresAt ?? null}, now(), now())
        ON CONFLICT (id) DO NOTHING RETURNING id`,
  );
  const note = await getNoteRow(tx, input.id);
  if (!note) throw new Error("createNote: row vanished");
  if (!inserted && note.workspace_id !== input.workspaceId) throw errors.conflict("note_id_taken");
  return { note, created: Boolean(inserted) };
}

export interface PatchNoteInput {
  color?: string | undefined;
  zMode?: number | undefined;
  expiresAt?: Date | null | undefined;
}

export async function patchNoteMeta(tx: Tx, noteId: string, patch: PatchNoteInput): Promise<NoteListRow> {
  const sets = [];
  if (patch.color !== undefined) sets.push(sql`color = ${patch.color}`);
  if (patch.zMode !== undefined) sets.push(sql`z_mode = ${patch.zMode}`);
  if (patch.expiresAt !== undefined) sets.push(sql`expires_at = ${patch.expiresAt}, archived_at = NULL`);
  if (sets.length > 0) {
    sets.push(sql`lsn = nextval('global_lsn')`, sql`updated_at = now()`);
    await tx.execute(sql`UPDATE notes SET ${sql.join(sets, sql`, `)} WHERE id = ${noteId}::uuid`);
  }
  const row = await getNoteRow(tx, noteId);
  if (!row) throw errors.notFound();
  return row;
}

/** 软删：只写 deleted_at / purge_after 列（CRDT tombstone 是客户端的事） */
export async function softDeleteNote(tx: Tx, noteId: string): Promise<NoteListRow> {
  await tx.execute(
    sql`UPDATE notes SET deleted_at = now(), purge_after = now() + make_interval(days => ${TRASH_RETENTION_DAYS}),
          lsn = nextval('global_lsn'), updated_at = now()
        WHERE id = ${noteId}::uuid AND deleted_at IS NULL`,
  );
  const row = await getNoteRow(tx, noteId);
  if (!row) throw errors.notFound();
  return row;
}

export async function restoreNote(tx: Tx, noteId: string): Promise<NoteListRow> {
  await tx.execute(
    sql`UPDATE notes SET deleted_at = NULL, purge_after = NULL, lsn = nextval('global_lsn'), updated_at = now()
        WHERE id = ${noteId}::uuid AND purged_at IS NULL`,
  );
  const row = await getNoteRow(tx, noteId);
  if (!row) throw errors.notFound();
  return row;
}

/** 立即硬删（规格 03 §6）：删 updates/snapshots/refs/checklist，清投影列，保留墓碑（purged_at） */
export async function purgeNote(tx: Tx, noteId: string): Promise<void> {
  await tx.execute(sql`DELETE FROM note_updates WHERE note_id = ${noteId}::uuid`);
  await tx.execute(sql`DELETE FROM note_snapshots WHERE note_id = ${noteId}::uuid`);
  await tx.execute(sql`DELETE FROM attachment_refs WHERE note_id = ${noteId}::uuid`);
  await tx.execute(sql`DELETE FROM checklist_items WHERE note_id = ${noteId}::uuid`);
  await tx.execute(
    sql`UPDATE notes SET content = '{"type":"doc","content":[]}'::jsonb, content_text = '', crdt_bytes = 0,
          deleted_at = COALESCE(deleted_at, now()), purge_after = COALESCE(purge_after, now()),
          purged_at = now(), lsn = nextval('global_lsn'), updated_at = now()
        WHERE id = ${noteId}::uuid`,
  );
}

export async function moveNote(tx: Tx, noteId: string, targetWorkspaceId: string): Promise<NoteListRow> {
  await tx.execute(
    sql`UPDATE notes SET workspace_id = ${targetWorkspaceId}::uuid, lsn = nextval('global_lsn'), updated_at = now()
        WHERE id = ${noteId}::uuid`,
  );
  const row = await getNoteRow(tx, noteId);
  if (!row) throw errors.notFound();
  return row;
}

/** 同事务内通知发现房间（规格 03 §2.6 ①）：projector / 元数据变更后调用 */
export async function notifyNotesChanged(
  tx: Tx,
  workspaceId: string,
  noteId: string,
  version: number,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_notify('notes_changed', json_build_object('workspace_id', ${workspaceId}::text, 'note_id', ${noteId}::text, 'version', ${version}::bigint)::text)`,
  );
}

export interface ShareRow extends Record<string, unknown> {
  id: string;
  note_id: string;
  grantee_kind: "user" | "link";
  grantee_user_id: string | null;
  grantee_name: string | null;
  grantee_email: string | null;
  perm: NotePerm;
  created_by: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

export async function listShares(tx: Tx, noteId: string): Promise<ShareRow[]> {
  return rows<ShareRow>(
    tx,
    sql`SELECT s.id, s.note_id, s.grantee_kind, s.grantee_user_id, u.name AS grantee_name, u.email AS grantee_email,
               s.perm, s.created_by, s.created_at, s.expires_at, s.revoked_at
          FROM shares s LEFT JOIN "user" u ON u.id = s.grantee_user_id
         WHERE s.note_id = ${noteId}::uuid AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
         ORDER BY s.created_at ASC`,
  );
}

export function shareDto(s: ShareRow) {
  return {
    id: s.id,
    note_id: s.note_id,
    grantee_kind: s.grantee_kind,
    grantee: s.grantee_user_id
      ? { user_id: s.grantee_user_id, name: s.grantee_name, email: s.grantee_email }
      : null,
    permission: s.perm,
    created_by: s.created_by,
    created_at: iso(s.created_at),
    expires_at: iso(s.expires_at),
  };
}

/** 便笺相关的所有用户（owner、org active 成员、share 受让人）——移动/删除时的 authz_revoked 受众 */
export async function noteAudienceUserIds(tx: Tx, noteId: string): Promise<string[]> {
  const r = await rows<{ user_id: string }>(
    tx,
    sql`SELECT w.owner_user_id AS user_id FROM notes n JOIN workspaces w ON w.id = n.workspace_id
         WHERE n.id = ${noteId}::uuid AND w.owner_user_id IS NOT NULL
        UNION
        SELECT m."userId" FROM notes n JOIN workspaces w ON w.id = n.workspace_id
          JOIN member m ON m."organizationId" = w.org_id AND m.status = 'active'
         WHERE n.id = ${noteId}::uuid
        UNION
        SELECT s.grantee_user_id FROM shares s
         WHERE s.note_id = ${noteId}::uuid AND s.grantee_kind = 'user' AND s.revoked_at IS NULL`,
  );
  return r.map((x) => x.user_id).filter((x): x is string => typeof x === "string" && x.length > 0);
}
