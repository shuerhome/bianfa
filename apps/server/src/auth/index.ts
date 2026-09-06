// 鉴权接缝（seam）：createAuth（Better Auth 1.7.3 + oauth-provider + organization + device-authorization + two-factor），
// B2 只依赖这里导出的类型、requireBearer、requireOrgRole 与 AuthRuntime。
// 约定：/v1/* 只认 Bearer（cookie 显式拒绝）；本文件的导出签名固定，实现可换。
import type { Context, Hono, MiddlewareHandler } from "hono";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { createMailProvider } from "../mail/index.js";
import { hashPassword, probeArgon2, verifyPassword } from "../security/argon2.js";
import {
  configureRateLimit,
  createMemoryRateLimitBackend,
  createRedisRateLimitBackend,
} from "../security/rate-limit.js";
import { type BianfaAuth, buildAuth } from "./better-auth.js";
import { type AuthEnv, loadAuthEnv } from "./env.js";
import { createRedisSecondaryStorage } from "./redis.js";
import { buildV1Routes } from "./routes.js";
import type { ServiceDeps } from "./services/context.js";
import { createBearerVerifier } from "./verify-bearer.js";

export {
  getMemberCached,
  invalidateMemberCache,
  invalidateOrgCache,
  type MemberStatus,
  type OrgContext,
  type OrgRole,
  type OrgVariables,
  requireOrgRole,
  roleAtLeast,
} from "./org-guard.js";

/** 一次已认证请求的主体（不含任何 token） */
export interface AuthContext {
  userId: string;
  sessionId: string | null;
  /** 桌面端 device 表 id；Web cookie 会话为 null */
  deviceId: string | null;
  email: string;
  emailVerified: boolean;
  /** oauth-provider access token 的 scope；Web 会话为 [] */
  scopes: readonly string[];
}

/** 校验 Bearer access token → AuthContext；无效/过期/吊销 → null（绝不抛） */
export type BearerVerifier = (token: string, c: Context) => Promise<AuthContext | null>;

/** createAuth 返回给 app 装配层的东西 */
export interface AuthRuntime {
  /** 挂到 `/api/auth/*`（Better Auth handler，含 oauth2/device/organization 端点） */
  handler: (request: Request) => Promise<Response>;
  verifyBearer: BearerVerifier;
  /**
   * 账号/组织/团队/邀请/设备相关的 `/v1` 子路由（B1 实现，内部已用 requireBearer 保护）：
   * /me（用户部分）、/orgs/**、/invites/**、/me/devices/**、/me/delete。装配层 `app.route('/v1', v1Routes)`。
   */
  v1Routes: Hono<{ Variables: AuthVariables }>;
  /** 进程退出时释放（Redis 等） */
  close: () => Promise<void>;
}

export type AuthVariables = { auth: AuthContext };

/**
 * `/v1/*` 用的 Bearer 中间件：解析 `Authorization: Bearer <token>`，校验后放入 `c.var.auth`。
 * 缺失/无效 → 401 `{ error: 'unauthorized' }` + `WWW-Authenticate: Bearer error="invalid_token"`。
 * 带 cookie 但无 Bearer 也一律 401（规格 04 §1.5 / 7.11 ⑮）。
 */
export function requireBearer(verify: BearerVerifier): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
    const ctx = m ? await verify(m[1] as string, c) : null;
    if (!ctx) {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return c.json({ error: "unauthorized" }, 401);
    }
    c.set("auth", ctx);
    await next();
  };
}

export interface CreateAuthDeps {
  env: NodeJS.ProcessEnv;
  db: Db;
  /** 限流计数与 Better Auth secondaryStorage；缺省 = 进程内存（仅测试/单副本） */
  redisUrl?: string;
  log: Logger;
}

/** createAuth 之外还暴露给测试 / 脚本用的内部对象 */
export interface AuthInternals {
  auth: BianfaAuth;
  authEnv: AuthEnv;
  services: ServiceDeps;
  /** 密码哈希实际用的算法 */
  passwordHasher: "argon2id" | "scrypt";
}

/**
 * Better Auth 1.7.3 实例 + Bearer 校验 + /v1 子路由。
 * 参数（deps.env）：BETTER_AUTH_URL / BETTER_AUTH_SECRET / APP_ORIGIN（test 缺省见 env.ts）、RESEND_API_KEY / MAIL_FROM、
 * GOOGLE_* / APPLE_*（缺省关闭）、DATA_KEY_*（列加密，缺省关闭）；deps.redisUrl 缺省 → 内存限流 + 无 secondaryStorage。
 */
export async function createAuthWithInternals(deps: CreateAuthDeps): Promise<AuthRuntime & AuthInternals> {
  const authEnv = loadAuthEnv(deps.env);
  const log = deps.log.child({ name: "auth" });
  const mail = createMailProvider({ env: deps.env, log });

  let redis: Redis | undefined;
  if (deps.redisUrl) {
    redis = new Redis(deps.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: true,
    });
    redis.on("error", (err) => log.warn({ err: err.message }, "auth redis error"));
    configureRateLimit(createRedisRateLimitBackend(redis));
  } else {
    configureRateLimit(createMemoryRateLimitBackend());
  }

  let passwordHasher: AuthInternals["passwordHasher"] = "argon2id";
  let password: { hash: typeof hashPassword; verify: typeof verifyPassword } | undefined = {
    hash: hashPassword,
    verify: verifyPassword,
  };
  try {
    await probeArgon2();
  } catch (err) {
    passwordHasher = "scrypt";
    password = undefined;
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "@node-rs/argon2 unavailable, falling back to scrypt",
    );
  }

  const auth = buildAuth({
    env: authEnv,
    db: deps.db,
    mail,
    log,
    secondaryStorage: redis ? createRedisSecondaryStorage(redis) : undefined,
    password,
  });

  const services: ServiceDeps = {
    db: deps.db,
    mail,
    env: authEnv,
    log,
    revokeWebSessions: async (userId) => {
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteUserSessions(userId);
    },
    // 安全码与密码共用 Better Auth 配置的哈希器（argon2id，probe 失败时是 scrypt）
    password: {
      hash: async (p) => (await auth.$context).password.hash(p),
      verify: async (d) => (await auth.$context).password.verify(d),
    },
    // 安全码重置：经 internalAdapter 写 credential account 的 password（没有 credential account 的社交账号则补建一条）
    setUserPassword: async (userId, newPassword) => {
      const ctx = await auth.$context;
      const hash = await ctx.password.hash(newPassword);
      const credential = await ctx.internalAdapter.findCredentialAccount(userId);
      if (credential) await ctx.internalAdapter.updatePassword(userId, hash);
      else
        await ctx.internalAdapter.linkAccount({
          userId,
          providerId: "credential",
          accountId: userId,
          password: hash,
        });
    },
  };

  const verifyBearer = createBearerVerifier(deps.db, log);
  const v1Routes = buildV1Routes(services, verifyBearer);

  return {
    auth,
    authEnv,
    services,
    passwordHasher,
    handler: (request) => auth.handler(request),
    verifyBearer,
    v1Routes,
    close: async () => {
      await mail.close();
      if (redis) {
        await redis.quit().catch(() => redis?.disconnect());
      }
    },
  };
}

/** 接缝入口：签名固定（B2 只用这个） */
export async function createAuth(deps: CreateAuthDeps): Promise<AuthRuntime> {
  const { handler, verifyBearer, v1Routes, close } = await createAuthWithInternals(deps);
  return { handler, verifyBearer, v1Routes, close };
}
