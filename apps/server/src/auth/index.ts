// 鉴权接缝（seam）：B1 代理实现 createAuth（Better Auth 1.7.3），B2 代理只依赖这里导出的类型与 requireBearer。
// 约定：/v1/* 只认 Bearer（cookie 显式拒绝）；本文件的导出签名固定，实现可换。
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";

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

/**
 * 占位实现：B1 代理会用 Better Auth 替换本函数体（签名不变）。
 * 占位行为：/api/auth/* 一律 501；任何 Bearer 都视为无效（fail-closed）。
 */
export async function createAuth(_deps: CreateAuthDeps): Promise<AuthRuntime> {
  return {
    handler: async () => Response.json({ error: "auth_not_configured" }, { status: 501 }),
    verifyBearer: async () => null,
    v1Routes: new Hono<{ Variables: AuthVariables }>(),
    close: async () => {},
  };
}

export interface CreateAuthDeps {
  env: NodeJS.ProcessEnv;
  db: Db;
  /** 限流计数与 Better Auth secondaryStorage；缺省 = 进程内存（仅测试/单副本） */
  redisUrl?: string;
  log: Logger;
}
