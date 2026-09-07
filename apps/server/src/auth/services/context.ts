// service 层公共类型：依赖包、请求主体（actor）、审计条目拼装。每个 service 函数自己开 withUserTx（RLS 身份 = actor）。
import type { Logger } from "pino";
import type { AuditEntry } from "../../audit/index.js";
import type { Db } from "../../db/client.js";
import type { MailProvider } from "../../mail/index.js";
import type { AuthEnv } from "../env.js";
import type { PasswordHasher } from "../security-code.js";

export interface ServiceDeps {
  db: Db;
  mail: MailProvider;
  env: AuthEnv;
  log: Logger;
  /** 撤销用户全部 Better Auth Web 会话（DB + secondaryStorage）；由 createAuth 注入 */
  revokeWebSessions?: (userId: string) => Promise<void>;
  /** Better Auth 配置的密码哈希器（argon2id，回退 scrypt）；安全码与密码共用；由 createAuth 注入 */
  password?: PasswordHasher;
  /** 经 Better Auth internalAdapter 设置用户密码（credential account 不存在时创建）；由 createAuth 注入 */
  setUserPassword?: (userId: string, newPassword: string) => Promise<void>;
  /**
   * 按 token 逐个清掉会话缓存（secondaryStorage）；由 createAuth 注入。
   * 与 revokeWebSessions 的区别：后者清缓存要先读 `active-sessions-<uid>` 索引键，
   * 那个键在 Redis 的 allkeys-lru 下会被淘汰，淘汰之后就清不干净了。
   */
  revokeSessionTokens?: (tokens: string[]) => Promise<void>;
  /**
   * 用同源 cookie 解析出 Better Auth 会话；由 createAuth 注入。
   * **只有 /v1/admin/* 用它** —— /v1 的其余部分按规格 04 §1.5 只认 Bearer，这条口子不扩大到别处。
   */
  resolveSession?: (headers: Headers) => Promise<{
    userId: string;
    email: string;
    emailVerified: boolean;
  } | null>;
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
