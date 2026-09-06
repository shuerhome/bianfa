// 路由公共类型与小工具：AppDeps（装配层注入）、RouteEnv（Hono 变量）、按用户开事务、审计上下文。
import type { Context, Hono } from "hono";
import type { Logger } from "pino";
import { type AuditEntry, audit } from "../audit/index.js";
import type { AuthRuntime, AuthVariables } from "../auth/index.js";
import { type Db, type Tx, withUserTx } from "../db/client.js";
import type { ApiEnv } from "../http/env.js";
import { clientIp } from "../http/middleware.js";
import type { RateLimiter } from "../http/ratelimit.js";
import type { NoticeLoader } from "../services/notice.js";
import type { JobQueue } from "../services/queue.js";
import type { ObjectStorage } from "../services/storage.js";

export interface AppDeps {
  auth: AuthRuntime;
  db: Db;
  log: Logger;
  env: ApiEnv;
  /** 缺省：按 DATABASE_URL 懒建 pg-boss（api 侧只 send） */
  queue?: JobQueue;
  /** 缺省：按 R2_* 环境变量建；null = 附件功能关闭（503 attachments_disabled） */
  storage?: ObjectStorage | null;
  /** 缺省：REDIS_URL → Redis，否则进程内 */
  rateLimiter?: RateLimiter;
  /** 缺省：按 NOTICE_FILE */
  notice?: NoticeLoader;
  now?: () => Date;
}

/** 装配层填满缺省后交给各路由的依赖 */
export interface RouteDeps {
  db: Db;
  log: Logger;
  env: ApiEnv;
  queue: JobQueue;
  storage: ObjectStorage | null;
  rateLimiter: RateLimiter;
  notice: NoticeLoader;
  now: () => Date;
}

export type RouteEnv = { Variables: AuthVariables & { requestId: string } };
export type RouteApp = Hono<RouteEnv>;

/** 以当前用户身份开显式事务（SET LOCAL app.user_id；RLS 上下文） */
export function userTx<T>(c: Context<RouteEnv>, deps: RouteDeps, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withUserTx(c.var.auth.userId, fn, deps.db);
}

/** 从请求取审计主体字段（不含任何 token / body） */
export function actorOf(
  c: Context<RouteEnv>,
): Pick<AuditEntry, "actorId" | "actorIp" | "actorDeviceId" | "actorUa" | "requestId"> {
  const auth = c.var.auth;
  const ip = clientIp(c);
  return {
    actorId: auth?.userId ?? null,
    actorIp: /^[0-9a-fA-F.:]+$/.test(ip) ? ip : null,
    actorDeviceId: auth?.deviceId ?? null,
    actorUa: (c.req.header("user-agent") ?? "").slice(0, 300) || null,
    requestId: c.var.requestId ?? null,
  };
}

export function auditIn(
  tx: Tx,
  c: Context<RouteEnv>,
  entry: Omit<AuditEntry, keyof ReturnType<typeof actorOf>>,
): Promise<void> {
  return audit(tx, { ...actorOf(c), ...entry });
}

/** X-Organization-Id 头（org 级路由）；缺失 → 400 no_active_organization（规格 04 §5.3） */
export function orgIdHeader(c: Context<RouteEnv>): string | null {
  const v = c.req.header("x-organization-id");
  return v && v.length <= 64 ? v : null;
}
