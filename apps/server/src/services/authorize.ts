// 授权入口（规格 04 §5.1 / §5.2 / §5.3）：
//   authorizeNote(tx, user, noteId, need)：一条 SQL 同时回答「存在吗 / 有权吗」（effective_note_permission，迁移 0003）；
//   requireOrgRole(tx, user, orgId, minRole)：org 级动作（member 表直查，status='active'）。
// 所有触碰便笺 / 附件的 handler 第一行必须调用 authorizeNote；不允许手写 if (note.userId !== ctx.userId)。
import { sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import type { NotePerm } from "../db/schema/enums.js";
import { AppError, errors } from "../http/errors.js";
import { num, one, toDate } from "./db-util.js";

export const PERM_RANK: Record<NotePerm, number> = { viewer: 0, commenter: 1, editor: 2, manager: 3 };

export function permAtLeast(actual: NotePerm, required: NotePerm): boolean {
  return PERM_RANK[actual] >= PERM_RANK[required];
}

export interface NoteAuth {
  noteId: string;
  perm: NotePerm;
  workspaceId: string;
  workspaceKind: "personal" | "team";
  orgId: string | null;
  teamId: string | null;
  ownerUserId: string | null;
  createdBy: string;
  deletedAt: Date | null;
  purgedAt: Date | null;
  encryption: "server" | "e2ee";
  headSeq: number;
  /** 调用者是否为该 org 的 owner/admin（读团队便笺需审计，04 §4.6） */
  isOrgAdmin: boolean;
}

interface NoteAuthRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  created_by: string;
  deleted_at: Date | null;
  purged_at: Date | null;
  encryption: "server" | "e2ee";
  head_seq: string | number;
  kind: "personal" | "team";
  org_id: string | null;
  team_id: string | null;
  owner_user_id: string | null;
  perm: NotePerm | null;
  org_role: string | null;
}

export interface AuthorizeOptions {
  /** 允许已 purge 的墓碑（默认 410 gone） */
  allowPurged?: boolean;
  /** 允许非 manager 读回收站便笺（默认：deleted_at 非空 → 仅 manager，否则 404） */
  allowDeleted?: boolean;
}

export async function authorizeNote(
  tx: Tx,
  userId: string,
  noteId: string,
  need: NotePerm,
  opts: AuthorizeOptions = {},
): Promise<NoteAuth> {
  const row = await one<NoteAuthRow>(
    tx,
    sql`SELECT n.id, n.workspace_id, n.created_by, n.deleted_at, n.purged_at, n.encryption, n.head_seq,
               w.kind, w.org_id, w.team_id, w.owner_user_id,
               effective_note_permission(${userId}, n.id) AS perm,
               (SELECT m.role FROM member m
                 WHERE m."organizationId" = w.org_id AND m."userId" = ${userId} AND m.status = 'active') AS org_role
          FROM notes n JOIN workspaces w ON w.id = n.workspace_id
         WHERE n.id = ${noteId}::uuid`,
  );
  if (!row || row.perm === null) throw errors.notFound();
  const perm = row.perm;
  if (row.deleted_at && perm !== "manager" && !opts.allowDeleted) throw errors.notFound();
  if (!permAtLeast(perm, need)) {
    throw errors.insufficientPermission(need, { orgId: row.org_id, targetType: "note", targetId: row.id });
  }
  if (row.purged_at && !opts.allowPurged) throw errors.gone("gone");
  return {
    noteId: row.id,
    perm,
    workspaceId: row.workspace_id,
    workspaceKind: row.kind,
    orgId: row.org_id,
    teamId: row.team_id,
    ownerUserId: row.owner_user_id,
    createdBy: row.created_by,
    deletedAt: toDate(row.deleted_at),
    purgedAt: toDate(row.purged_at),
    encryption: row.encryption,
    headSeq: num(row.head_seq),
    isOrgAdmin: row.org_role === "owner" || row.org_role === "admin",
  };
}

export type OrgRole = "owner" | "admin" | "member";
const ROLE_RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };

export interface OrgMembership {
  orgId: string;
  role: OrgRole;
  sessionEpoch: number;
}

/** 非成员 / 非 active → 404（跨租户不暴露存在性）；角色不足 → 403 insufficient_role + authz.denied 审计 */
export async function requireOrgRole(
  tx: Tx,
  userId: string,
  orgId: string,
  minRole: OrgRole,
  required: { resource: string; action: string },
): Promise<OrgMembership> {
  const m = await one<{ role: string; status: string; session_epoch: number }>(
    tx,
    sql`SELECT m.role, m.status, m.session_epoch FROM member m
         WHERE m."organizationId" = ${orgId} AND m."userId" = ${userId}`,
  );
  if (m?.status !== "active") throw errors.notFound();
  const role = (m.role in ROLE_RANK ? m.role : "member") as OrgRole;
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw errors.insufficientRole(required, { orgId, targetType: "organization", targetId: orgId });
  }
  return { orgId, role, sessionEpoch: m.session_epoch };
}

/** 供路由在 403 时把审计上下文交给装配层 */
export function isDenied(err: unknown): err is AppError & { denied: NonNullable<AppError["denied"]> } {
  return err instanceof AppError && err.status === 403 && err.denied !== undefined;
}
