// dist/migrate.js —— 生产迁移入口（deploy.sh 用 `compose run --rm api node dist/migrate.js` 以超级用户直连执行）。
// 迁移目录相对本文件解析：src/migrate.ts 与 dist/migrate.js 都位于 apps/server 下一级，因此 ../drizzle 两处都成立。
import { fileURLToPath } from "node:url";
import { loadBaseEnv, normalizeEnv } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createLogger } from "./log.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle", import.meta.url));

async function main(): Promise<void> {
  const raw = normalizeEnv(process.env);
  const url = raw.MIGRATE_DATABASE_URL ?? raw.DATABASE_URL_DIRECT ?? raw.DATABASE_URL;
  const env = loadBaseEnv({ ...raw, DATABASE_URL: url ?? "" });
  const logger = createLogger({ name: "migrate" }, env.LOG_LEVEL);
  if (!url) throw new Error("需要 MIGRATE_DATABASE_URL / DATABASE_URL_DIRECT / DATABASE_URL 之一");
  const target = url.replace(/\/\/[^@]*@/, "//***@");
  logger.info({ target, migrationsDir: MIGRATIONS_DIR }, "running migrations");
  const result = await runMigrations(url, { migrationsFolder: MIGRATIONS_DIR, logger });
  logger.info(result, "migrations done");
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: "error", msg: "migration failed", err: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
