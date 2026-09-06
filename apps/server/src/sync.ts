// dist/sync.js —— Hocuspocus 同步进程入口（规格 03 §1）。监听 0.0.0.0:$PORT（4000）；/healthz、/metrics 同端口；
// SIGTERM → 停止接受新连接 → flush 所有文档的 onStoreDocument → 关闭连接 → 退出（compose stop_grace_period 30 s）。
import os from "node:os";
import { createDb, createPool } from "./db/client.js";
import { createLogger } from "./log.js";
import { loadSyncEnv, parseAllowedOrigins } from "./sync/env.js";
import { createSyncServer } from "./sync/server.js";

const env = loadSyncEnv();
const logger = createLogger({ name: "sync" }, env.LOG_LEVEL);
const pool = createPool(env.DATABASE_URL, { max: 10 });
const allowedOrigins = parseAllowedOrigins(env.WS_ALLOWED_ORIGINS);

const sync = createSyncServer({
  port: env.PORT,
  address: "0.0.0.0",
  pool,
  db: createDb(pool),
  tokenSecret: env.SYNC_TOKEN_SECRET,
  allowedOrigins,
  directUrl: env.DATABASE_URL_DIRECT,
  redis: env.REDIS_URL ? { url: env.REDIS_URL, identifier: `${os.hostname()}-${process.pid}` } : null,
  logger,
});

const { port } = await sync.listen();
logger.info(
  {
    port,
    redis: Boolean(env.REDIS_URL),
    listen: Boolean(env.DATABASE_URL_DIRECT),
    originCheck: allowedOrigins ? allowedOrigins.size : "off",
  },
  "sync listening",
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down: flushing documents");
  const hard = setTimeout(() => {
    logger.error("shutdown exceeded 29 s; exiting");
    process.exit(1);
  }, 29_000);
  hard.unref();
  try {
    await sync.shutdown({ timeoutMs: 25_000 });
    await pool.end();
    logger.info("sync stopped");
    process.exit(0);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "shutdown failed");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason instanceof Error ? reason.message : String(reason) }, "unhandled rejection");
});
process.on("uncaughtException", (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, "uncaught exception");
  process.exit(1);
});
