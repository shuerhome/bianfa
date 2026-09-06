// 服务端 API 薄封装：全部经 api_request（Rust 注入 Bearer），路径集中在这里以便 08-api 出来后替换。
import { apiRequest } from "../ipc/commands.js";
import { IpcError } from "../ipc/errors.js";
import type { NoteColor, ZMode } from "../ipc/types.js";

export interface RemoteNoteSummary {
  id: string;
  workspaceId: string;
  title: string;
  excerpt: string;
  color: NoteColor;
  zMode: ZMode;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  version: number;
  editing?: { userId: string; name: string } | null;
}

export interface NotesPage {
  notes: RemoteNoteSummary[];
  nextVersion: number;
  serverTime?: number;
}

function parseJson<T>(res: { status: number; bodyText: string }): T {
  if (res.status === 426) throw new IpcError("upgrade_required", "需要升级客户端才能继续同步");
  if (res.status < 200 || res.status >= 300)
    throw new IpcError(`http_${res.status}`, res.bodyText.slice(0, 200));
  try {
    return JSON.parse(res.bodyText) as T;
  } catch {
    throw new IpcError("bad_json", "服务端返回了无法解析的内容");
  }
}

/** 便笺发现 / bootstrap（specs/03 §2.6）：since_version 水位分页 */
export async function fetchNotesSince(
  workspaceId: string,
  sinceVersion: number,
  limit = 500,
): Promise<NotesPage> {
  const q = new URLSearchParams({
    workspace_id: workspaceId,
    since_version: String(sinceVersion),
    limit: String(limit),
  });
  const res = await apiRequest({ method: "GET", path: `/v1/notes?${q.toString()}`, timeoutMs: 15_000 });
  return parseJson<NotesPage>(res);
}

/** 团队墙占位：org 下的便笺列表 */
export async function fetchOrgNotes(orgId: string): Promise<RemoteNoteSummary[]> {
  const res = await apiRequest({
    method: "GET",
    path: `/v1/orgs/${encodeURIComponent(orgId)}/notes`,
    timeoutMs: 15_000,
  });
  const page = parseJson<NotesPage | RemoteNoteSummary[]>(res);
  return Array.isArray(page) ? page : page.notes;
}
