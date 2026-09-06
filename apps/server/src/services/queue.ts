// 入队接缝：api 进程只需要 send（export.build / mail.send）；worker 进程持完整 pg-boss（src/worker.ts）。
// pg-boss 12：队列必须先 createQueue 才能 send；schema 固定 'pgboss'（与 worker 一致）；api 侧不做 supervise/schedule。
// pg-boss 不可用（schema 未装 / 权限不足）→ send 抛错，路由映射为 503 queue_unavailable。
import { PgBoss } from "pg-boss";
import type { Logger } from "pino";

export const PGBOSS_SCHEMA = "pgboss";

export const QUEUES = {
  noteProject: "note.project",
  noteReprojectAll: "note.reproject_all",
  notePurge: "note.purge",
  noteExpire: "note.expire",
  attachmentsGc: "attachments.gc",
  exportBuild: "export.build",
  accountPurge: "account.purge",
  mailSend: "mail.send",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface SendOptions {
  singletonKey?: string;
  singletonSeconds?: number;
  startAfter?: number | Date;
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  expireInSeconds?: number;
}

export interface JobQueue {
  send(name: QueueName, data: Record<string, unknown>, opts?: SendOptions): Promise<string | null>;
  close(): Promise<void>;
}

export function createPgBossQueue(connectionString: string, log: Logger): JobQueue {
  let boss: PgBoss | undefined;
  let starting: Promise<PgBoss> | undefined;
  const created = new Set<string>();

  async function get(): Promise<PgBoss> {
    if (boss) return boss;
    if (!starting) {
      starting = (async () => {
        const b = new PgBoss({
          connectionString,
          schema: PGBOSS_SCHEMA,
          max: 2,
          supervise: false,
          schedule: false,
          application_name: "bianfa-api",
        });
        b.on("error", (err) => log.warn({ err: (err as Error).message }, "pg-boss (api) error"));
        await b.start();
        boss = b;
        return b;
      })().finally(() => {
        starting = undefined;
      });
    }
    return starting;
  }

  return {
    async send(name, data, opts = {}) {
      const b = await get();
      if (!created.has(name)) {
        await b.createQueue(name);
        created.add(name);
      }
      return b.send(name, data, opts);
    },
    async close() {
      const b = boss;
      boss = undefined;
      if (b) await b.stop({ graceful: false, timeout: 2000 });
    },
  };
}

/** 测试 / 无队列环境：把 send 记录下来 */
export function createMemoryQueue(): JobQueue & {
  sent: { name: string; data: Record<string, unknown>; opts?: SendOptions }[];
} {
  const sent: { name: string; data: Record<string, unknown>; opts?: SendOptions }[] = [];
  return {
    sent,
    async send(name, data, opts) {
      sent.push(opts ? { name, data, opts } : { name, data });
      return `mem-${sent.length}`;
    },
    async close() {},
  };
}
