// 待办页数据层：本机走 todos_list / todos_counts（key 以 ["notes", …] 开头，db:changed 时随 useDbInvalidation 一起失效）；
// 团队工作区走服务端 GET /v1/todos（游标翻页）+ GET /v1/todos/summary（成员筛选项）。
// 分段过滤与按便笺分组是纯函数，便于测试。
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { fetchTodos, fetchTodosSummary, type RemoteTodosPage } from "../../../api/todos.js";
import { fetchWorkspaces, type RemoteWorkspace } from "../../../api/workspaces.js";
import { notesList, todosCounts, todosList } from "../../../ipc/commands.js";
import type { NoteColor } from "../../../ipc/types.js";

export type Segment = "open" | "done" | "all";
export const SEGMENTS: readonly Segment[] = ["open", "done", "all"];

/** 范围选择器的值："local" = 本机全部便笺；其它 = 团队工作区 id */
export const LOCAL_SCOPE = "local";

/** 本机 TodoItem 与服务端 RemoteTodoItem 的公共子集（列表渲染只用这些字段） */
export interface TodoRowItem {
  noteId: string;
  noteTitle: string;
  noteColor: NoteColor;
  workspaceId: string | null;
  blockId: string;
  text: string;
  checked: boolean;
  ordinal: number;
  noteUpdatedAt: number;
}

export interface TodoGroup {
  noteId: string;
  title: string;
  color: NoteColor;
  workspaceId: string | null;
  /** 按 ordinal 升序 */
  items: TodoRowItem[];
}

export const LOCAL_LIMIT = 2000;
export const REMOTE_PAGE_LIMIT = 200;

export const todoKeys = {
  counts: ["notes", "todos", "counts"] as const,
  local: (includeDone: boolean) => ["notes", "todos", "local", includeDone] as const,
  /** 团队项是否已在本机（决定能否勾选 / 打开） */
  localIds: ["notes", "todos", "local-ids"] as const,
  workspaces: ["todos", "workspaces"] as const,
  remote: (workspaceId: string, includeDone: boolean, createdBy: string | null) =>
    ["todos", "remote", workspaceId, includeDone, createdBy] as const,
  summary: (workspaceId: string) => ["todos", "summary", workspaceId] as const,
};

export const rowKey = (item: Pick<TodoRowItem, "noteId" | "blockId">): string =>
  `${item.noteId}:${item.blockId}`;

export function filterBySegment<T extends { checked: boolean }>(items: readonly T[], segment: Segment): T[] {
  if (segment === "open") return items.filter((i) => !i.checked);
  if (segment === "done") return items.filter((i) => i.checked);
  return [...items];
}

/** 按便笺分组：组顺序 = 首次出现顺序（数据源已按便笺 updatedAt 倒序），组内按 ordinal */
export function groupTodos(items: readonly TodoRowItem[]): TodoGroup[] {
  const groups = new Map<string, TodoGroup>();
  for (const item of items) {
    let g = groups.get(item.noteId);
    if (!g) {
      g = {
        noteId: item.noteId,
        title: item.noteTitle,
        color: item.noteColor,
        workspaceId: item.workspaceId,
        items: [],
      };
      groups.set(item.noteId, g);
    }
    g.items.push(item);
  }
  for (const g of groups.values()) g.items.sort((a, b) => a.ordinal - b.ordinal);
  return [...groups.values()];
}

export const isTeamWorkspace = (w: RemoteWorkspace): boolean => w.kind === "team" && w.archivedAt === null;

// ── hooks ──

export function useTodoCounts() {
  return useQuery({ queryKey: todoKeys.counts, queryFn: todosCounts, staleTime: 5_000 });
}

export function useTeamWorkspaces(loggedIn: boolean) {
  return useQuery({
    queryKey: todoKeys.workspaces,
    queryFn: async () => (await fetchWorkspaces()).filter(isTeamWorkspace),
    enabled: loggedIn,
    staleTime: 60_000,
  });
}

export function useLocalTodos(enabled: boolean, includeDone: boolean) {
  return useQuery({
    queryKey: todoKeys.local(includeDone),
    queryFn: () => todosList({ includeDone, workspaceId: null, limit: LOCAL_LIMIT }),
    enabled,
  });
}

/** 本机已有的便笺 id（团队范围下判断某项能否勾选） */
export function useLocalNoteIds(enabled: boolean) {
  return useQuery({
    queryKey: todoKeys.localIds,
    queryFn: async () => new Set((await notesList({ includeTrashed: false })).map((n) => n.id)),
    enabled,
  });
}

export function useRemoteTodos(workspaceId: string | null, includeDone: boolean, createdBy: string | null) {
  return useInfiniteQuery({
    queryKey: todoKeys.remote(workspaceId ?? "-", includeDone, createdBy),
    queryFn: ({ pageParam }): Promise<RemoteTodosPage> =>
      fetchTodos({
        workspaceId: workspaceId ?? undefined,
        includeDone,
        createdBy: createdBy ?? undefined,
        limit: REMOTE_PAGE_LIMIT,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
    enabled: workspaceId !== null,
    staleTime: 15_000,
  });
}

export function useTodosSummary(workspaceId: string | null) {
  return useQuery({
    queryKey: todoKeys.summary(workspaceId ?? "-"),
    queryFn: () => fetchTodosSummary(workspaceId ?? undefined),
    enabled: workspaceId !== null,
    staleTime: 15_000,
  });
}
