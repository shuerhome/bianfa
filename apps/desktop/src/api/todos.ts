// 待办聚合（服务端 GET /v1/todos、GET /v1/todos/summary）：checklist_items 按当前用户可见便笺聚合。
//   GET /v1/todos?workspace_id&include_done&created_by&limit&cursor
//     → { items: TodoDto[], next_cursor, has_more, server_time }
//   GET /v1/todos/summary?workspace_id → { open, done, by_member: [{ user_id, name, open, done }] }
import type { NoteColor } from "../ipc/types.js";
import { apiJson, isoToMsOr } from "./http.js";

/** 服务端行原样（snake_case） */
export interface RemoteTodoDto {
  note_id: string;
  note_title: string | null;
  note_color: NoteColor;
  workspace_id: string;
  created_by: string;
  block_id: string;
  text: string;
  checked: boolean;
  ordinal: number;
  note_updated_at: string | number | null;
}

export interface RemoteTodoItem {
  noteId: string;
  noteTitle: string;
  noteColor: NoteColor;
  workspaceId: string;
  createdBy: string;
  blockId: string;
  text: string;
  checked: boolean;
  ordinal: number;
  noteUpdatedAt: number;
}

export interface RemoteTodosPage {
  items: RemoteTodoItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface FetchTodosOptions {
  workspaceId?: string | undefined;
  /** 缺省（服务端默认）只返回未完成 */
  includeDone?: boolean | undefined;
  createdBy?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface TodosMemberSummary {
  userId: string;
  name: string | null;
  open: number;
  done: number;
}

export interface TodosSummary {
  open: number;
  done: number;
  byMember: TodosMemberSummary[];
}

export function mapRemoteTodo(d: RemoteTodoDto): RemoteTodoItem {
  return {
    noteId: d.note_id,
    noteTitle: d.note_title ?? "",
    noteColor: d.note_color,
    workspaceId: d.workspace_id,
    createdBy: d.created_by,
    blockId: d.block_id,
    text: d.text ?? "",
    checked: Boolean(d.checked),
    ordinal: d.ordinal,
    noteUpdatedAt:
      typeof d.note_updated_at === "number" ? d.note_updated_at : isoToMsOr(d.note_updated_at, 0),
  };
}

/** 游标翻页：hasMore 为 true 时把 nextCursor 传回 cursor */
export async function fetchTodos(opts: FetchTodosOptions = {}): Promise<RemoteTodosPage> {
  const r = await apiJson<{ items: RemoteTodoDto[]; next_cursor: string | null; has_more: boolean }>(
    "GET",
    "/v1/todos",
    {
      query: {
        workspace_id: opts.workspaceId,
        include_done: opts.includeDone ? "true" : undefined,
        created_by: opts.createdBy,
        limit: opts.limit,
        cursor: opts.cursor,
      },
    },
  );
  return {
    items: (r.items ?? []).map(mapRemoteTodo),
    nextCursor: r.next_cursor ?? null,
    hasMore: Boolean(r.has_more),
  };
}

export async function fetchTodosSummary(workspaceId?: string): Promise<TodosSummary> {
  const r = await apiJson<{
    open: number;
    done: number;
    by_member: { user_id: string; name: string | null; open: number; done: number }[];
  }>("GET", "/v1/todos/summary", { query: { workspace_id: workspaceId } });
  return {
    open: r.open ?? 0,
    done: r.done ?? 0,
    byMember: (r.by_member ?? []).map((m) => ({
      userId: m.user_id,
      name: m.name ?? null,
      open: m.open ?? 0,
      done: m.done ?? 0,
    })),
  };
}
