// service 层公共类型：依赖包、请求主体（actor）、审计条目拼装。每个 service 函数自己开 withUserTx（RLS 身份 = actor）。
import type { Logger } from "pino";
import type { AuditEntry } from "../../audit/index.js";
import type { Db } from "../../db/client.js";
import type { MailProvider } from "../../mail/index.js";
import type { AuthEnv } from "../env.js";

export interface ServiceDeps {
  db: Db;
  mail: MailProvider;
  env: AuthEnv;
  log: Logger;
  /** 撤销用户全部 Better Auth Web 会话（DB + secondaryStorage）；由 createAuth 注入 */
  revokeWebSessions?: (userId: string) => Promise<void>;
}

export interface Actor {
  userId: string;
  email: string;
  emailVerified: boolean;
  name?: string | undefined;
  deviceId: string | null;
  ip: string | null;
  ua: string | null;
  requestId: string | null;
}

export function actorEntry(
  actor: Actor,
  e: Omit<AuditEntry, "actorId" | "actorIp" | "actorUa" | "actorDeviceId" | "requestId">,
): AuditEntry {
  return {
    ...e,
    actorId: actor.userId,
    actorIp: actor.ip,
    actorUa: actor.ua,
    actorDeviceId: actor.deviceId,
    requestId: actor.requestId,
  };
}

/** 邮件发送失败不影响业务结果：记 warn 即可 */
export async function sendMailSafely(deps: ServiceDeps, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, "mail send failed");
  }
}
