// 小工具：系统级审计（无用户事务时）、authz_revoked NOTIFY（规格 04 §5.4 / 08 X4）、事务内切换 RLS 身份。
import { sql } from "drizzle-orm";
import { type AuditEntry, audit } from "../audit/index.js";
import type { Db, Tx } from "../db/client.js";

export type AuthzScope = "note" | "org" | "team" | "workspace" | "session" | "user";

/** 写事务末尾调用（同事务）：SELECT notify_authz_revoked(user, scope, id) */
export async function notifyAuthzRevoked(
  tx: Tx,
  userId: string,
  scope: AuthzScope,
  id: string,
): Promise<void> {
  await tx.execute(sql`SELECT notify_authz_revoked(${userId}, ${scope}, ${id})`);
}

/** 不在业务事务里的审计（Better Auth hook 等）：单独一个短事务 */
export async function auditStandalone(db: Db, entry: AuditEntry): Promise<void> {
  await db.transaction((tx) => audit(tx, entry));
}

/**
 * 在同一事务里临时以另一个用户身份执行（RLS 只认 app.user_id）：
 * 例如移除成员时删除「被移除者」名下的 shares —— 管理员身份在 RLS 下看不到那些行。
 * 执行完恢复原身份；异常同样恢复后再抛。
 */
export async function asUser<T>(
  tx: Tx,
  currentUserId: string,
  targetUserId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.execute(sql`SELECT set_config('app.user_id', ${targetUserId}, true)`);
  try {
    return await fn();
  } finally {
    await tx.execute(sql`SELECT set_config('app.user_id', ${currentUserId}, true)`);
  }
}
