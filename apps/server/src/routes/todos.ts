// 待办路由（团队待办页）：
//   GET /todos?workspace_id&include_done&created_by&limit&cursor → { items, next_cursor, has_more }
//   GET /todos/summary?workspace_id                             → { open, done, by_member }
// 只读，不记审计。可见性 = GET /notes 的工作区判定（不可见 → 404）；走 userTx 让 RLS 兜底。
import { Hono } from "hono";
import { z } from "zod";
import { authId, listLimit, uuidV7, validate } from "../http/validate.js";
import { decodeTodoCursor, listTodos, todoDto, todosSummary } from "../services/todos.js";
import { getVisibleWorkspace } from "../services/workspaces.js";
import { type RouteDeps, type RouteEnv, userTx } from "./context.js";

const listQuery = z
  .object({
    workspace_id: uuidV7,
    include_done: z.enum(["true", "false"]).default("false"),
    /** 按便笺创建者（notes.created_by）过滤 */
    created_by: authId.optional(),
    limit: listLimit,
    /** 上一页的 next_cursor（opaque） */
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

const summaryQuery = z.object({ workspace_id: uuidV7 }).strict();

export function todoRoutes(deps: RouteDeps): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();

  app.get("/todos", validate("query", listQuery), async (c) => {
    const q = c.req.valid("query");
    const cursor = q.cursor ? decodeTodoCursor(q.cursor) : undefined;
    const page = await userTx(c, deps, async (tx) => {
      await getVisibleWorkspace(tx, c.var.auth.userId, q.workspace_id);
      return listTodos(tx, {
        workspaceId: q.workspace_id,
        includeDone: q.include_done === "true",
        createdBy: q.created_by,
        limit: q.limit,
        cursor,
      });
    });
    return c.json({
      items: page.items.map((r) => todoDto(r)),
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
    });
  });

  app.get("/todos/summary", validate("query", summaryQuery), async (c) => {
    const q = c.req.valid("query");
    const summary = await userTx(c, deps, async (tx) => {
      await getVisibleWorkspace(tx, c.var.auth.userId, q.workspace_id);
      return todosSummary(tx, q.workspace_id);
    });
    return c.json(summary);
  });

  return app;
}
