// 便笺路由（规格 04 §6.4 / 03 §2.6 / 08 X5）：
//   GET /notes?workspace_id&since_version&limit（主）与 GET /workspaces/:id/notes（别名，同 handler）
//   GET/POST/PATCH/DELETE /notes/:id、POST /notes/:id/restore、POST /notes/:id/move、GET /notes/:id/views
// 每个便笺 handler 第一行 authorizeNote；note.viewed 审计（同 (actor,note) 30 min 一条，进程内 LRU 去重）。
import { sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { errors } from "../http/errors.js";
import { isoDateTime, listLimit, noteColor, uuidV7, validate, zMode } from "../http/validate.js";
import { authorizeNote, permAtLeast } from "../services/authorize.js";
import { iso, rows } from "../services/db-util.js";
import {
  createNote,
  discoverNotes,
  listShares,
  moveNote,
  noteAudienceUserIds,
  noteMetaDto,
  notifyNotesChanged,
  patchNoteMeta,
  purgeNote,
  restoreNote,
  shareDto,
  softDeleteNote,
} from "../services/notes.js";
import { getVisibleWorkspace, notifyAuthzRevoked, requireWritableWorkspace } from "../services/workspaces.js";
import { auditIn, type RouteDeps, type RouteEnv, userTx } from "./context.js";

const VIEW_DEDUP_WINDOW_MS = 30 * 60 * 1000;
const VIEW_DEDUP_MAX = 10_000;

/** (actor, note) → 上次记录时间；超过上限时淘汰最旧 */
export class ViewDedup {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly windowMs = VIEW_DEDUP_WINDOW_MS,
    private readonly max = VIEW_DEDUP_MAX,
  ) {}
  shouldRecord(userId: string, noteId: string, now = Date.now()): boolean {
    const key = `${userId}:${noteId}`;
    const last = this.seen.get(key);
    if (last !== undefined && now - last < this.windowMs) return false;
    this.seen.delete(key);
    this.seen.set(key, now);
    if (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}

const discoveryQuery = z
  .object({
    workspace_id: uuidV7,
    since_version: z.coerce.number().int().min(0).default(0),
    limit: listLimit,
  })
  .strict();
const aliasQuery = z
  .object({ since_version: z.coerce.number().int().min(0).default(0), limit: listLimit })
  .strict();
const idParam = z.object({ id: uuidV7 }).strict();
const createSchema = z
  .object({
    id: uuidV7,
    workspace_id: uuidV7,
    /** 客户端安装 id（UUID v4）；只用于幂等/诊断，不入库正文 */
    client_id: z.uuid().optional(),
    color: noteColor.optional(),
    z_mode: zMode.optional(),
    expires_at: isoDateTime.nullable().optional(),
  })
  .strict();
const patchSchema = z
  .object({
    color: noteColor.optional(),
    z_mode: zMode.optional(),
    expires_at: isoDateTime.nullable().optional(),
  })
  .strict();
const deleteQuery = z.object({ purge: z.enum(["true", "false"]).optional() }).strict();
const moveSchema = z.object({ workspace_id: uuidV7 }).strict();

export function noteRoutes(deps: RouteDeps, viewDedup = new ViewDedup()): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();

  async function discover(c: Context<RouteEnv>, workspaceId: string, since: number, limit: number) {
    const result = await userTx(c, deps, async (tx) => {
      const ws = await getVisibleWorkspace(tx, c.var.auth.userId, workspaceId);
      const page = await discoverNotes(tx, workspaceId, since, limit);
      return { ws, page };
    });
    return c.json({
      workspace_id: workspaceId,
      effective_perm: result.ws.perm,
      notes: result.page.notes.map((n) => noteMetaDto(n)),
      next_version: result.page.nextVersion,
      has_more: result.page.hasMore,
    });
  }

  app.get("/notes", validate("query", discoveryQuery), async (c) => {
    const q = c.req.valid("query");
    return discover(c, q.workspace_id, q.since_version, q.limit);
  });

  app.get("/workspaces/:id/notes", validate("param", idParam), validate("query", aliasQuery), async (c) => {
    const q = c.req.valid("query");
    return discover(c, c.req.valid("param").id, q.since_version, q.limit);
  });

  app.post("/notes", validate("json", createSchema), async (c) => {
    const body = c.req.valid("json");
    const result = await userTx(c, deps, async (tx) => {
      const ws = await requireWritableWorkspace(tx, c.var.auth.userId, body.workspace_id);
      const r = await createNote(tx, {
        id: body.id,
        workspaceId: ws.id,
        createdBy: c.var.auth.userId,
        color: body.color,
        zMode: body.z_mode,
        expiresAt:
          body.expires_at === undefined
            ? undefined
            : body.expires_at === null
              ? null
              : new Date(body.expires_at),
      });
      if (r.created) await notifyNotesChanged(tx, ws.id, r.note.id, Number(r.note.lsn));
      return { ...r, perm: ws.perm };
    });
    return c.json(
      { note: noteMetaDto(result.note, { effective_perm: result.perm }) },
      result.created ? 201 : 200,
    );
  });

  app.get("/notes/:id", validate("param", idParam), async (c) => {
    const id = c.req.valid("param").id;
    const out = await userTx(c, deps, async (tx) => {
      const auth = await authorizeNote(tx, c.var.auth.userId, id, "viewer", { allowPurged: true });
      const [note] = await rows<Parameters<typeof noteMetaDto>[0]>(
        tx,
        sql`SELECT n.*, n.lsn AS lsn FROM notes n WHERE n.id = ${id}::uuid`,
      );
      if (!note) throw errors.notFound();
      const shares = await listShares(tx, id);
      const [pin] = await rows<{ always_on_top: boolean; pinned_at: Date }>(
        tx,
        sql`SELECT always_on_top, pinned_at FROM note_pins WHERE user_id = ${c.var.auth.userId} AND note_id = ${id}::uuid`,
      );
      // 管理员读团队便笺每次记审计；其他人 30 min 去重
      const mustAudit =
        auth.isOrgAdmin && auth.workspaceKind === "team" && auth.createdBy !== c.var.auth.userId;
      if (mustAudit || viewDedup.shouldRecord(c.var.auth.userId, id)) {
        await auditIn(tx, c, { action: "note.viewed", orgId: auth.orgId, targetType: "note", targetId: id });
      }
      return { auth, note, shares, pin };
    });
    const full = out.auth.perm === "manager";
    return c.json({
      note: noteMetaDto(out.note, {
        effective_perm: out.auth.perm,
        pin: out.pin ? { always_on_top: out.pin.always_on_top, pinned_at: iso(out.pin.pinned_at) } : null,
        shares_summary: {
          count: out.shares.length,
          kinds: [...new Set(out.shares.map((s) => s.grantee_kind))],
        },
        shares: full ? out.shares.map(shareDto) : undefined,
      }),
    });
  });

  app.patch("/notes/:id", validate("param", idParam), validate("json", patchSchema), async (c) => {
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");
    const out = await userTx(c, deps, async (tx) => {
      const auth = await authorizeNote(tx, c.var.auth.userId, id, "editor");
      const note = await patchNoteMeta(tx, id, {
        color: body.color,
        zMode: body.z_mode,
        expiresAt:
          body.expires_at === undefined
            ? undefined
            : body.expires_at === null
              ? null
              : new Date(body.expires_at),
      });
      await notifyNotesChanged(tx, note.workspace_id, id, Number(note.lsn));
      if (auth.isOrgAdmin && auth.workspaceKind === "team" && auth.createdBy !== c.var.auth.userId) {
        await auditIn(tx, c, {
          action: "note.updated",
          orgId: auth.orgId,
          targetType: "note",
          targetId: id,
          after: body,
        });
      }
      return { auth, note };
    });
    return c.json({ note: noteMetaDto(out.note, { effective_perm: out.auth.perm }) });
  });

  app.delete("/notes/:id", validate("param", idParam), validate("query", deleteQuery), async (c) => {
    const id = c.req.valid("param").id;
    const purge = c.req.valid("query").purge === "true";
    await userTx(c, deps, async (tx) => {
      if (purge) {
        const auth = await authorizeNote(tx, c.var.auth.userId, id, "manager", {
          allowPurged: true,
          allowDeleted: true,
        });
        await purgeNote(tx, id);
        const [row] = await rows<{ lsn: string }>(tx, sql`SELECT lsn FROM notes WHERE id = ${id}::uuid`);
        await notifyNotesChanged(tx, auth.workspaceId, id, Number(row?.lsn ?? 0));
        await notifyAuthzRevoked(tx, await noteAudienceUserIds(tx, id), "note", id);
        await auditIn(tx, c, { action: "note.purged", orgId: auth.orgId, targetType: "note", targetId: id });
        return;
      }
      const auth = await authorizeNote(tx, c.var.auth.userId, id, "editor");
      const note = await softDeleteNote(tx, id);
      await notifyNotesChanged(tx, auth.workspaceId, id, Number(note.lsn));
      await auditIn(tx, c, { action: "note.deleted", orgId: auth.orgId, targetType: "note", targetId: id });
    });
    return c.body(null, 204);
  });

  app.post("/notes/:id/restore", validate("param", idParam), async (c) => {
    const id = c.req.valid("param").id;
    const out = await userTx(c, deps, async (tx) => {
      const auth = await authorizeNote(tx, c.var.auth.userId, id, "manager", {
        allowDeleted: true,
        allowPurged: true,
      });
      if (auth.purgedAt) throw errors.gone("gone");
      const note = await restoreNote(tx, id);
      await notifyNotesChanged(tx, auth.workspaceId, id, Number(note.lsn));
      await auditIn(tx, c, { action: "note.restored", orgId: auth.orgId, targetType: "note", targetId: id });
      return { auth, note };
    });
    return c.json({ note: noteMetaDto(out.note, { effective_perm: out.auth.perm }) });
  });

  app.post("/notes/:id/move", validate("param", idParam), validate("json", moveSchema), async (c) => {
    const id = c.req.valid("param").id;
    const target = c.req.valid("json").workspace_id;
    const out = await userTx(c, deps, async (tx) => {
      const auth = await authorizeNote(tx, c.var.auth.userId, id, "manager");
      const ws = await requireWritableWorkspace(tx, c.var.auth.userId, target);
      if (ws.id === auth.workspaceId) {
        const [n] = await rows<Parameters<typeof noteMetaDto>[0]>(
          tx,
          sql`SELECT n.* FROM notes n WHERE n.id = ${id}::uuid`,
        );
        return { auth, note: n as NonNullable<typeof n>, moved: false };
      }
      const audienceBefore = await noteAudienceUserIds(tx, id);
      const note = await moveNote(tx, id, ws.id);
      await notifyNotesChanged(tx, auth.workspaceId, id, Number(note.lsn));
      await notifyNotesChanged(tx, ws.id, id, Number(note.lsn));
      await notifyAuthzRevoked(
        tx,
        audienceBefore.filter((u) => u !== c.var.auth.userId),
        "note",
        id,
      );
      await auditIn(tx, c, {
        action: "note.moved",
        orgId: auth.orgId ?? ws.org_id,
        targetType: "note",
        targetId: id,
        before: { workspace_id: auth.workspaceId },
        after: { workspace_id: ws.id },
      });
      return { auth, note, moved: true };
    });
    return c.json({ note: noteMetaDto(out.note, { effective_perm: out.auth.perm }), moved: out.moved });
  });

  app.get("/notes/:id/views", validate("param", idParam), async (c) => {
    const id = c.req.valid("param").id;
    const views = await userTx(c, deps, async (tx) => {
      await authorizeNote(tx, c.var.auth.userId, id, "viewer");
      return rows<{ user_id: string; name: string | null; last_viewed_at: Date; views: number }>(
        tx,
        sql`SELECT a.actor_id AS user_id, u.name, max(a.at) AS last_viewed_at, count(*)::int AS views
              FROM audit_log a LEFT JOIN "user" u ON u.id = a.actor_id
             WHERE a.action = 'note.viewed' AND a.target_type = 'note' AND a.target_id = ${id} AND a.actor_id IS NOT NULL
             GROUP BY a.actor_id, u.name ORDER BY max(a.at) DESC LIMIT 200`,
      );
    });
    return c.json({
      views: views.map((v) => ({
        user_id: v.user_id,
        name: v.name,
        last_viewed_at: iso(v.last_viewed_at),
        count: v.views,
      })),
    });
  });

  return app;
}

export { permAtLeast };
