// 工作区路由（规格 04 §6.4）：GET /workspaces、POST /orgs/:id/workspaces、PATCH/archive/DELETE /workspaces/:id、
// GET /workspaces/:id/notes（发现别名，同 handler 见 notes.ts）。
// team_id / default_note_perm 变更、归档、删除 → 对受影响成员 notify_authz_revoked(scope:'workspace')（04 §5.4 ④）。
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { uuidv7 } from "../db/ids.js";
import type { NotePerm } from "../db/schema/enums.js";
import { errors } from "../http/errors.js";
import { authId, LIMITS, notePerm, uuidV7, validate } from "../http/validate.js";
import { PERM_RANK, requireOrgRole } from "../services/authorize.js";
import { one } from "../services/db-util.js";
import { TRASH_RETENTION_DAYS } from "../services/notes.js";
import {
  activeOrgMemberIds,
  getVisibleWorkspace,
  listVisibleWorkspaces,
  notifyAuthzRevoked,
  type WorkspaceRow,
  workspaceDto,
} from "../services/workspaces.js";
import { auditIn, type RouteDeps, type RouteEnv, userTx } from "./context.js";

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(LIMITS.workspaceNameMax),
    team_id: authId.nullable().optional(),
    default_note_perm: notePerm.optional(),
  })
  .strict();

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(LIMITS.workspaceNameMax).optional(),
    team_id: authId.nullable().optional(),
    default_note_perm: notePerm.optional(),
  })
  .strict();

const idParam = z.object({ id: uuidV7 }).strict();
const orgParam = z.object({ id: authId }).strict();

