// 待办服务（团队待办页）：checklist_items ⋈ notes 的只读聚合，供 GET /todos 与 GET /todos/summary。
// 可见性复用 GET /notes 的工作区判定（services/workspaces.ts getVisibleWorkspace），本文件只在已判定可见的 workspace 内查询；
// 排除软删（deleted_at）/ 硬删（purged_at）/ 归档（archived_at）便笺。checklist_items 没有 updated_at，「最近」只能用 notes.updated_at。
// 排序 checked ASC, notes.updated_at DESC, notes.id ASC, ordinal ASC；分页用 keyset 游标（opaque base64url，含微秒精度的时间文本）。
// 不依赖 RLS（集成测试以超级用户连接），可见性全部由应用层 SQL 保证。
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../db/client.js";
import { errors } from "../http/errors.js";
import { iso, num, rows } from "./db-util.js";

export interface TodoRow extends Record<string, unknown> {
  note_id: string;
  title_cache: string | null;
  color: string;
  workspace_id: string;
  created_by: string;
  block_id: string;
  text: string;
  checked: boolean;
  ordinal: number;
  note_updated_at: Date;
  /** notes.updated_at 的 PG 文本形式（微秒精度）；只用于游标往返，JS Date 只有毫秒会丢精度 */
  updated_at_text: string;
}

export interface TodoCursor {
  checked: boolean;
  /** timestamptz 文本，原样 ::timestamptz 回转 */
  updatedAt: string;
  noteId: string;
  ordinal: number;
}

const cursorSchema = z.tuple([z.boolean(), z.string().min(1).max(64), z.uuid(), z.number().int().min(0)]);

export function encodeTodoCursor(c: TodoCursor): string {
  return Buffer.from(JSON.stringify([c.checked, c.updatedAt, c.noteId, c.ordinal]), "utf8").toString(
    "base64url",
  );
}

/** 解不开 / 形状不对 → 400 validation_error（path: cursor），与 zod 校验失败同形 */
export function decodeTodoCursor(raw: string): TodoCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  const r = cursorSchema.safeParse(parsed);
  if (!r.success) throw invalidCursor();
  const [checked, updatedAt, noteId, ordinal] = r.data;
  return { checked, updatedAt, noteId, ordinal };
}

function invalidCursor() {
  return errors.validation([{ path: "cursor", message: "invalid cursor", code: "custom" }]);
}

/** 活跃便笺：未软删、未硬删、未归档 */
const ACTIVE_NOTE = sql`n.deleted_at IS NULL AND n.purged_at IS NULL AND n.archived_at IS NULL`;

export interface ListTodosInput {
  workspaceId: string;
  includeDone: boolean;
  /** 按 notes.created_by 过滤 */
  createdBy?: string | undefined;
  limit: number;
  cursor?: TodoCursor | undefined;
}

export interface TodosPage {
  items: TodoRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

export async function listTodos(tx: Tx, input: ListTodosInput): Promise<TodosPage> {
  const cur = input.cursor;
  const doneClause = input.includeDone ? sql`` : sql`AND ci.checked = false`;
  const byClause = input.createdBy ? sql`AND n.created_by = ${input.createdBy}` : sql``;
  // keyset：与 ORDER BY 完全同序（checked ASC, updated_at DESC, id ASC, ordinal ASC），布尔 false < true
  const cursorClause = cur
    ? sql`AND (ci.checked > ${cur.checked}
           OR (ci.checked = ${cur.checked} AND n.updated_at < ${cur.updatedAt}::timestamptz)
           OR (ci.checked = ${cur.checked} AND n.updated_at = ${cur.updatedAt}::timestamptz AND n.id > ${cur.noteId}::uuid)
           OR (ci.checked = ${cur.checked} AND n.updated_at = ${cur.updatedAt}::timestamptz AND n.id = ${cur.noteId}::uuid
               AND ci.ordinal > ${cur.ordinal}))`
    : sql``;
  const list = await rows<TodoRow>(
    tx,
    sql`SELECT n.id AS note_id, n.title_cache, n.color, n.workspace_id, n.created_by,
               ci.block_id, ci.text, ci.checked, ci.ordinal,
               n.updated_at AS note_updated_at, n.updated_at::text AS updated_at_text
          FROM checklist_items ci
          JOIN notes n ON n.id = ci.note_id
         WHERE n.workspace_id = ${input.workspaceId}::uuid AND ${ACTIVE_NOTE} ${doneClause} ${byClause} ${cursorClause}
         ORDER BY ci.checked ASC, n.updated_at DESC, n.id ASC, ci.ordinal ASC
         LIMIT ${input.limit + 1}`,
  );
  const hasMore = list.length > input.limit;
  const items = hasMore ? list.slice(0, input.limit) : list;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeTodoCursor({
          checked: last.checked,
          updatedAt: last.updated_at_text,
          noteId: last.note_id,
          ordinal: last.ordinal,
        })
      : null;
  return { items, hasMore, nextCursor };
}

export function todoDto(r: TodoRow) {
  return {
    note_id: r.note_id,
    note_title: r.title_cache ?? "",
    note_color: r.color,
    workspace_id: r.workspace_id,
    created_by: r.created_by,
    block_id: r.block_id,
    text: r.text,
    checked: r.checked,
    ordinal: r.ordinal,
    note_updated_at: iso(r.note_updated_at),
  };
}

export interface TodoMemberSummary {
  user_id: string;
  name: string | null;
  open: number;
  done: number;
}

export interface TodoSummary {
  open: number;
  done: number;
  by_member: TodoMemberSummary[];
}

/** 按便笺创建者分组；name 来自 "user"（已删账号 → null）。总数由分组行求和，一条 SQL 保证一致 */
export async function todosSummary(tx: Tx, workspaceId: string): Promise<TodoSummary> {
  const list = await rows<{ user_id: string; name: string | null; open_count: string; done_count: string }>(
    tx,
    sql`SELECT n.created_by AS user_id, u.name,
               count(*) FILTER (WHERE NOT ci.checked) AS open_count,
               count(*) FILTER (WHERE ci.checked) AS done_count
          FROM checklist_items ci
          JOIN notes n ON n.id = ci.note_id
          LEFT JOIN "user" u ON u.id = n.created_by
         WHERE n.workspace_id = ${workspaceId}::uuid AND ${ACTIVE_NOTE}
         GROUP BY n.created_by, u.name
         ORDER BY open_count DESC, done_count DESC, u.name ASC, n.created_by ASC`,
  );
  const by_member = list.map((r) => ({
    user_id: r.user_id,
    name: r.name,
    open: num(r.open_count),
    done: num(r.done_count),
  }));
  let open = 0;
  let done = 0;
  for (const m of by_member) {
    open += m.open;
    done += m.done;
  }
  return { open, done, by_member };
}
