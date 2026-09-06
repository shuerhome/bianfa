// 便笺发现 / 元数据（服务端 src/routes/notes.ts + services/notes.ts noteMetaDto）。
//   GET /v1/notes?workspace_id&since_version&limit（主）与 GET /v1/workspaces/:id/notes（别名）
//   → { workspace_id, effective_perm, notes: NoteDto[], next_version, has_more, server_time }
import type { NoteColor, ZMode } from "../ipc/types.js";
import { apiJson, isoToMs, isoToMsOr } from "./http.js";

export type NotePerm = "viewer" | "commenter" | "editor" | "manager";

/** 服务端 noteMetaDto 原样（snake_case） */
export interface RemoteNoteDto {
  id: string;
  workspace_id: string;
  created_by: string;
  title: string;
  excerpt: string;
  color: NoteColor;
  z_mode: ZMode;
  pinned: boolean;
  schema_version: number;
  head_seq: number;
  projected_seq: number;
  crdt_bytes: number;
  version: number;
  encryption: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  purge_after: string | null;
  purged_at: string | null;
  expires_at: string | null;
  archived_at: string | null;
  import_source: string | null;
  import_external_id: string | null;
  effective_perm?: NotePerm;
}

export interface RemoteNoteSummary {
  id: string;
  workspaceId: string;
  createdBy: string;
  title: string;
  excerpt: string;
  color: NoteColor;
  zMode: ZMode;
  pinned: boolean;
  schemaVersion: number;
  headSeq: number;
  projectedSeq: number;
  crdtBytes: number;
  /** 发现水位（notes.lsn） */
  version: number;
  encryption: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  purgeAfter: number | null;
  purgedAt: number | null;
  expiresAt: number | null;
  archivedAt: number | null;
  importSource: string | null;
  importExternalId: string | null;
  effectivePerm: NotePerm | null;
}

export interface NotesPage {
  workspaceId: string;
  effectivePerm: NotePerm | null;
  notes: RemoteNoteSummary[];
  nextVersion: number;
  hasMore: boolean;
  serverTime: number | null;
}

interface DiscoveryResponse {
  workspace_id: string;
  effective_perm?: NotePerm;
  notes: RemoteNoteDto[];
  next_version: number;
  has_more: boolean;
  server_time?: number;
}

export const DISCOVERY_PAGE_LIMIT = 500;

export function mapNote(n: RemoteNoteDto): RemoteNoteSummary {
  const createdAt = isoToMsOr(n.created_at, 0);
  return {
    id: n.id,
    workspaceId: n.workspace_id,
    createdBy: n.created_by,
    title: n.title ?? "",
    excerpt: n.excerpt ?? "",
    color: n.color,
    zMode: n.z_mode,
    pinned: Boolean(n.pinned),
    schemaVersion: n.schema_version,
    headSeq: n.head_seq,
    projectedSeq: n.projected_seq,
    crdtBytes: n.crdt_bytes,
    version: n.version,
    encryption: n.encryption ?? "none",
    createdAt,
    updatedAt: isoToMsOr(n.updated_at, createdAt),
    deletedAt: isoToMs(n.deleted_at),
    purgeAfter: isoToMs(n.purge_after),
    purgedAt: isoToMs(n.purged_at),
    expiresAt: isoToMs(n.expires_at),
    archivedAt: isoToMs(n.archived_at),
    importSource: n.import_source ?? null,
    importExternalId: n.import_external_id ?? null,
    effectivePerm: n.effective_perm ?? null,
  };
}

function mapPage(p: DiscoveryResponse, sinceVersion: number): NotesPage {
  return {
    workspaceId: p.workspace_id,
    effectivePerm: p.effective_perm ?? null,
    notes: (p.notes ?? []).map(mapNote),
    nextVersion: typeof p.next_version === "number" ? p.next_version : sinceVersion,
    hasMore: Boolean(p.has_more),
    serverTime: typeof p.server_time === "number" ? p.server_time : null,
  };
}

