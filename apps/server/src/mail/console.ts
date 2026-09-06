// console 实现：不真正发信，只打一条结构化日志并记入 outbox。默认不含链接/token；
// 只有显式设 MAIL_CONSOLE_LINKS=1（首次上线、尚未接 Resend 时临时取验证/邀请链接）才把 url 打进日志。
import type { Logger } from "pino";
import { recordMail } from "./outbox.js";
import type { MailTemplate, MailVars } from "./templates.js";
import { renderMail } from "./templates.js";

export interface ConsoleMailProvider {
  send(to: string, template: MailTemplate, vars: MailVars): Promise<void>;
  close(): Promise<void>;
}

export function createConsoleMailProvider(opts: {
  from: string;
  log: Logger;
  /** 为 true 时日志里带 to 与链接（仅供尚未接邮件服务时人工取链接） */
  printLinks?: boolean;
}): ConsoleMailProvider {
  return {
    async send(to, template, vars) {
      const rendered = renderMail(template, vars);
      recordMail({ to, template, vars, rendered, at: Date.now() });
      if (opts.printLinks) {
        opts.log.warn(
          { template, subject: rendered.subject, from: opts.from, to, url: vars.url ?? null },
          "mail (console provider, not sent; MAIL_CONSOLE_LINKS=1 so the link is printed)",
        );
        return;
      }
      opts.log.info(
        { template, subject: rendered.subject, from: opts.from },
        "mail (console provider, not sent)",
      );
    },
    async close() {},
  };
}
