// dist/worker.js —— pg-boss 后台任务进程入口（api 镜像，compose 覆盖 command）。
// 只依赖 DATABASE_URL（bianfa_worker，BYPASSRLS）；R2_* / RESEND_API_KEY / MAIL_FROM 缺省即对应功能降级。
// 不开 HTTP 端口、不依赖 Redis（规格 01 §3.4）。SIGTERM → pg-boss 优雅停机（等在跑的 job，≤ 55 s）→ 退出（compose 60 s）。
import { closeDb, getDb } from "./db/client.js";
import { r2ConfigFromEnv } from "./http/env.js";
import { createApiLogger } from "./http/logger.js";
import { consoleMailSender, loadWorkerEnv, type WorkerDeps } from "./jobs/context.js";
import { createBoss, registerJobs } from "./jobs/index.js";
import { createR2Storage } from "./services/storage.js";

const env = loadWorkerEnv();
const log = createApiLogger("worker", env.LOG_LEVEL);
const r2 = r2ConfigFromEnv(env);

const deps: WorkerDeps = {
  db: getDb(),
  log,
  storage: r2 ? createR2Storage(r2) : null,
  exportStorage: r2 ? createR2Storage(r2, r2.exportsBucket) : null,
  // B1 的 MailProvider 就位后在此注入（RESEND_API_KEY + MAIL_FROM）；缺省只记日志
  mail: consoleMailSender(log),
};

const boss = createBoss(env.DATABASE_URL);
boss.on("error", (err) => log.error({ err: (err as Error).message }, "pg-boss error"));
boss.on("warning", (w) => log.warn({ warning: w }, "pg-boss warning"));

await boss.start();
const queues = await registerJobs(boss, deps);
log.info({ queues, storage: r2 ? "r2" : "disabled" }, "worker ready");

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "worker shutting down");
  const hardExit = setTimeout(() => process.exit(0), 58_000);
  hardExit.unref();
  try {
    await boss.stop({ graceful: true, timeout: 55_000 });
  } catch (err) {
    log.warn({ err: (err as Error).message }, "pg-boss stop failed");
  }
  await closeDb().catch(() => {});
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void shutdown(sig));
