// Resend 6.26 实现：发送失败抛错（调用方决定是否吞掉——注册/找回密码路径必须吞掉以保持恒 200）。
import type { Logger } from "pino";
import { Resend } from "resend";
import { recordMail } from "./outbox.js";
import type { MailTemplate, MailVars } from "./templates.js";
import { renderMail } from "./templates.js";

export interface ResendMailProvider {
  send(to: string, template: MailTemplate, vars: MailVars): Promise<void>;
  close(): Promise<void>;
}

export function createResendMailProvider(opts: {
  apiKey: string;
  from: string;
  log: Logger;
}): ResendMailProvider {
  const resend = new Resend(opts.apiKey);
  return {
    async send(to, template, vars) {
      const rendered = renderMail(template, vars);
      const result = await resend.emails.send({
        from: opts.from,
        to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      if (result.error) {
        opts.log.error({ template, err: result.error.message }, "resend send failed");
        throw new Error(`resend: ${result.error.message}`);
      }
      recordMail({ to, template, vars, rendered, at: Date.now() });
      opts.log.info({ template, id: result.data?.id }, "mail sent");
    },
    async close() {},
  };
}
