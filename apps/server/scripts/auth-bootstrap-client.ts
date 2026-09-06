// `pnpm --filter @bianfa/server auth:bootstrap`：幂等创建 / 修正公开 OAuth client `bianfa-desktop`（规格 04 §1.4）。
// 读 DATABASE_URL（迁移已跑完）；可在部署脚本里每次启动前执行。
import { pathToFileURL } from "node:url";
import { bootstrapDesktopClient } from "../src/auth/bootstrap-client.js";
import { loadBaseEnv } from "../src/config.js";
import { closeDb, createDb, createPool } from "../src/db/client.js";
import { createLogger } from "../src/log.js";

export async function main(): Promise<void> {
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

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "auth bootstrap failed",
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exitCode = 1;
  });
}