export function workspaceRoutes(deps: RouteDeps): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();

  app.get("/workspaces", async (c) => {
    const list = await userTx(c, deps, (tx) => listVisibleWorkspaces(tx, c.var.auth.userId));
    return c.json({ workspaces: list.map(workspaceDto) });
  });

  app.post("/orgs/:id/workspaces", validate("param", orgParam), validate("json", createSchema), async (c) => {
    const orgId = c.req.valid("param").id;
    const body = c.req.valid("json");
    const ws = await userTx(c, deps, async (tx) => {
      await requireOrgRole(tx, c.var.auth.userId, orgId, "admin", {
        resource: "workspace",
        action: "create",
      });
      if (body.team_id) {
        const team = await one<{ id: string }>(
          tx,
          sql`SELECT id FROM team WHERE id = ${body.team_id} AND "organizationId" = ${orgId}`,
        );
        if (!team) throw errors.validation([{ path: "team_id", message: "team not in organization" }]);
      }
      const id = uuidv7();
      await tx.execute(
        sql`INSERT INTO workspaces (id, kind, org_id, team_id, name, default_note_perm)
            VALUES (${id}::uuid, 'team', ${orgId}, ${body.team_id ?? null}, ${body.name}, ${body.default_note_perm ?? "editor"}::note_perm)`,
      );
      await auditIn(tx, c, {
        action: "workspace.created",
        orgId,
        targetType: "workspace",
        targetId: id,
        after: {
          name: body.name,
          team_id: body.team_id ?? null,
          default_note_perm: body.default_note_perm ?? "editor",
        },
      });
      return getVisibleWorkspace(tx, c.var.auth.userId, id);
    });
    return c.json({ workspace: workspaceDto(ws) }, 201);
  });

  app.patch("/workspaces/:id", validate("param", idParam), validate("json", patchSchema), async (c) => {
    const id = c.req.valid("param").id;
    const body = c.req.valid("json");
    const ws = await userTx(c, deps, async (tx) => {
      const current = await getVisibleWorkspace(tx, c.var.auth.userId, id);
      if (current.kind === "personal") {
        if (current.owner_user_id !== c.var.auth.userId) throw errors.insufficientPermission("manager");
        if (body.team_id !== undefined || body.default_note_perm !== undefined)
          throw errors.validation([{ path: "team_id", message: "personal workspace only allows name" }]);
      } else {
        await requireOrgRole(tx, c.var.auth.userId, current.org_id as string, "admin", {
          resource: "workspace",
          action: "update",
        });
        if (body.team_id) {
          const team = await one<{ id: string }>(
            tx,
            sql`SELECT id FROM team WHERE id = ${body.team_id} AND "organizationId" = ${current.org_id}`,
          );
          if (!team) throw errors.validation([{ path: "team_id", message: "team not in organization" }]);
        }
      }
      const sets = [];
      if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
      if (body.team_id !== undefined) sets.push(sql`team_id = ${body.team_id}`);
      if (body.default_note_perm !== undefined)
        sets.push(sql`default_note_perm = ${body.default_note_perm}::note_perm`);
      if (sets.length > 0) {
        await tx.execute(sql`UPDATE workspaces SET ${sql.join(sets, sql`, `)} WHERE id = ${id}::uuid`);
      }
      const teamChanged = body.team_id !== undefined && body.team_id !== current.team_id;
      const permDowngraded =
        body.default_note_perm !== undefined &&
        PERM_RANK[body.default_note_perm as NotePerm] < PERM_RANK[current.default_note_perm];
      if (current.kind === "team" && (teamChanged || permDowngraded)) {
        const members = await activeOrgMemberIds(tx, current.org_id as string);
        await notifyAuthzRevoked(tx, members, "workspace", id);
      }
      await auditIn(tx, c, {
        action: "workspace.updated",
        orgId: current.org_id,
        targetType: "workspace",
        targetId: id,
        before: {
          name: current.name,
          team_id: current.team_id,
          default_note_perm: current.default_note_perm,
        },
        after: body,
      });
      return getVisibleWorkspace(tx, c.var.auth.userId, id);
    });
    return c.json({ workspace: workspaceDto(ws) });
  });

  app.post("/workspaces/:id/archive", validate("param", idParam), async (c) => {
    const id = c.req.valid("param").id;
    const ws = await userTx(c, deps, async (tx) => {
      const current = await requireTeamAdmin(tx, c.var.auth.userId, id, "archive");
      await tx.execute(
        sql`UPDATE workspaces SET archived_at = COALESCE(archived_at, now()) WHERE id = ${id}::uuid`,
      );
      await notifyAuthzRevoked(tx, await activeOrgMemberIds(tx, current.org_id as string), "workspace", id);
      await auditIn(tx, c, {
        action: "workspace.archived",
        orgId: current.org_id,
        targetType: "workspace",
        targetId: id,
      });
      return getVisibleWorkspace(tx, c.var.auth.userId, id);
    });
    return c.json({ workspace: workspaceDto(ws) });
  });

  app.delete("/workspaces/:id", validate("param", idParam), async (c) => {
    const id = c.req.valid("param").id;
    await userTx(c, deps, async (tx) => {
      const current = await requireTeamAdmin(tx, c.var.auth.userId, id, "delete");
      // 便笺进回收站（30 天后 note.purge 清正文，墓碑保留）；工作区行保留为墓碑
      await tx.execute(
        sql`UPDATE notes SET deleted_at = now(), purge_after = now() + make_interval(days => ${TRASH_RETENTION_DAYS}),
              lsn = nextval('global_lsn'), updated_at = now()
            WHERE workspace_id = ${id}::uuid AND deleted_at IS NULL`,
      );
      await tx.execute(
        sql`UPDATE workspaces SET deleted_at = now(), archived_at = COALESCE(archived_at, now()) WHERE id = ${id}::uuid`,
      );
      await notifyAuthzRevoked(tx, await activeOrgMemberIds(tx, current.org_id as string), "workspace", id);
      await auditIn(tx, c, {
        action: "workspace.deleted",
        orgId: current.org_id,
        targetType: "workspace",
        targetId: id,
      });
    });
    return c.body(null, 204);
  });

  async function requireTeamAdmin(
    tx: Parameters<typeof getVisibleWorkspace>[0],
    userId: string,
    id: string,
    action: string,
  ): Promise<WorkspaceRow> {
    const current = await getVisibleWorkspace(tx, userId, id);
    if (current.kind !== "team") throw errors.conflict("personal_workspace");
    await requireOrgRole(tx, userId, current.org_id as string, "admin", { resource: "workspace", action });
    return current;
  }

  return app;
}
