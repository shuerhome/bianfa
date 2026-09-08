// 平台总管理员（迁移 0009）集成测试公共件。
//
// 两条刻意的选择：
//  * 路由用真实的 buildV1Routes 挂载，只把 Bearer 换成 `test.<userId>` 的假校验器 —— 端点、闸门、
//    service、审计全是生产代码；必须走真实 Better Auth 的用例（冻结后登录被拒、改密后重新登录）
//    在 admin-account-flow.test.ts 里另起炉灶。
//  * 服务端连接用 NOBYPASSRLS 的 bianfa_rls_test（helpers.ts 里建的角色），而不是 DATABASE_URL 的超级用户。
//    「查看内容」的实现是把 app.user_id 切成目标用户**重新进入** RLS，超级用户连接会旁路 RLS，
//    那样写出来的可见性断言全是假的 —— 「看不到目标用户看不到的东西」必须由真的 RLS 保证。
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type pg from "pg";
import { pino } from "pino";
import { loadAuthEnv, TEST_APP_ORIGIN } from "../../src/auth/env.js";
import type { BearerVerifier } from "../../src/auth/index.js";
import { buildV1Routes } from "../../src/auth/routes.js";
import type { ServiceDeps } from "../../src/auth/services/context.js";
import { createDb, createPool, type Db } from "../../src/db/client.js";
import { uuidv7 } from "../../src/db/ids.js";
import { createMailProvider } from "../../src/mail/index.js";
import { configureRateLimit, createMemoryRateLimitBackend } from "../../src/security/rate-limit.js";
import { DIRECT_URL, POOLED_URL, RLS_PASSWORD, RLS_ROLE, withCredentials } from "./helpers.js";

/** `Bearer test.<userId>` → AuthContext（与 api-helpers.ts 同一套约定） */
export const fakeVerify: BearerVerifier = async (token) => {
  if (!token.startsWith("test.")) return null;
  const userId = token.slice(5);
  if (!userId) return null;
  return {
    userId,
    sessionId: `sess-${userId}`,
    deviceId: null,
    email: `${userId}@test.invalid`,
    emailVerified: true,
    scopes: [],
  };
};

export interface AdminHarness {
  pool: pg.Pool;
  db: Db;
  deps: ServiceDeps;
  app: Hono;
  /** deps.revokeWebSessions 被调用时记下的 userId（真实实现由 createAuth 注入） */
  webSessionsRevoked: string[];
  /** deps.setUserPassword 被调用时记下的 (userId, 新密码) */
  passwordsSet: Array<{ userId: string; password: string }>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** PLATFORM_ADMIN_ENABLED；false → 整面 404 */
  enabled?: boolean;
  /** 连接池上限；测「身份不残留」时设 1，强制复用同一条连接 */
  max?: number;
  /**
   * 同源 cookie 会话解析（真实实现由 createAuth 注入 Better Auth 的 getSession）。
   * 测试里用 `cookie: session=<userId>` 冒充；不设则这条通道不可用（等价于没注入 resolveSession）。
   */
  sessionFromCookie?: boolean;
}

/** 以 bianfa_rls_test（NOBYPASSRLS，成员于 bianfa_app）连接，挂真实的 /v1 路由 */
export function openHarness(opts: HarnessOptions = {}): AdminHarness {
  const pool = createPool(withCredentials(DIRECT_URL as string, RLS_ROLE, RLS_PASSWORD), {
    max: opts.max ?? 4,
  });
  const db = createDb(pool);
  const log = pino({ level: "silent" });
  const webSessionsRevoked: string[] = [];
  const passwordsSet: Array<{ userId: string; password: string }> = [];
  const deps: ServiceDeps = {
    db,
    mail: createMailProvider({ env: { NODE_ENV: "test" }, log }),
    env: loadAuthEnv({
      NODE_ENV: "test",
      DATABASE_URL: POOLED_URL as string,
      ...(opts.enabled === false ? { PLATFORM_ADMIN_ENABLED: "0" } : {}),
    }),
    log,
    revokeWebSessions: async (userId) => {
      webSessionsRevoked.push(userId);
    },
    setUserPassword: async (userId, password) => {
      passwordsSet.push({ userId, password });
    },
    ...(opts.sessionFromCookie
      ? {
          resolveSession: async (headers: Headers) => {
            const m = /(?:^|;\s*)session=([^;]+)/.exec(headers.get("cookie") ?? "");
            if (!m?.[1]) return null;
            return { userId: m[1], email: `${m[1]}@test.invalid`, emailVerified: true };
          },
        }
      : {}),
  };
  const app = new Hono();
  app.route("/v1", buildV1Routes(deps, fakeVerify));
  return {
    pool,
    db,
    deps,
    app,
    webSessionsRevoked,
    passwordsSet,
    close: async () => {
      await deps.mail.close();
      await pool.end();
    },
  };
}

