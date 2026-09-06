// account.purge（每日，规格 04 §7.9）：user.deleted_at 非空且 deletion_due_at < now() →
//   个人 workspace 的 notes / note_updates / snapshots / 附件引用硬删；本人发出的 shares 删除；
//   note_pins / notifications / device / session / account / verification 删除；
//   user 行原地匿名化（name='已删除用户'，email='deleted+<id>@invalid'，image NULL，banned=true）保住团队便笺 created_by / 审计 FK；
//   team workspace 便笺保留；仅剩本人的 org 连带软删（organization.deleted_at 若存在）。
// user 的 deleted_at / deletion_due_at / banned 是 B1 的 additionalFields（迁移 0004）：列缺失时本任务空转并告警，不崩溃。
import { sql } from "drizzle-orm";
import { audit } from "../audit/index.js";
import { withWorkerTx } from "../db/client.js";
import { one, pgArray, rows } from "../services/db-util.js";
import type { WorkerDeps } from "./context.js";

interface UserColumns {
  deletedAt: string | null;
  deletionDueAt: string | null;
  banned: string | null;
  orgDeletedAt: string | null;
}

async function detectColumns(deps: WorkerDeps): Promise<UserColumns> {
  return withWorkerTx(async (tx) => {
    const cols = await rows<{ table_name: string; column_name: string }>(
      tx,
      sql`SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND ((table_name = 'user' AND column_name IN ('deleted_at','deletedAt','deletion_due_at','deletionDueAt','banned'))
             OR (table_name = 'organization' AND column_name IN ('deleted_at','deletedAt')))`,
    );
    const pick = (table: string, ...names: string[]) =>
      cols.find((c) => c.table_name === table && names.includes(c.column_name))?.column_name ?? null;
    return {
      deletedAt: pick("user", "deleted_at", "deletedAt"),
      deletionDueAt: pick("user", "deletion_due_at", "deletionDueAt"),
      banned: pick("user", "banned"),
      orgDeletedAt: pick("organization", "deleted_at", "deletedAt"),
    };
  }, deps.db);
}

export async function purgeAccounts(deps: WorkerDeps, opts: { batch?: number } = {}): Promise<number> {
  const cols = await detectColumns(deps);
  if (!cols.deletedAt || !cols.deletionDueAt) {
    deps.log.warn("account.purge: user.deleted_at / deletion_due_at 列不存在（迁移 0004 未应用），跳过");
    return 0;
  }
  const dueCol = sql.identifier(cols.deletionDueAt);
  const delCol = sql.identifier(cols.deletedAt);
  const batch = Math.min(100, Math.max(1, opts.batch ?? 20));
  const due = await withWorkerTx(
    (tx) =>
      rows<{ id: string }>(
        tx,
        sql`SELECT id FROM "user" WHERE ${delCol} IS NOT NULL AND ${dueCol} IS NOT NULL AND ${dueCol} < now()
              AND email NOT LIKE 'deleted+%@invalid' LIMIT ${batch}`,
      ),
    deps.db,
  );
  let purged = 0;
  for (const u of due) {
    await withWorkerTx(async (tx) => {
      const locked = await one<{ id: string }>(tx, sql`SELECT id FROM "user" WHERE id = ${u.id} FOR UPDATE`);
      if (!locked) return;
      // 个人工作区：便笺硬删（FK CASCADE 带走 updates / snapshots / refs / checklist / comments / shares / pins），附件标记删除
      const personal = await rows<{ id: string }>(
        tx,
        sql`SELECT id FROM workspaces WHERE kind = 'personal' AND owner_user_id = ${u.id}`,
      );
      const wsIds = personal.map((w) => w.id);
      if (wsIds.length) {
        await tx.execute(
          sql`UPDATE attachments SET deleted_at = now() WHERE workspace_id = ANY(${pgArray(wsIds)}::uuid[]) AND deleted_at IS NULL`,
        );
        await tx.execute(sql`DELETE FROM notes WHERE workspace_id = ANY(${pgArray(wsIds)}::uuid[])`);
        await tx.execute(
          sql`UPDATE workspaces SET deleted_at = now(), archived_at = COALESCE(archived_at, now()) WHERE id = ANY(${pgArray(wsIds)}::uuid[])`,
        );
      }
      await tx.execute(sql`DELETE FROM shares WHERE created_by = ${u.id} OR grantee_user_id = ${u.id}`);
      await tx.execute(sql`DELETE FROM note_pins WHERE user_id = ${u.id}`);
      await tx.execute(sql`DELETE FROM notifications WHERE user_id = ${u.id}`);
      await tx.execute(sql`DELETE FROM notification_preferences WHERE user_id = ${u.id}`);
      await tx.execute(sql`DELETE FROM notification_quiet_hours WHERE user_id = ${u.id}`);
      await tx.execute(sql`DELETE FROM claimed_local_ids WHERE user_id = ${u.id}`);
      await tx.execute(sql`DELETE FROM export_jobs WHERE user_id = ${u.id}`);
      await tx.execute(sql`DELETE FROM device WHERE user_id = ${u.id}`);
      await tx.execute(sql`DELETE FROM session WHERE "userId" = ${u.id}`);
      await tx.execute(sql`DELETE FROM account WHERE "userId" = ${u.id}`);
      await tx.execute(
        sql`DELETE FROM verification WHERE identifier IN (SELECT email FROM "user" WHERE id = ${u.id})`,
      );
      // 仅剩本人的 org：软删（列存在时）；本人 member 行标记 removed
      const soloOrgs = await rows<{ id: string }>(
        tx,
        sql`SELECT o.id FROM organization o
             WHERE EXISTS (SELECT 1 FROM member m WHERE m."organizationId" = o.id AND m."userId" = ${u.id})
               AND NOT EXISTS (SELECT 1 FROM member m WHERE m."organizationId" = o.id AND m."userId" <> ${u.id} AND m.status = 'active')`,
      );
      if (cols.orgDeletedAt && soloOrgs.length) {
        await tx.execute(
          sql`UPDATE organization SET ${sql.identifier(cols.orgDeletedAt)} = COALESCE(${sql.identifier(cols.orgDeletedAt)}, now())
               WHERE id = ANY(${pgArray(soloOrgs.map((o) => o.id))}::text[])`,
        );
      }
      await tx.execute(
        sql`UPDATE member SET status = 'removed', removed_at = now(), session_epoch = session_epoch + 1 WHERE "userId" = ${u.id}`,
      );
      await tx.execute(sql`DELETE FROM "teamMember" WHERE "userId" = ${u.id}`);
      // 原地匿名化
      const bannedSet = cols.banned ? sql`, ${sql.identifier(cols.banned)} = true` : sql``;
      await tx.execute(
        sql`UPDATE "user" SET name = '已删除用户', email = ${`deleted+${u.id}@invalid`}, image = NULL, "emailVerified" = false ${bannedSet}
             WHERE id = ${u.id}`,
      );
      await tx.execute(sql`SELECT notify_authz_revoked(${u.id}, 'user', '*')`);
      await audit(tx, {
        action: "account.deleted",
        actorType: "system",
        targetType: "user",
        targetId: u.id,
        metadata: { solo_orgs: soloOrgs.length },
      });
      purged += 1;
    }, deps.db);
  }
  if (purged > 0) deps.log.info({ purged }, "accounts purged");
  return purged;
}
