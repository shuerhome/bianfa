// 进程内 outbox（测试钩子）：所有 MailProvider 实现发送后都 recordMail；只在内存，最近 200 封。
import type { MailTemplate, MailVars, RenderedMail } from "./templates.js";

export interface MailRecord {
  to: string;
  template: MailTemplate;
  vars: MailVars;
  rendered: RenderedMail;
  at: number;
}

const OUTBOX_LIMIT = 200;
const outbox: MailRecord[] = [];
const listeners = new Set<(m: MailRecord) => void>();

export function recordMail(m: MailRecord): void {
  outbox.push(m);
  if (outbox.length > OUTBOX_LIMIT) outbox.splice(0, outbox.length - OUTBOX_LIMIT);
  for (const l of listeners) l(m);
}

/** 已发送邮件（最新在后） */
export function getMailOutbox(): readonly MailRecord[] {
  return outbox;
}

export function clearMailOutbox(): void {
  outbox.length = 0;
}

/** 等待满足条件的邮件（已在 outbox 里的也算，取最新一封） */
export function waitForMail(predicate: (m: MailRecord) => boolean, timeoutMs = 5000): Promise<MailRecord> {
  const existing = [...outbox].reverse().find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      reject(new Error(`waitForMail: ${timeoutMs}ms 内没有匹配的邮件`));
    }, timeoutMs);
    const listener = (m: MailRecord) => {
      if (!predicate(m)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(m);
    };
    listeners.add(listener);
  });
}
