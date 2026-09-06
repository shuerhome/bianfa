// 通知路由（规格 04 §6.2 / docs/07 §6.4）：GET /notifications、POST /notifications/read、
// GET/PUT /notifications/preferences、PUT /notifications/quiet-hours。全部按 user_id 过滤（表不开 RLS）。
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { authId, LIMITS, validate } from "../http/validate.js";
import { iso, num, one, pgArray, rows } from "../services/db-util.js";
import { type RouteDeps, type RouteEnv, userTx } from "./context.js";

const listQuery = z
  .object({
    cursor: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(LIMITS.batchMax).default(50),
    unread: z.enum(["true", "false"]).optional(),
  })
  .strict();
const readSchema = z
  .object({
    ids: z.array(z.number().int().positive()).max(LIMITS.batchMax).optional(),
    all: z.boolean().optional(),
  })
  .strict()
  .refine((b) => (b.ids?.length ?? 0) > 0 || b.all === true, {
    message: "ids or all required",
    path: ["ids"],
  });
const prefSchema = z
  .object({
    org_id: authId.nullable().default(null),
    kind: z.string().min(1).max(40).default("*"),
    in_app: z.boolean().default(true),
    desktop: z.boolean().default(true),
    email: z.enum(["off", "instant", "digest"]).default("digest"),
  })
  .strict();
const prefsSchema = z.object({ preferences: z.array(prefSchema).min(1).max(50) }).strict();
const quietSchema = z
  .object({
    timezone: z.string().min(1).max(64).default("UTC"),
    start_minute: z.number().int().min(0).max(1439).default(1320),
    end_minute: z.number().int().min(0).max(1439).default(480),
    days_mask: z.number().int().min(0).max(127).default(127),
    dnd_until: z.iso.datetime({ offset: true }).nullable().default(null),
    suppress_desktop: z.boolean().default(true),
    suppress_email: z.boolean().default(false),
  })
  .strict();

interface NotificationRow extends Record<string, unknown> {
  id: string | number;
  org_id: string | null;
  kind: string;
  actor_id: string | null;
  actor_name: string | null;
  subject_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
  group_key: string | null;
  read_at: Date | null;
  seen_at: Date | null;
  created_at: Date;
}

function dto(n: NotificationRow) {
  return {
    id: num(n.id),
    org_id: n.org_id,
    kind: n.kind,
    actor: n.actor_id ? { user_id: n.actor_id, name: n.actor_name } : null,
    subject: { type: n.subject_type, id: n.subject_id },
    payload: n.payload,
    group_key: n.group_key,
    read_at: iso(n.read_at),
    seen_at: iso(n.seen_at),
    created_at: iso(n.created_at),
  };
}

