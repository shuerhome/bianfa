// dist/auth-bootstrap.js —— 一次性创建/更新桌面端 OAuth 公共客户端 bianfa-desktop（幂等）。
// 生产：infra/vps/auth-bootstrap.sh 用 `compose run --rm api node dist/auth-bootstrap.js` 执行；开发：pnpm auth:bootstrap。
import { bootstrapDesktopClient } from "./auth/bootstrap-client.js";
import { loadBaseEnv } from "./config.js";
import { closeDb, createDb, createPool } from "./db/client.js";
import { createLogger } from "./log.js";

async function main(): Promise<void> {
  const env = loadBaseEnv();
  const logger = createLogger({ name: "auth:bootstrap" }, env.LOG_LEVEL);
  const pool = createPool(env.DATABASE_URL, { max: 2 });
  try {
    const result = await bootstrapDesktopClient(createDb(pool));
    logger.info(result, result.created ? "oauth client created" : "oauth client already present (updated)");
  } finally {
    await pool.end();
    await closeDb();
  }
}

main().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      msg: "auth bootstrap failed",
      err: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