/** 限流后端是模块级全局的：每个文件开头重置一次，别让别的文件的计数漏过来 */
export function resetRateLimit(): void {
  configureRateLimit(createMemoryRateLimitBackend());
}

export interface Res<T = Record<string, unknown>> {
  status: number;
  body: T;
}

export async function req<T = Record<string, unknown>>(
  app: Hono,
  method: string,
  path: string,
  opts: {
    as?: string;
    body?: unknown;
    /** 同源会话通道：伪造 cookie（不带 Bearer） */
    cookieAs?: string;
    /** 默认带 X-Bianfa-Admin: 1；显式设 false 用来测缺这个头会不会被拒 */
    adminHeader?: boolean;
    /** /v1 的同源会话通道要的是 X-Bianfa-Web（与管理台那条刻意用不同的头） */
    webHeader?: boolean;
    /** 非 GET 请求的 Origin；默认取 APP_ORIGIN 的第一个 */
    origin?: string | null;
  } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (opts.as) headers.authorization = `Bearer test.${opts.as}`;
  if (opts.cookieAs) {
    headers.cookie = `session=${opts.cookieAs}`;
    if (opts.webHeader === true) headers["x-bianfa-web"] = "1";
    else if (opts.adminHeader !== false) headers["x-bianfa-admin"] = "1";
    const origin = opts.origin === undefined ? TEST_APP_ORIGIN : opts.origin;
    if (origin) headers.origin = origin;
  }
  let payload: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(opts.body);
  }
  const res = await app.request(path, {
    method,
    headers,
    ...(payload !== undefined ? { body: payload } : {}),
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed as T };
}

export interface Endpoint {
  method: string;
  path: string;
  body?: unknown;
}

/** /v1/admin/* 的全部端点：闸门矩阵逐个打一遍，将来新增端点忘了挂闸门会当场露出来 */
export function adminEndpoints(targetUserId: string, noteId: string): Endpoint[] {
  return [
    { method: "GET", path: "/v1/admin/users" },
    { method: "GET", path: "/v1/admin/admins" },
    { method: "GET", path: "/v1/admin/audit" },
    { method: "GET", path: `/v1/admin/users/${targetUserId}` },
    { method: "GET", path: `/v1/admin/users/${targetUserId}/workspaces` },
    { method: "GET", path: `/v1/admin/users/${targetUserId}/notes` },
    { method: "GET", path: `/v1/admin/users/${targetUserId}/notes/${noteId}` },
    { method: "POST", path: `/v1/admin/users/${targetUserId}/freeze`, body: {} },
    { method: "POST", path: `/v1/admin/users/${targetUserId}/unfreeze` },
    {
      method: "POST",
      path: `/v1/admin/users/${targetUserId}/password`,
      body: { new_password: "not-the-real-one-1" },
    },
  ];
}

// ─────────────────────────────────────────────────────────── seed（一律用超级用户连接写）

/** 模拟 infra/vps/platform-admin.sh：只有超级用户 / bianfa_worker 写得进这张表 */
export async function grantPlatformAdmin(admin: pg.Pool, userId: string, note = "test"): Promise<void> {
  await admin.query(
    "INSERT INTO platform_admin (user_id, granted_by, note) VALUES ($1, 'bootstrap', $2) ON CONFLICT (user_id) DO NOTHING",
    [userId, note],
  );
}

export async function seedWorkspace(
  db: Db,
  input: { kind: "personal" | "team"; ownerUserId?: string; orgId?: string; teamId?: string; name: string },
): Promise<string> {
  const id = uuidv7();
  await db.execute(
    sql`INSERT INTO workspaces (id, kind, owner_user_id, org_id, team_id, name)
        VALUES (${id}::uuid, ${input.kind}::workspace_kind, ${input.ownerUserId ?? null},
                ${input.orgId ?? null}, ${input.teamId ?? null}::uuid, ${input.name})`,
  );
  return id;
}

export async function seedNote(
  db: Db,
  input: {
    workspaceId: string;
    createdBy: string;
    text?: string;
    encryption?: "server" | "e2ee";
    deleted?: boolean;
  },
): Promise<string> {
  const id = uuidv7();
  await db.execute(
    sql`INSERT INTO notes (id, workspace_id, created_by, content, content_text, encryption, created_at, updated_at, deleted_at)
        VALUES (${id}::uuid, ${input.workspaceId}::uuid, ${input.createdBy},
                ${JSON.stringify({ type: "doc", content: [] })}::jsonb, ${input.text ?? "标题\n正文"},
                ${input.encryption ?? "server"}, now(), now(), ${input.deleted ? sql`now()` : sql`NULL`})`,
  );
  return id;
}