export function notificationRoutes(deps: RouteDeps): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();

  app.get("/notifications", validate("query", listQuery), async (c) => {
    const q = c.req.valid("query");
    const uid = c.var.auth.userId;
    const out = await userTx(c, deps, async (tx) => {
      const list = await rows<NotificationRow>(
        tx,
        sql`SELECT n.id, n.org_id, n.kind, n.actor_id, u.name AS actor_name, n.subject_type, n.subject_id, n.payload,
                   n.group_key, n.read_at, n.seen_at, n.created_at
              FROM notifications n LEFT JOIN "user" u ON u.id = n.actor_id
             WHERE n.user_id = ${uid}
               AND (${q.cursor ?? null}::bigint IS NULL OR n.id < ${q.cursor ?? null}::bigint)
               AND (${q.unread === "true"}::boolean = false OR n.read_at IS NULL)
             ORDER BY n.id DESC LIMIT ${q.limit + 1}`,
      );
      const unread = await one<{ n: number }>(
        tx,
        sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${uid} AND read_at IS NULL`,
      );
      return { list, unread: unread?.n ?? 0 };
    });
    const hasMore = out.list.length > q.limit;
    const page = hasMore ? out.list.slice(0, q.limit) : out.list;
    return c.json({
      notifications: page.map(dto),
      unread_count: out.unread,
      next_cursor: hasMore ? num(page[page.length - 1]?.id) : null,
    });
  });

  app.post("/notifications/read", validate("json", readSchema), async (c) => {
    const body = c.req.valid("json");
    const uid = c.var.auth.userId;
    const updated = await userTx(c, deps, async (tx) => {
      const r = body.all
        ? await rows<{ id: string }>(
            tx,
            sql`UPDATE notifications SET read_at = now(), seen_at = COALESCE(seen_at, now())
                 WHERE user_id = ${uid} AND read_at IS NULL RETURNING id`,
          )
        : await rows<{ id: string }>(
            tx,
            sql`UPDATE notifications SET read_at = now(), seen_at = COALESCE(seen_at, now())
                 WHERE user_id = ${uid} AND read_at IS NULL AND id = ANY(${pgArray(body.ids as number[])}::bigint[]) RETURNING id`,
          );
      return r.length;
    });
    return c.json({ updated });
  });

  app.get("/notifications/preferences", async (c) => {
    const uid = c.var.auth.userId;
    const out = await userTx(c, deps, async (tx) => {
      const prefs = await rows<{
        org_id: string | null;
        kind: string;
        in_app: boolean;
        desktop: boolean;
        email: string;
      }>(
        tx,
        sql`SELECT org_id, kind, in_app, desktop, email FROM notification_preferences WHERE user_id = ${uid} ORDER BY org_id NULLS FIRST, kind`,
      );
      const quiet = await one<Record<string, unknown>>(
        tx,
        sql`SELECT timezone, start_minute, end_minute, days_mask, dnd_until, suppress_desktop, suppress_email
              FROM notification_quiet_hours WHERE user_id = ${uid}`,
      );
      return { prefs, quiet };
    });
    return c.json({
      preferences: out.prefs,
      quiet_hours: out.quiet ? { ...out.quiet, dnd_until: iso(out.quiet.dnd_until) } : null,
    });
  });

  app.put("/notifications/preferences", validate("json", prefsSchema), async (c) => {
    const body = c.req.valid("json");
    const uid = c.var.auth.userId;
    const prefs = await userTx(c, deps, async (tx) => {
      for (const p of body.preferences) {
        await tx.execute(
          sql`INSERT INTO notification_preferences (user_id, org_id, kind, in_app, desktop, email)
              VALUES (${uid}, ${p.org_id}, ${p.kind}, ${p.in_app}, ${p.desktop}, ${p.email})
              ON CONFLICT (user_id, org_id, kind) DO UPDATE SET in_app = EXCLUDED.in_app, desktop = EXCLUDED.desktop, email = EXCLUDED.email`,
        );
      }
      return rows<{ org_id: string | null; kind: string; in_app: boolean; desktop: boolean; email: string }>(
        tx,
        sql`SELECT org_id, kind, in_app, desktop, email FROM notification_preferences WHERE user_id = ${uid} ORDER BY org_id NULLS FIRST, kind`,
      );
    });
    return c.json({ preferences: prefs });
  });

  app.put("/notifications/quiet-hours", validate("json", quietSchema), async (c) => {
    const b = c.req.valid("json");
    const uid = c.var.auth.userId;
    const quiet = await userTx(c, deps, (tx) =>
      one<Record<string, unknown>>(
        tx,
        sql`INSERT INTO notification_quiet_hours (user_id, timezone, start_minute, end_minute, days_mask, dnd_until, suppress_desktop, suppress_email)
            VALUES (${uid}, ${b.timezone}, ${b.start_minute}, ${b.end_minute}, ${b.days_mask}, ${b.dnd_until ? new Date(b.dnd_until) : null},
                    ${b.suppress_desktop}, ${b.suppress_email})
            ON CONFLICT (user_id) DO UPDATE SET timezone = EXCLUDED.timezone, start_minute = EXCLUDED.start_minute,
              end_minute = EXCLUDED.end_minute, days_mask = EXCLUDED.days_mask, dnd_until = EXCLUDED.dnd_until,
              suppress_desktop = EXCLUDED.suppress_desktop, suppress_email = EXCLUDED.suppress_email
            RETURNING timezone, start_minute, end_minute, days_mask, dnd_until, suppress_desktop, suppress_email`,
      ),
    );
    return c.json({ quiet_hours: quiet ? { ...quiet, dnd_until: iso(quiet.dnd_until) } : null });
  });

  return app;
}
