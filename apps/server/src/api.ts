// dist/api.js —— HTTP API 进程入口（Hono + @hono/node-server）。
// 监听 0.0.0.0:$PORT（prod 3000）；/healthz 只依赖 DATABASE_URL（经 PgBouncer）；SIGTERM 15 s 内排空退出（规格 01 §2）。
// 只有 DATABASE_URL 必填：其余变量缺省即功能关闭（R2 → 503 attachments_disabled、NOTICE_FILE → 204、REDIS_URL → 进程内限流）。
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createAuth } from "./auth/index.js";
import { closeDb, getDb } from "./db/client.js";
import { loadApiEnv, r2ConfigFromEnv } from "./http/env.js";
import { createApiLogger } from "./http/logger.js";
import { createRateLimiter } from "./http/ratelimit.js";
import { createPgBossQueue } from "./services/queue.js";
import { createR2Storage } from "./services/storage.js";

const env = loadApiEnv();
const log = createApiLogger("api", env.LOG_LEVEL);
const db = getDb();
const auth = await createAuth({
  env: process.env,
  db,
  log,
  ...(env.REDIS_URL ? { redisUrl: env.REDIS_URL } : {}),
});
const rateLimiter = await createRateLimiter(env.REDIS_URL);
const queue = createPgBossQueue(env.DATABASE_URL, log);
const r2 = r2ConfigFromEnv(env);
const storage = r2 ? createR2Storage(r2) : null;

const app = createApp({ auth, db, log, env, queue, storage, rateLimiter });

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: "0.0.0.0" }, (info) => {
  log.info(
    {
      port: info.port,
      attachments: storage ? "r2" : "disabled",
      notice: env.NOTICE_FILE ? "file" : "none",
      redis: env.REDIS_URL ? "on" : "off",
    },
    "api listening",
  );
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "api shutting down");
  const hardExit = setTimeout(() => process.exit(0), 14_000);
  hardExit.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled([auth.close(), queue.close(), rateLimiter.close(), closeDb()]);
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void shutdown(sig));
