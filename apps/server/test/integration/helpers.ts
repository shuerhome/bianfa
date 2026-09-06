// 集成测试公共工具：DSN 解析、非超级用户 RLS 测试角色、清表。
// 契约（backend.yml 头）：优先读环境变量 DATABASE_URL / DATABASE_DIRECT_URL（/ DATABASE_URL_DIRECT），不自起容器。
import pg from "pg";
import { createDb, createPool, type Db } from "../../src/db/client.js";
import { uuidv7 } from "../../src/db/ids.js";
import { user, workspaces } from "../../src/db/schema/index.js";

/** 业务连接（CI 里经 PgBouncer） */
export const POOLED_URL = process.env.DATABASE_URL;
/** 直连（迁移 / 建角色 / LISTEN / 换用户身份连接） */
export const DIRECT_URL = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_DIRECT_URL ?? POOLED_URL;
export const hasDb = Boolean(POOLED_URL && DIRECT_URL);

/** 规格 01 §11-8：RLS 活性必须用 NOSUPERUSER NOBYPASSRLS 的非 owner 角色断言，不能用 DATABASE_URL 的超级用户 */
export const RLS_ROLE = "bianfa_rls_test";
export const RLS_PASSWORD = "bianfa-rls-test";
/** 模拟 worker：自带 BYPASSRLS 属性的登录角色（BYPASSRLS 不能靠成员关系继承） */
export const WORKER_ROLE = "bianfa_worker_test";
export const WORKER_PASSWORD = "bianfa-worker-test";

export function withCredentials(dsn: string, username: string, password: string): string {
  const u = new URL(dsn);
  u.username = username;
  u.password = password;
  return u.toString();
}

export async function ensureTestRoles(admin: pg.Pool): Promise<void> {
  await admin.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RLS_ROLE}') THEN
        CREATE ROLE ${RLS_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${WORKER_ROLE}') THEN
        CREATE ROLE ${WORKER_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
      END IF;
    END
    $$`);
  await admin.query(`ALTER ROLE ${RLS_ROLE} PASSWORD '${RLS_PASSWORD}'`);
  await admin.query(`ALTER ROLE ${WORKER_ROLE} PASSWORD '${WORKER_PASSWORD}'`);
  await admin.query(`GRANT bianfa_app TO ${RLS_ROLE}`);
  await admin.query(`GRANT bianfa_worker TO ${WORKER_ROLE}`);
}

/** 清空全部业务表（超级用户；CASCADE 连带子表） */
export async function truncateAll(admin: pg.Pool): Promise<void> {
  await admin.query(
    'TRUNCATE "user", organization, device, workspaces, notes, attachments, shares, note_pins RESTART IDENTITY CASCADE',
  );
}

export interface Fixture {
  admin: pg.Pool;
  adminDb: Db;
}

export function openAdmin(): Fixture {
  const admin = createPool(DIRECT_URL as string, { max: 3 });
  return { admin, adminDb: createDb(admin) };
}

/** 建一个用户 + 个人 workspace，返回两者 id */
export async function seedUser(db: Db, userId: string, name = userId): Promise<{ userId: string; workspaceId: string }> {
  await db.insert(user).values({ id: userId, name, email: `${userId}@test.invalid` });
  const workspaceId = uuidv7();
  await db.insert(workspaces).values({ id: workspaceId, kind: "personal", ownerUserId: userId, name: `${name} 的便笺` });
  return { userId, workspaceId };
}
