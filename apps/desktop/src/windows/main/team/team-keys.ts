// 团队页的 TanStack Query key（全部远端数据；不走 db:changed 失效，靠 mutation 后手动 invalidate / 刷新按钮）。
export const teamKeys = {
  orgs: ["team", "orgs"] as const,
  org: (orgId: string) => ["team", orgId, "org"] as const,
  members: (orgId: string) => ["team", orgId, "members"] as const,
  invites: (orgId: string) => ["team", orgId, "invites"] as const,
  workspaces: (orgId: string) => ["team", orgId, "workspaces"] as const,
  workspaceNotes: (workspaceId: string) => ["team", "workspace", workspaceId, "notes"] as const,
  sharedWithMe: ["team", "shared-with-me"] as const,
  shares: (noteId: string) => ["team", "shares", noteId] as const,
};
