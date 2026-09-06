// 共享路由（规格 04 §4.6 / §6.4）：GET/PUT /notes/:id/shares、DELETE /notes/:id/shares/:sid、GET /shared-with-me。
// user 受让人按 user id 或 email；e2ee 便笺 409 vault_not_shareable；撤销/降级 → notify_authz_revoked(grantee,'note',noteId)。
// link 类共享为 v1.2，本期 PUT 只接受 grantee_kind='user'。
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { uuidv7 } from "../db/ids.js";
import type { NotePerm } from "../db/schema/enums.js";
import { errors } from "../http/errors.js";
import { authId, emailLower, isoDateTime, notePerm, uuidV7, validate } from "../http/validate.js";
import { authorizeNote, PERM_RANK } from "../services/authorize.js";
import { iso, num, one, rows } from "../services/db-util.js";
import { listShares, type ShareRow, shareDto } from "../services/notes.js";
import { notify } from "../services/notify.js";
import { notifyAuthzRevoked } from "../services/workspaces.js";
import { auditIn, type RouteDeps, type RouteEnv, userTx } from "./context.js";

const idParam = z.object({ id: uuidV7 }).strict();
const shareParam = z.object({ id: uuidV7, sid: uuidV7 }).strict();
const putSchema = z
  .object({
    grantee_kind: z.literal("user"),
    grantee_id: authId.optional(),
    email: emailLower.optional(),
    permission: notePerm,
    expires_at: isoDateTime.nullable().optional(),
  })
  .strict()
  .refine((b) => Boolean(b.grantee_id) !== Boolean(b.email), {
    message: "exactly one of grantee_id / email",
    path: ["grantee_id"],
  });
