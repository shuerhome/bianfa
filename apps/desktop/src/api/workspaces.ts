// 工作区（服务端 src/routes/workspaces.ts + services/workspaces.ts workspaceDto）与团队墙数据源。
//   GET /v1/workspaces → { workspaces: WorkspaceDto[] }；团队墙 = org 下未归档 team 工作区的便笺并集
//   （服务端没有 /v1/orgs/:id/notes；便笺按 GET /v1/workspaces/:id/notes 逐工作区拉）。
import { apiJson, isoToMs, isoToMsOr } from "./http.js";
import { fetchAllWorkspaceNotes, type NotePerm, type RemoteNoteSummary } from "./notes.js";

export type WorkspaceKind = "personal" | "team";

export interface WorkspaceDto {
  id: string;
  kind: WorkspaceKind;
  org_id: string | null;
  team_id: string | null;
  owner_user_id: string | null;
  name: string;
  default_note_perm: NotePerm;
  effective_perm: NotePerm | null;
  created_at: string;
  archived_at: string | null;
}

export interface RemoteWorkspace {
  id: string;
  kind: WorkspaceKind;
  orgId: string | null;
  teamId: string | null;
  ownerUserId: string | null;
  name: string;
  defaultNotePerm: NotePerm;
  effectivePerm: NotePerm | null;
  createdAt: number;
  archivedAt: number | null;
}

export function mapWorkspace(w: WorkspaceDto): RemoteWorkspace {
  return {
    id: w.id,
    kind: w.kind,
    orgId: w.org_id ?? null,
    teamId: w.team_id ?? null,
    ownerUserId: w.owner_user_id ?? null,
    name: w.name,
    defaultNotePerm: w.default_note_perm,
    effectivePerm: w.effective_perm ?? null,
    createdAt: isoToMsOr(w.created_at, 0),
    archivedAt: isoToMs(w.archived_at),
  };
}

/** 当前用户可见的全部工作区（个人 + 所在 org 的 team 工作区） */
export async function fetchWorkspaces(): Promise<RemoteWorkspace[]> {
  const r = await apiJson<{ workspaces: WorkspaceDto[] }>("GET", "/v1/workspaces");
  return (r.workspaces ?? []).map(mapWorkspace);
}

export interface TeamWallNote extends RemoteNoteSummary {
  workspaceName: string;
}

export interface TeamWall {
  workspaces: RemoteWorkspace[];
  notes: TeamWallNote[];
}

/** org 内未归档的 team 工作区（团队页「团队工作区」标签的数据源） */
export async function fetchTeamWorkspaces(orgId: string): Promise<RemoteWorkspace[]> {
  const all = await fetchWorkspaces();
  return all.filter((w) => w.kind === "team" && w.orgId === orgId && w.archivedAt === null);
}

/** 一个工作区的活跃便笺（去掉回收站 / 已清除），按更新时间倒序 */
export async function fetchActiveWorkspaceNotes(
  workspaceId: string,
): Promise<{ notes: RemoteNoteSummary[]; effectivePerm: NotePerm | null }> {
  const page = await fetchAllWorkspaceNotes(workspaceId);
  const notes = page.notes
    .filter((n) => n.deletedAt === null && n.purgedAt === null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return { notes, effectivePerm: page.effectivePerm };
}

/** 团队墙：org 内未归档 team 工作区 → 活跃便笺（去掉回收站 / 已清除），按更新时间倒序 */
export async function fetchTeamWall(orgId: string): Promise<TeamWall> {
  const workspaces = await fetchTeamWorkspaces(orgId);
  const pages = await Promise.all(workspaces.map((w) => fetchAllWorkspaceNotes(w.id)));
  const notes: TeamWallNote[] = [];
  pages.forEach((page, i) => {
    const ws = workspaces[i];
    if (!ws) return;
    for (const n of page.notes) {
      if (n.deletedAt !== null || n.purgedAt !== null) continue;
      notes.push({ ...n, workspaceName: ws.name });
    }
  });
  notes.sort((a, b) => b.updatedAt - a.updatedAt);
  return { workspaces, notes };
}

export interface CreateWorkspaceInput {
  name: string;
  teamId?: string | null;
  defaultNotePerm?: NotePerm;
}

/** POST /v1/orgs/:id/workspaces（org admin） */
export async function createTeamWorkspace(
  orgId: string,
  input: CreateWorkspaceInput,
): Promise<RemoteWorkspace> {
  const body: Record<string, unknown> = { name: input.name };
  if (input.teamId !== undefined) body.team_id = input.teamId;
  if (input.defaultNotePerm) body.default_note_perm = input.defaultNotePerm;
  const r = await apiJson<{ workspace: WorkspaceDto }>(
    "POST",
    `/v1/orgs/${encodeURIComponent(orgId)}/workspaces`,
    { body },
  );
  return mapWorkspace(r.workspace);
}

/** PATCH /v1/workspaces/:id（个人工作区只允许改名） */
export async function renameWorkspace(workspaceId: string, name: string): Promise<RemoteWorkspace> {
  const r = await apiJson<{ workspace: WorkspaceDto }>(
    "PATCH",
    `/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    { body: { name } },
  );
  return mapWorkspace(r.workspace);
}
