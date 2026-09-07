// 管理台内部的视图状态放在 /admin 的查询串里（而不是 /admin/users/:id 这样的子路径）。
// 理由：服务端只对 WEB_PAGE_PATHS 里列出的路径回 index.html（apps/server/src/http/web-static.ts），
// 全部视图共用 /admin 一个路径，刷新与后退就都不会 404，也不必为管理台再开一批服务端路由。
//
//   /admin                                   用户列表
//   /admin?tab=audit                         审计
//   /admin?user=<id>                         用户详情
//   /admin?user=<id>&view=content            该用户能看到的工作区
//   /admin?user=<id>&view=content&ws=<wsId>  某个工作区里的便笺
//   …&note=<noteId>                          便笺正文

export interface AdminRoute {
  tab: "users" | "audit";
  userId: string | null;
  /** 用户详情下的「查看内容」分区 */
  content: boolean;
  workspaceId: string | null;
  noteId: string | null;
}

export function parseAdminRoute(search: string): AdminRoute {
  const q = new URLSearchParams(search);
  const userId = q.get("user");
  if (userId) {
    const content = q.get("view") === "content";
    return {
      tab: "users",
      userId,
      content,
      workspaceId: content ? q.get("ws") : null,
      noteId: content ? q.get("note") : null,
    };
  }
  return {
    tab: q.get("tab") === "audit" ? "audit" : "users",
    userId: null,
    content: false,
    workspaceId: null,
    noteId: null,
  };
}

export function adminUrl(route: Partial<AdminRoute>): string {
  const q = new URLSearchParams();
  if (route.userId) {
    q.set("user", route.userId);
    if (route.content) {
      q.set("view", "content");
      if (route.workspaceId) q.set("ws", route.workspaceId);
      if (route.noteId) q.set("note", route.noteId);
    }
  } else if (route.tab === "audit") {
    q.set("tab", "audit");
  }
  const s = q.toString();
  return s ? `/admin?${s}` : "/admin";
}