const inboxQuery = z
  .object({ cursor: uuidV7.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
  .strict();

export function shareRoutes(deps: RouteDeps): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();

  app.get("/notes/:id/shares", validate("param", idParam), async (c) => {
    const id = c.req.valid("param").id;
    const shares = await userTx(c, deps, async (tx) => {
      await authorizeNote(tx, c.var.auth.userId, id, "manager");
      return listShares(tx, id);
    });
    return c.json({ shares: shares.map(shareDto) });
  });

  app.put("/notes/:id/shares", validate("param", idParam), validate("json", putSchema), async (c) => {
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");
    const out = await userTx(c, deps, async (tx) => {
      const auth = await authorizeNote(tx, c.var.auth.userId, id, "manager");
      if (auth.encryption === "e2ee") throw errors.conflict("vault_not_shareable");
      const grantee = body.grantee_id
        ? await one<{ id: string; name: string; email: string }>(
            tx,
            sql`SELECT id, name, email FROM "user" WHERE id = ${body.grantee_id}`,
          )
        : await one<{ id: string; name: string; email: string }>(
            tx,
            sql`SELECT id, name, email FROM "user" WHERE lower(email) = ${body.email as string}`,
          );
      if (!grantee) throw errors.notFound("user_not_found");
      if (grantee.id === c.var.auth.userId)
        throw errors.validation([{ path: "grantee_id", message: "cannot share with yourself" }]);
      const expiresAt = body.expires_at ? new Date(body.expires_at) : null;
      const existing = await one<{ id: string; perm: NotePerm }>(
        tx,
        sql`SELECT id, perm FROM shares WHERE note_id = ${id}::uuid AND grantee_kind = 'user'
              AND grantee_user_id = ${grantee.id} AND revoked_at IS NULL`,
      );
      let shareId: string;
      let changed = false;
      if (existing) {
        shareId = existing.id;
        await tx.execute(
          sql`UPDATE shares SET perm = ${body.permission}::note_perm, expires_at = ${expiresAt} WHERE id = ${shareId}::uuid`,
        );
        changed = existing.perm !== body.permission;
        if (PERM_RANK[body.permission as NotePerm] < PERM_RANK[existing.perm]) {
          await notifyAuthzRevoked(tx, [grantee.id], "note", id);
        }
        await auditIn(tx, c, {
          action: "share.changed",
          orgId: auth.orgId,
          targetType: "share",
          targetId: shareId,
          before: { permission: existing.perm },
          after: { permission: body.permission, grantee_user_id: grantee.id },
        });
      } else {
        shareId = uuidv7();
        await tx.execute(
          sql`INSERT INTO shares (id, note_id, grantee_kind, grantee_user_id, perm, created_by, expires_at)
              VALUES (${shareId}::uuid, ${id}::uuid, 'user', ${grantee.id}, ${body.permission}::note_perm, ${c.var.auth.userId}, ${expiresAt})`,
        );
        await notify(tx, {
          userId: grantee.id,
          kind: "note.shared",
          actorId: c.var.auth.userId,
          orgId: auth.orgId,
          subjectType: "note",
          subjectId: id,
          payload: { permission: body.permission, workspace_id: auth.workspaceId },
          groupKey: `note:${id}:shared`,
        });
        await auditIn(tx, c, {
          action: "share.created",
          orgId: auth.orgId,
          targetType: "share",
          targetId: shareId,
          after: { permission: body.permission, grantee_user_id: grantee.id, note_id: id },
        });
      }
      const [row] = (await listShares(tx, id)).filter((s) => s.id === shareId);
      return { share: row as ShareRow, created: !existing, changed };
    });
    return c.json({ share: shareDto(out.share), changed: out.changed }, out.created ? 201 : 200);
  });

  app.delete("/notes/:id/shares/:sid", validate("param", shareParam), async (c) => {
    const { id, sid } = c.req.valid("param");
    await userTx(c, deps, async (tx) => {
      const auth = await authorizeNote(tx, c.var.auth.userId, id, "manager");
      const share = await one<{ id: string; grantee_user_id: string | null }>(
        tx,
        sql`UPDATE shares SET revoked_at = now() WHERE id = ${sid}::uuid AND note_id = ${id}::uuid AND revoked_at IS NULL
            RETURNING id, grantee_user_id`,
      );
      if (!share) throw errors.notFound();
      if (share.grantee_user_id) await notifyAuthzRevoked(tx, [share.grantee_user_id], "note", id);
      await auditIn(tx, c, {
        action: "share.revoked",
        orgId: auth.orgId,
        targetType: "share",
        targetId: sid,
        before: { grantee_user_id: share.grantee_user_id, note_id: id },
      });
    });
    return c.body(null, 204);
  });

  app.get("/shared-with-me", validate("query", inboxQuery), async (c) => {
    const q = c.req.valid("query");
    const list = await userTx(c, deps, (tx) =>
      rows<{
        share_id: string;
        note_id: string;
        workspace_id: string;
        title_cache: string | null;
        color: string;
        z_mode: number;
        perm: NotePerm;
        shared_by: string;
        shared_by_name: string | null;
        shared_at: Date;
        expires_at: Date | null;
        updated_at: Date;
        version: string;
        pinned: boolean;
      }>(
        tx,
        sql`SELECT s.id AS share_id, n.id AS note_id, n.workspace_id, n.title_cache, n.color, n.z_mode, s.perm,
                   s.created_by AS shared_by, u.name AS shared_by_name, s.created_at AS shared_at, s.expires_at,
                   n.updated_at, n.lsn AS version, (p.note_id IS NOT NULL) AS pinned
              FROM shares s
              JOIN notes n ON n.id = s.note_id AND n.deleted_at IS NULL AND n.purged_at IS NULL
              LEFT JOIN "user" u ON u.id = s.created_by
              LEFT JOIN note_pins p ON p.note_id = n.id AND p.user_id = ${c.var.auth.userId}
             WHERE s.grantee_kind = 'user' AND s.grantee_user_id = ${c.var.auth.userId} AND s.revoked_at IS NULL
               AND (s.expires_at IS NULL OR s.expires_at > now())
               AND (${q.cursor ?? null}::uuid IS NULL OR s.id < ${q.cursor ?? null}::uuid)
             ORDER BY s.id DESC LIMIT ${q.limit + 1}`,
      ),
    );
    const hasMore = list.length > q.limit;
    const page = hasMore ? list.slice(0, q.limit) : list;
    return c.json({
      items: page.map((r) => ({
        share_id: r.share_id,
        note_id: r.note_id,
        workspace_id: r.workspace_id,
        title: r.title_cache ?? "",
        color: r.color,
        z_mode: r.z_mode,
        permission: r.perm,
        shared_by: { user_id: r.shared_by, name: r.shared_by_name },
        shared_at: iso(r.shared_at),
        expires_at: iso(r.expires_at),
        updated_at: iso(r.updated_at),
        version: num(r.version),
        pinned: r.pinned,
      })),
      next_cursor: hasMore ? page[page.length - 1]?.share_id : null,
    });
  });

  return app;
}
