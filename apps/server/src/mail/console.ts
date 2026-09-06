// console 实现：不真正发信，只打一条结构化日志（不含链接/token）并记入 outbox。
import type { Logger } from "pino";
import { recordMail } from "./outbox.js";
import type { MailTemplate, MailVars } from "./templates.js";
import { renderMail } from "./templates.js";

export interface ConsoleMailProvider {
  send(to: string, template: MailTemplate, vars: MailVars): Promise<void>;
  close(): Promise<void>;
}

export function createConsoleMailProvider(opts: { from: string; log: Logger }): ConsoleMailProvider {
  return {
    async send(to, template, vars) {
      const rendered = renderMail(template, vars);
      recordMail({ to, template, vars, rendered, at: Date.now() });
      opts.log.info(
        { template, subject: rendered.subject, from: opts.from },
        "mail (console provider, not sent)",
      );
    },
    async close() {},
  };
}
