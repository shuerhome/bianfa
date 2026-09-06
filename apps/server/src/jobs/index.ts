// pg-boss 12.30 任务注册（schema 'pgboss'，经 DATABASE_URL / PgBouncer；不用 LISTEN/NOTIFY 唤醒，轮询即可）。
//   note.project      {note_id, seq}   singletonKey=note_id（sync-ws 入队）        并发 4
//   note.reproject_all {schema_version?}                                            并发 1
//   note.purge        每日 03:15 UTC   note.expire 每小时 :05   attachments.gc 每日 03:30   account.purge 每日 03:45
//   export.build      {job_id}                                                       并发 1
//   mail.send         {to, template, vars}                                           并发 2
import { PgBoss } from "pg-boss";
import { PGBOSS_SCHEMA, QUEUES } from "../services/queue.js";
import { purgeAccounts } from "./account-purge.js";
import { gcAttachments } from "./attachments-gc.js";
import type { WorkerDeps } from "./context.js";
import { buildExport, type ExportJobData, expireExports } from "./export.js";
import { type ProjectJobData, projectNote, type ReprojectAllData, reprojectAll } from "./project.js";
import { expireNotes, purgeNotes } from "./purge.js";

export interface MailJobData {
  to: string;
  template: string;
  vars?: Record<string, unknown>;
}

export const SCHEDULES: ReadonlyArray<{ name: string; cron: string }> = [
  { name: QUEUES.notePurge, cron: "15 3 * * *" },
  { name: QUEUES.noteExpire, cron: "5 * * * *" },
  { name: QUEUES.attachmentsGc, cron: "30 3 * * *" },
  { name: QUEUES.accountPurge, cron: "45 3 * * *" },
];

export function createBoss(connectionString: string): PgBoss {
  return new PgBoss({
    connectionString,
    schema: PGBOSS_SCHEMA,
    max: 6,
    application_name: "bianfa-worker",
    supervise: true,
    schedule: true,
    // 通过 PgBouncer transaction 模式：不用 LISTEN/NOTIFY 唤醒
    useListenNotify: false,
    monitorVacuum: false,
  });
}

/** 建队列 + 注册 handler + cron；返回已注册的队列名（启动日志 / 测试断言） */
export async function registerJobs(boss: PgBoss, deps: WorkerDeps): Promise<string[]> {
  const log = deps.log;
  const names: string[] = [];

  const queue = async (name: string, opts: Parameters<PgBoss["createQueue"]>[1] = {}) => {
    await boss.createQueue(name, {
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 600,
      ...opts,
    });
    names.push(name);
  };

  await queue(QUEUES.noteProject, { retryLimit: 5, retryDelay: 5 });
  await queue(QUEUES.noteReprojectAll, { retryLimit: 1 });
  await queue(QUEUES.notePurge, { retryLimit: 1, expireInSeconds: 3000 });
  await queue(QUEUES.noteExpire, { retryLimit: 1 });
  await queue(QUEUES.attachmentsGc, { retryLimit: 1, expireInSeconds: 3000 });
  await queue(QUEUES.exportBuild, { retryLimit: 3, retryDelay: 60, expireInSeconds: 1800 });
  await queue(QUEUES.accountPurge, { retryLimit: 1, expireInSeconds: 3000 });
  await queue(QUEUES.mailSend, { retryLimit: 5, retryDelay: 30 });

  await boss.work<ProjectJobData>(
    QUEUES.noteProject,
    { localConcurrency: 4, pollingIntervalSeconds: 1, batchSize: 1 },
    async (jobs) => {
      for (const job of jobs) {
        const r = await projectNote(deps, job.data);
        if (r === "missing") log.warn({ note_id: job.data.note_id }, "note.project: note missing");
      }
    },
  );

  await boss.work<ReprojectAllData>(
    QUEUES.noteReprojectAll,
    { localConcurrency: 1, pollingIntervalSeconds: 5 },
    async (jobs) => {
      for (const job of jobs) {
        await reprojectAll(deps, job.data ?? {}, (data) =>
          boss.send(QUEUES.noteProject, data, { singletonKey: data.note_id, singletonSeconds: 2 }),
        );
      }
    },
  );

  await boss.work(QUEUES.notePurge, { localConcurrency: 1, pollingIntervalSeconds: 10 }, async () => {
    await purgeNotes(deps);
    await expireExports(deps);
  });

  await boss.work(QUEUES.noteExpire, { localConcurrency: 1, pollingIntervalSeconds: 10 }, async () => {
    await expireNotes(deps);
  });

  await boss.work(QUEUES.attachmentsGc, { localConcurrency: 1, pollingIntervalSeconds: 10 }, async () => {
    await gcAttachments(deps);
  });

  await boss.work<ExportJobData>(
    QUEUES.exportBuild,
    { localConcurrency: 1, pollingIntervalSeconds: 2 },
    async (jobs) => {
      for (const job of jobs)
        await buildExport(deps, job.data, {
          ...(process.env.EXPORT_LOCAL_DIR ? { localDir: process.env.EXPORT_LOCAL_DIR } : {}),
        });
    },
  );

  await boss.work(QUEUES.accountPurge, { localConcurrency: 1, pollingIntervalSeconds: 10 }, async () => {
    await purgeAccounts(deps);
  });

  await boss.work<MailJobData>(
    QUEUES.mailSend,
    { localConcurrency: 2, pollingIntervalSeconds: 2 },
    async (jobs) => {
      for (const job of jobs) {
        const d = job.data;
        if (!d?.to || !d.template) throw new Error("mail.send: to/template required");
        if (deps.mail) await deps.mail.send(d.to, d.template, d.vars ?? {});
        else log.info({ template: d.template }, "mail.send skipped (no provider)");
      }
    },
  );

  for (const s of SCHEDULES) {
    await boss.schedule(s.name, s.cron, null, { tz: "UTC", singletonKey: s.name, singletonSeconds: 300 });
  }
  return names;
}
