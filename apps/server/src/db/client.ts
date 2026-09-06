// =============================================================================
// 数据库连接与事务辅助（drizzle-orm 0.45 + node-postgres）
// -----------------------------------------------------------------------------
// PgBouncer transaction 模式的禁忌（规格 01 §5）在这里落实：
//  * 不用 prepared statement：node-postgres 只有在 query 显式传 `name` 时才发 named Parse（跨事务复用）；
//    drizzle 的 node-postgres 驱动只在调用 `.prepare('x')` 时才传 name，普通查询一律 unnamed statement
//    （Parse/Bind/Execute 在同一事务内完成，PgBouncer 可安全路由）。本文件不给任何 query 传 name，
//    业务代码也不得调用 `.prepare()`。
//  * 不设 search_path、不做 session 级 SET；租户上下文只用 `set_config('app.user_id', $1, true)`（= SET LOCAL）
//    且必须在显式事务内 —— 统一走 withUserTx()。
//  * 不在这条连接上 LISTEN（见 direct.ts）。
//  * 不强制 SSL（pg_hba 只有 scram-sha-256，无 TLS；DSN 不带 sslmode）。
// 角色：api / sync-ws 用 bianfa_app（受 RLS）；worker 用 bianfa_worker（BYPASSRLS，规格 02 §9-16），
//       两者都通过 DATABASE_URL 注入，本模块不区分。
// =============================================================================
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { loadBaseEnv } from "../config.js";
import { createLogger } from "../log.js";
import * as schema from "./schema/index.js";

export type Db = NodePgDatabase<typeof schema>;
/** db.transaction 回调拿到的事务句柄类型 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface PoolOptions {
  /** 每进程最大连接数；prod 经 PgBouncer（default_pool_size 25，api ×2 + sync-ws + worker 共用） */
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export function createPool(connectionString: string, opts: PoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 10_000,
    keepAlive: true,
  });
  // 空闲连接被服务端断开（PG 重启、PgBouncer 回收）时 node-postgres 会 emit error；不接会让进程崩溃
  pool.on("error", (err) => {
    createLogger({ name: "db" }).warn({ err: err.message }, "idle pg client error (will reconnect lazily)");
  });
  return pool;
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

let pool: pg.Pool | undefined;
let dbInstance: Db | undefined;

/** 进程级连接池（按 DATABASE_URL 懒建） */
export function getPool(): pg.Pool {
  pool ??= createPool(loadBaseEnv().DATABASE_URL);
  return pool;
}

/** 进程级 drizzle 实例（懒建；避免 import 期就要求 DATABASE_URL） */
export function getDb(): Db {
  dbInstance ??= createDb(getPool());
  return dbInstance;
}

/**
 * 以某个用户身份执行一个显式事务：BEGIN → set_config('app.user_id', userId, true) → fn → COMMIT。
 * GUC 为事务级，COMMIT/ROLLBACK 后自动失效；RLS 策略读 NULLIF(current_setting('app.user_id', true), '')，
 * 未设置即零行（fail-closed）。api / sync-ws 的所有业务读写都必须经此。
 */
export async function withUserTx<T>(
  userId: string,
  fn: (tx: Tx) => Promise<T>,
  db: Db = getDb(),
): Promise<T> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new TypeError("withUserTx: userId 必须是非空字符串");
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/**
 * worker（projector / GC / 邮件 / 结算）用的显式事务：不设任何 GUC。
 * worker 进程以 bianfa_worker（BYPASSRLS）连接，所以不需要伪造用户上下文；单条语句仍受角色级 statement_timeout 60s 约束。
 */
export async function withWorkerTx<T>(fn: (tx: Tx) => Promise<T>, db: Db = getDb()): Promise<T> {
  return db.transaction(fn);
}

/** 优雅退出时调用：排空并关闭进程级连接池 */
export async function closeDb(): Promise<void> {
  const p = pool;
  pool = undefined;
  dbInstance = undefined;
  await p?.end();
}