/** 便笺发现 / bootstrap（specs/03 §2.6）：since_version 水位分页；含墓碑，客户端做 union */
export async function fetchNotesSince(
  workspaceId: string,
  sinceVersion: number,
  limit = DISCOVERY_PAGE_LIMIT,
): Promise<NotesPage> {
  const page = await apiJson<DiscoveryResponse>("GET", "/v1/notes", {
    query: { workspace_id: workspaceId, since_version: sinceVersion, limit },
  });
  return mapPage(page, sinceVersion);
}

/** 别名：GET /v1/workspaces/:id/notes（团队墙用，同一 handler） */
export async function fetchWorkspaceNotes(
  workspaceId: string,
  sinceVersion = 0,
  limit = DISCOVERY_PAGE_LIMIT,
): Promise<NotesPage> {
  const page = await apiJson<DiscoveryResponse>(
    "GET",
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/notes`,
    { query: { since_version: sinceVersion, limit } },
  );
  return mapPage(page, sinceVersion);
}

/** 拉完一个工作区（按 has_more 翻页；最多 maxPages 页） */
export async function fetchAllWorkspaceNotes(
  workspaceId: string,
  maxPages = 20,
): Promise<{ notes: RemoteNoteSummary[]; version: number; effectivePerm: NotePerm | null }> {
  const notes: RemoteNoteSummary[] = [];
  let since = 0;
  let perm: NotePerm | null = null;
  for (let i = 0; i < maxPages; i += 1) {
    const page = await fetchWorkspaceNotes(workspaceId, since);
    notes.push(...page.notes);
    perm = page.effectivePerm;
    since = page.nextVersion;
    if (!page.hasMore) break;
  }
  return { notes, version: since, effectivePerm: perm };
}

export interface RemoteNoteDetail extends RemoteNoteSummary {
  pin: { alwaysOnTop: boolean; pinnedAt: number | null } | null;
  sharesSummary: { count: number; kinds: string[] } | null;
}

/** GET /v1/notes/:id（viewer 可读；note.viewed 审计由服务端去重） */
export async function fetchNote(noteId: string): Promise<RemoteNoteDetail> {
  const r = await apiJson<{
    note: RemoteNoteDto & {
      pin?: { always_on_top: boolean; pinned_at: string | null } | null;
      shares_summary?: { count: number; kinds: string[] };
    };
  }>("GET", `/v1/notes/${encodeURIComponent(noteId)}`);
  return {
    ...mapNote(r.note),
    pin: r.note.pin
      ? { alwaysOnTop: r.note.pin.always_on_top, pinnedAt: isoToMs(r.note.pin.pinned_at) }
      : null,
    sharesSummary: r.note.shares_summary ?? null,
  };
}

export interface CreateRemoteNoteInput {
  id: string;
  workspaceId: string;
  clientId?: string;
  color?: NoteColor;
  zMode?: ZMode;
  expiresAt?: number | null;
}

/** POST /v1/notes（幂等：已存在 → 200 同一行）；正常情况由 sync-ws 建行，这里只做显式兜底 */
export async function createRemoteNote(input: CreateRemoteNoteInput): Promise<RemoteNoteSummary> {
  const body: Record<string, unknown> = { id: input.id, workspace_id: input.workspaceId };
  if (input.clientId) body.client_id = input.clientId;
  if (input.color) body.color = input.color;
  if (input.zMode !== undefined) body.z_mode = input.zMode;
  if (input.expiresAt !== undefined)
    body.expires_at = input.expiresAt === null ? null : new Date(input.expiresAt).toISOString();
  const r = await apiJson<{ note: RemoteNoteDto }>("POST", "/v1/notes", { body });
  return mapNote(r.note);
}

/** POST /v1/notes/:id/move { workspace_id } */
export async function moveRemoteNote(
  noteId: string,
  workspaceId: string,
): Promise<{ note: RemoteNoteSummary; moved: boolean }> {
  const r = await apiJson<{ note: RemoteNoteDto; moved: boolean }>(
    "POST",
    `/v1/notes/${encodeURIComponent(noteId)}/move`,
    { body: { workspace_id: workspaceId } },
  );
  return { note: mapNote(r.note), moved: Boolean(r.moved) };
}
