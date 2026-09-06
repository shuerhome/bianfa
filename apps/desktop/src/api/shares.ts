// 共享（服务端 src/routes/shares.ts）：GET/PUT /v1/notes/:id/shares、DELETE /v1/notes/:id/shares/:sid、GET /v1/shared-with-me。
import type { NoteColor, ZMode } from "../ipc/types.js";
import { apiJson, isoToMs, isoToMsOr } from "./http.js";
import type { NotePerm } from "./notes.js";

export interface Share {
  id: string;
  noteId: string;
  granteeKind: "user" | "link";
  grantee: { userId: string; name: string | null; email: string | null } | null;
  permission: NotePerm;
  createdBy: string;
  createdAt: number | null;
  expiresAt: number | null;
}

interface ShareDto {
  id: string;
  note_id: string;
  grantee_kind: "user" | "link";
  grantee: { user_id: string; name: string | null; email: string | null } | null;
  permission: NotePerm;
  created_by: string;
  created_at: string;
  expires_at: string | null;
}

export function mapShare(s: ShareDto): Share {
  return {
    id: s.id,
    noteId: s.note_id,
    granteeKind: s.grantee_kind,
    grantee: s.grantee
      ? { userId: s.grantee.user_id, name: s.grantee.name ?? null, email: s.grantee.email ?? null }
      : null,
    permission: s.permission,
    createdBy: s.created_by,
    createdAt: isoToMs(s.created_at),
    expiresAt: isoToMs(s.expires_at),
  };
}

/** GET /v1/notes/:id/shares（manager） */
export async function listShares(noteId: string): Promise<Share[]> {
  const r = await apiJson<{ shares: ShareDto[] }>("GET", `/v1/notes/${encodeURIComponent(noteId)}/shares`);
  return (r.shares ?? []).map(mapShare);
}

export type ShareTarget = { userId: string } | { email: string };

/** PUT /v1/notes/:id/shares（本期只支持 grantee_kind=user；e2ee 便笺 409 vault_not_shareable） */
export async function putShare(
  noteId: string,
  target: ShareTarget,
  permission: NotePerm,
  expiresAt?: number | null,
): Promise<{ share: Share; changed: boolean }> {
  const body: Record<string, unknown> = { grantee_kind: "user", permission };
  if ("userId" in target) body.grantee_id = target.userId;
  else body.email = target.email;
  if (expiresAt !== undefined)
    body.expires_at = expiresAt === null ? null : new Date(expiresAt).toISOString();
  const r = await apiJson<{ share: ShareDto; changed: boolean }>(
    "PUT",
    `/v1/notes/${encodeURIComponent(noteId)}/shares`,
    { body },
  );
  return { share: mapShare(r.share), changed: Boolean(r.changed) };
}

/** DELETE /v1/notes/:id/shares/:sid → 204 */
export async function revokeShare(noteId: string, shareId: string): Promise<void> {
  await apiJson<undefined>(
    "DELETE",
    `/v1/notes/${encodeURIComponent(noteId)}/shares/${encodeURIComponent(shareId)}`,
  );
}

export interface SharedWithMeItem {
  shareId: string;
  noteId: string;
  workspaceId: string;
  title: string;
  color: NoteColor;
  zMode: ZMode;
  permission: NotePerm;
  sharedBy: { userId: string; name: string | null };
  sharedAt: number;
  expiresAt: number | null;
  updatedAt: number;
  version: number;
  pinned: boolean;
}

interface SharedWithMeDto {
  share_id: string;
  note_id: string;
  workspace_id: string;
  title: string;
  color: NoteColor;
  z_mode: ZMode;
  permission: NotePerm;
  shared_by: { user_id: string; name: string | null };
  shared_at: string;
  expires_at: string | null;
  updated_at: string;
  version: number;
  pinned: boolean;
}

/** GET /v1/shared-with-me?cursor&limit → { items, next_cursor } */
export async function fetchSharedWithMe(
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ items: SharedWithMeItem[]; nextCursor: string | null }> {
  const r = await apiJson<{ items: SharedWithMeDto[]; next_cursor: string | null }>(
    "GET",
    "/v1/shared-with-me",
    {
      query: { cursor: opts.cursor, limit: opts.limit },
    },
  );
  return {
    items: (r.items ?? []).map((i) => ({
      shareId: i.share_id,
      noteId: i.note_id,
      workspaceId: i.workspace_id,
      title: i.title ?? "",
      color: i.color,
      zMode: i.z_mode,
      permission: i.permission,
      sharedBy: { userId: i.shared_by.user_id, name: i.shared_by.name ?? null },
      sharedAt: isoToMsOr(i.shared_at, 0),
      expiresAt: isoToMs(i.expires_at),
      updatedAt: isoToMsOr(i.updated_at, 0),
      version: i.version,
      pinned: Boolean(i.pinned),
    })),
    nextCursor: r.next_cursor ?? null,
  };
}
