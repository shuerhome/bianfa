// worker 进程的依赖与环境（规格 01 §3.4：只有 DATABASE_URL、R2_*、RESEND_API_KEY/MAIL_FROM；没有 REDIS/PORT/SYNC_TOKEN_SECRET）。
// 任务处理函数都是 (deps, data) => Promise 的纯入口，集成测试直接调用，不经 pg-boss。

import type { Logger } from "pino";
import { z } from "zod";
import { baseEnvSchema, loadEnv } from "../config.js";
import type { Db } from "../db/client.js";
import type { ObjectStorage } from "../services/storage.js";

export const workerEnvSchema = baseEnvSchema.extend({
  PUBLIC_API_URL: z.string().url().optional(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ATTACHMENTS_BUCKET: z.string().default("bianfa-attachments"),
  R2_ATTACHMENTS_ACCESS_KEY_ID: z.string().optional(),
  R2_ATTACHMENTS_SECRET_ACCESS_KEY: z.string().optional(),
  R2_EXPORTS_BUCKET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  EXPORT_LOCAL_DIR: z.string().optional(),
});
export type WorkerEnv = z.output<typeof workerEnvSchema>;

export function loadWorkerEnv(raw: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return loadEnv(workerEnvSchema, raw);
}

/** 邮件发送接缝：B1 的 MailProvider.send(to, template, vars) 若存在由 worker.ts 注入；缺省只打日志 */
export interface MailSender {
  send(to: string, template: string, vars: Record<string, unknown>): Promise<void>;
}

export interface WorkerDeps {
  db: Db;
  log: Logger;
  /** 附件桶（GC 删对象）；null = 无 R2 */
  storage: ObjectStorage | null;
  /** 导出桶（可与附件同桶）；null = 落盘到 EXPORT_LOCAL_DIR */
  exportStorage: ObjectStorage | null;
  mail: MailSender | null;
  now?: () => Date;
}

export function nowOf(deps: WorkerDeps): Date {
  return deps.now ? deps.now() : new Date();
}

export function consoleMailSender(log: Logger): MailSender {
  return {
    async send(to, template, vars) {
      // 只记模板名与变量键（不记收件人 / URL）
      log.info(
        { template, vars: Object.keys(vars), to_domain: to.split("@")[1] ?? null },
        "mail (console fallback)",
      );
    },
  };
}
