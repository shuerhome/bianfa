// 工作区可见性（规格 04 §6.4「team_id 过滤必须走同一 SQL」附录A-79）与写权限判定。
// 可见 = 个人 owner ∨ (team ∧ active member ∧ (org owner/admin ∨ team_id IS NULL ∨ team_member))。
// 对应 perm：owner / org admin → manager；普通成员 → default_note_perm。deleted_at 非空的工作区对任何人不可见。
// 不依赖 RLS（集成测试以超级用户连接；RLS 只是兜底）。
import { type SQL, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { uuidv7 } from "../db/ids.js";
import type { NotePerm } from "../db/schema/enums.js";
import { errors } from "../http/errors.js";
import { permAtLeast } from "./authorize.js";
import { iso, one, rows } from "./db-util.js";

export interface WorkspaceRow extends Record<string, unknown> {
  id: string;
  kind: "personal" | "team";
  org_id: string | null;
  team_id: string | null;
  owner_user_id: string | null;
  name: string;
  default_note_perm: NotePerm;
  created_at: Date;
  archived_at: Date | null;
  deleted_at: Date | null;
  perm: NotePerm | null;
  org_role: string | null;
}

/** 单一可见性 SQL：所有工作区级判定都从这里出（CTE 名 ws） */
function wsSelect(userId: string): SQL {
  return sql`
  SELECT w.id, w.kind, w.org_id, w.team_id, w.owner_user_id, w.name, w.default_note_perm, w.created_at,
         w.archived_at, w.deleted_at,
         m.role AS org_role,
         CASE
           WHEN w.owner_user_id = ${userId} THEN 'manager'::note_perm
           WHEN w.kind = 'team' AND m.role IN ('owner','admin') THEN 'manager'::note_perm
           WHEN w.kind = 'team' AND m."userId" IS NOT NULL
                AND (w.team_id IS NULL OR EXISTS (SELECT 1 FROM "teamMember" tm WHERE tm."teamId" = w.team_id AND tm."userId" = ${userId}))
             THEN w.default_note_perm
           ELSE NULL
         END AS perm
    FROM workspaces w
    LEFT JOIN member m ON m."organizationId" = w.org_id AND m."userId" = ${userId} AND m.status = 'active'`;
}

/** 用户可见的全部工作区（含已归档；不含已删除），个人在前 */
export async function listVisibleWorkspaces(tx: Tx, userId: string): Promise<WorkspaceRow[]> {
  return rows<WorkspaceRow>(
    tx,
    sql`WITH ws AS (${wsSelect(userId)}) SELECT * FROM ws WHERE ws.deleted_at IS NULL AND ws.perm IS NOT NULL
        ORDER BY (ws.kind = 'personal') DESC, ws.created_at ASC`,
  );
}

/** 单个工作区 + 调用者 perm；不可见 → 404 */
export async function getVisibleWorkspace(
  tx: Tx,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRow> {
  const row = await one<WorkspaceRow>(
    tx,
    sql`WITH ws AS (${wsSelect(userId)}) SELECT * FROM ws WHERE ws.id = ${workspaceId}::uuid AND ws.deleted_at IS NULL`,
  );
  if (!row || row.perm === null) throw errors.notFound();
  return row;
}

/** 可写 = perm ≥ editor 且未归档；否则 403（可见）/ 404（不可见） */
export async function requireWritableWorkspace(
  tx: Tx,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRow> {
  const ws = await getVisibleWorkspace(tx, userId, workspaceId);
  if (!permAtLeast(ws.perm as NotePerm, "editor")) {
    throw errors.insufficientPermission("editor", {
      orgId: ws.org_id,
      targetType: "workspace",
      targetId: ws.id,
    });
  }
  if (ws.archived_at) throw errors.conflict("workspace_archived");
  return ws;
}

export function workspaceDto(w: WorkspaceRow) {
  return {
    id: w.id,
    kind: w.kind,
    org_id: w.org_id,
    team_id: w.team_id,
    owner_user_id: w.owner_user_id,
    name: w.name,
    default_note_perm: w.default_note_perm,
    effective_perm: w.perm,
    created_at: iso(w.created_at),
    archived_at: iso(w.archived_at),
  };
}

/** 个人工作区：不存在则建（claim / 首次登录），返回 id */
export async function ensurePersonalWorkspace(tx: Tx, userId: string, name: string): Promise<string> {
  const existing = await one<{ id: string }>(
    tx,
    sql`SELECT id FROM workspaces WHERE kind = 'personal' AND owner_user_id = ${userId}`,
  );
  if (existing) return existing.id;
  const id = uuidv7();
  await tx.execute(
    sql`INSERT INTO workspaces (id, kind, owner_user_id, name) VALUES (${id}::uuid, 'personal', ${userId}, ${name})
        ON CONFLICT DO NOTHING`,
  );
  const after = await one<{ id: string }>(
    tx,
    sql`SELECT id FROM workspaces WHERE kind = 'personal' AND owner_user_id = ${userId}`,
  );
  return after?.id ?? id;
}

/** 该 org 全部 active 成员 id（用于 workspace 级 authz_revoked 广播） */
export async function activeOrgMemberIds(tx: Tx, orgId: string): Promise<string[]> {
  const r = await rows<{ user_id: string }>(
    tx,
    sql`SELECT m."userId" AS user_id FROM member m WHERE m."organizationId" = ${orgId} AND m.status = 'active'`,
  );
  return r.map((x) => x.user_id);
}

export type RevokeScope = "note" | "org" | "team" | "workspace" | "session" | "user";

/** 写事务末尾调用（规格 04 §5.4；08 X4 scope 集合） */
export async function notifyAuthzRevoked(
  tx: Tx,
  userIds: Iterable<string>,
  scope: RevokeScope,
  id: string,
): Promise<void> {
  for (const uid of new Set(userIds)) {
    await tx.execute(sql`SELECT notify_authz_revoked(${uid}, ${scope}, ${id})`);
  }
}
