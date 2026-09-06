// =============================================================================
// MailProvider（规格 04 §1.6）：send(to, template, vars)，实现可换（Resend / console）。
// -----------------------------------------------------------------------------
// * RESEND_API_KEY 存在且 NODE_ENV != test → Resend；否则 console（pino 打印，不含链接/token）。
// * 两种实现都把已发送邮件记入进程内 outbox（outbox.ts），集成测试用 getMailOutbox / waitForMail 抓 token/链接。
// =============================================================================
import type { Logger } from "pino";
import { createConsoleMailProvider } from "./console.js";
import { createResendMailProvider } from "./resend.js";
import type { MailTemplate, MailVars } from "./templates.js";

export { clearMailOutbox, getMailOutbox, type MailRecord, recordMail, waitForMail } from "./outbox.js";
export type { MailTemplate, MailVars, RenderedMail } from "./templates.js";
export { renderMail } from "./templates.js";

export interface MailProvider {
  send(to: string, template: MailTemplate, vars: MailVars): Promise<void>;
  close(): Promise<void>;
}

export interface CreateMailProviderOptions {
  env: NodeJS.ProcessEnv;
  log: Logger;
}

export const DEFAULT_MAIL_FROM = "bianfa <no-reply@bianfa.app>";

export function createMailProvider(opts: CreateMailProviderOptions): MailProvider {
  const from = opts.env.MAIL_FROM || DEFAULT_MAIL_FROM;
  const apiKey = opts.env.RESEND_API_KEY;
  if (apiKey && opts.env.NODE_ENV !== "test") {
    return createResendMailProvider({ apiKey, from, log: opts.log });
  }
  return createConsoleMailProvider({
    from,
    log: opts.log,
    printLinks: opts.env.MAIL_CONSOLE_LINKS === "1",
  });
}
