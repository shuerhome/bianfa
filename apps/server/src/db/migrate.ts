// =============================================================================
// db:migrate 入口（`pnpm --filter @bianfa/server db:migrate`）
// -----------------------------------------------------------------------------
// 读 DATABASE_URL：backend.yml 在迁移步骤把它覆盖成直连 5432（CI 超级用户 bianfa）；prod 由运维以超级用户
// postgres 直连执行（规格 01 §5 末条、§11-10）—— 永远不经 PgBouncer。
// 幂等：drizzle 的 migrate() 用 drizzle.__drizzle_migrations 记录已应用项，重复运行是空操作。
// 迁移文件：apps/server/drizzle/（drizzle-kit generate 产出 + 手写 custom migration），整目录进 git。
// 日志 JSON（pino）。
// =============================================================================
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { loadBaseEnv } from "../config.js";
import { createLogger, type Logger } from "../log.js";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export interface MigrateResult {
  /** 本次新应用的迁移数 */
  applied: number;
  /** 库里累计已应用的迁移数 */
  total: number;
}

export interface RunMigrationsOptions {
  migrationsFolder?: string;
  logger?: Logger;
}

/** 用一条直连执行全部未应用的迁移；可重复调用 */
export async function runMigrations(connectionString: string, opts: RunMigrationsOptions = {}): Promise<MigrateResult> {
  const migrationsFolder = opts.migrationsFolder ?? MIGRATIONS_DIR;
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const before = await appliedCount(client);
    await migrate(drizzle(client), { migrationsFolder });
    const total = await appliedCount(client);
    const result = { applied: total - before, total };
    opts.logger?.info({ ...result, migrationsFolder }, result.applied > 0 ? "migrations applied" : "already up to date");
    return result;
  } finally {
    await client.end();
  }
}

async function appliedCount(client: pg.Client): Promise<number> {
  const exists = await client.query<{ ok: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS ok",
  );
  if (!exists.rows[0]?.ok) return 0;
  const r = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations");
  return Number(r.rows[0]?.n ?? 0);
}

/** 日志里只留 host/db，不泄露密码 */
export function describeDsn(dsn: string): string {
  try {
    const u = new URL(dsn);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "<unparseable dsn>";
  }
}

async function main(): Promise<void> {
  const env = loadBaseEnv();
  const logger = createLogger({ name: "db:migrate" }, env.LOG_LEVEL);
  logger.info({ target: describeDsn(env.DATABASE_URL), migrationsDir: MIGRATIONS_DIR }, "running migrations");
  try {
    await runMigrations(env.DATABASE_URL, { logger });
  } catch (err) {
    logger.error({ err: err instanceof Error ? { message: err.message, stack: err.stack } : err }, "migration failed");
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
