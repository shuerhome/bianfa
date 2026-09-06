// 钉放（规格 04 §6.4 / 01 C14）：PUT/DELETE /notes/:id/pin —— 只写 note_pins(user_id, note_id, always_on_top)，无坐标。
// 评论（04 §6.4）：POST/GET /notes/:id/comments —— 客户端 UUIDv7，ON CONFLICT DO NOTHING 幂等。
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { LIMITS, uuidV7, validate } from "../http/validate.js";
import { authorizeNote } from "../services/authorize.js";
import { iso, one, rows } from "../services/db-util.js";
import { notify } from "../services/notify.js";
import { type RouteDeps, type RouteEnv, userTx } from "./context.js";

const idParam = z.object({ id: uuidV7 }).strict();
const pinSchema = z.object({ always_on_top: z.boolean().default(false) }).strict();
const commentSchema = z.object({ id: uuidV7, body: z.string().min(1).max(LIMITS.commentMax) }).strict();
const commentsQuery = z
  .object({
    after: uuidV7.optional(),
    limit: z.coerce.number().int().min(1).max(LIMITS.batchMax).default(100),
  })
  .strict();

export function pinRoutes(deps: RouteDeps): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();

  app.put("/notes/:id/pin", validate("param", idParam), validate("json", pinSchema), async (c) => {
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");
    const pin = await userTx(c, deps, async (tx) => {
      await authorizeNote(tx, c.var.auth.userId, id, "viewer");
      return one<{ always_on_top: boolean; pinned_at: Date }>(
        tx,
        sql`INSERT INTO note_pins (user_id, note_id, always_on_top) VALUES (${c.var.auth.userId}, ${id}::uuid, ${body.always_on_top})
            ON CONFLICT (user_id, note_id) DO UPDATE SET always_on_top = EXCLUDED.always_on_top
            RETURNING always_on_top, pinned_at`,
      );
    });
    return c.json({
      pin: { note_id: id, always_on_top: pin?.always_on_top ?? false, pinned_at: iso(pin?.pinned_at) },
    });
  });

  app.delete("/notes/:id/pin", validate("param", idParam), async (c) => {
    const id = c.req.valid("param").id;
    await userTx(c, deps, async (tx) => {
      await authorizeNote(tx, c.var.auth.userId, id, "viewer", { allowDeleted: true, allowPurged: true });
      await tx.execute(
        sql`DELETE FROM note_pins WHERE user_id = ${c.var.auth.userId} AND note_id = ${id}::uuid`,
      );
    });
    return c.body(null, 204);
  });

  app.post("/notes/:id/comments", validate("param", idParam), validate("json", commentSchema), async (c) => {
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");
    const out = await userTx(c, deps, async (tx) => {
      const auth = await authorizeNote(tx, c.var.auth.userId, id, "commenter");
      const inserted = await one<{ id: string }>(
        tx,
        sql`INSERT INTO comments (id, note_id, author_id, body) VALUES (${body.id}::uuid, ${id}::uuid, ${c.var.auth.userId}, ${body.body})
            ON CONFLICT (id) DO NOTHING RETURNING id`,
      );
      const row = await one<{
        id: string;
        note_id: string;
        author_id: string;
        body: string;
        created_at: Date;
      }>(tx, sql`SELECT id, note_id, author_id, body, created_at FROM comments WHERE id = ${body.id}::uuid`);
      if (row && row.note_id !== id) {
        const { errors } = await import("../http/errors.js");
        throw errors.conflict("comment_id_taken");
      }
      if (inserted) {
        // 通知作者（不通知 actor 自己；同便笺 30 s 内合并）
        if (auth.createdBy !== c.var.auth.userId) {
          await notify(tx, {
            userId: auth.createdBy,
            kind: "comment.created",
            actorId: c.var.auth.userId,
            orgId: auth.orgId,
            subjectType: "note",
            subjectId: id,
            groupKey: `note:${id}:comment`,
          });
        }
      }
      return { row, created: Boolean(inserted) };
    });
    const r = out.row;
    return c.json(
      {
        comment: r
          ? {
              id: r.id,
              note_id: r.note_id,
              author_id: r.author_id,
              body: r.body,
              created_at: iso(r.created_at),
            }
          : null,
      },
      out.created ? 201 : 200,
    );
  });

  app.get("/notes/:id/comments", validate("param", idParam), validate("query", commentsQuery), async (c) => {
    const id = c.req.valid("param").id;
    const q = c.req.valid("query");
    const list = await userTx(c, deps, async (tx) => {
      await authorizeNote(tx, c.var.auth.userId, id, "viewer");
      return rows<{
        id: string;
        author_id: string;
        author_name: string | null;
        body: string;
        created_at: Date;
      }>(
        tx,
        sql`SELECT cm.id, cm.author_id, u.name AS author_name, cm.body, cm.created_at
              FROM comments cm LEFT JOIN "user" u ON u.id = cm.author_id
             WHERE cm.note_id = ${id}::uuid AND (${q.after ?? null}::uuid IS NULL OR cm.id > ${q.after ?? null}::uuid)
             ORDER BY cm.id ASC LIMIT ${q.limit + 1}`,
      );
    });
    const hasMore = list.length > q.limit;
    const page = hasMore ? list.slice(0, q.limit) : list;
    return c.json({
      comments: page.map((r) => ({
        id: r.id,
        author: { user_id: r.author_id, name: r.author_name },
        body: r.body,
        created_at: iso(r.created_at),
      })),
      next_after: hasMore ? page[page.length - 1]?.id : null,
    });
  });

  return app;
}
