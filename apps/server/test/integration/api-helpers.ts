// B2 集成测试公共工具：假 AuthRuntime（`Bearer test.<userId>[.<deviceId>]` → AuthContext；v1Routes 为空）、建 app、直接 seed。
// token 只用 requireBearer 允许的字符集（A-Za-z0-9._~+/=-），所以分隔符是 `.` 而不是 `:`。
// 沿用 helpers.ts 的 DSN 约定（DATABASE_URL 超级用户 → RLS 旁路，所以所有可见性都由应用层 SQL 保证）。
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { pino } from "pino";
import { createApp } from "../../src/app.js";
import type { AuthRuntime, AuthVariables } from "../../src/auth/index.js";
import { createDb, createPool, type Db } from "../../src/db/client.js";
import { uuidv7 } from "../../src/db/ids.js";
import { member, organization, team, teamMember, user, workspaces } from "../../src/db/schema/index.js";
import { type ApiEnv, loadApiEnv } from "../../src/http/env.js";
import { createMemoryRateLimiter } from "../../src/http/ratelimit.js";
import type { NoticeLoader } from "../../src/services/notice.js";
import { createMemoryQueue } from "../../src/services/queue.js";
import type { ObjectStorage } from "../../src/services/storage.js";
import { POOLED_URL } from "./helpers.js";

export const fakeAuth: AuthRuntime = {
  handler: async () => Response.json({ error: "auth_not_configured" }, { status: 501 }),
  verifyBearer: async (token) => {
    if (!token.startsWith("test.")) return null;
    const [userId, deviceId] = token.slice(5).split(".");
    if (!userId) return null;
    return {
      userId,
      sessionId: `sess-${userId}`,
      deviceId: deviceId ?? null,
      email: `${userId}@test.invalid`,
      emailVerified: true,
      scopes: [],
    };
  },
  v1Routes: new Hono<{ Variables: AuthVariables }>(),
  // 网页端 / PWA 的同源会话通道：cookie `session=<userId>` 就当成那个用户登录着。
  // 真实实现是 Better Auth 的 getSession（apps/server/src/auth/index.ts），这里只要一个等价的接缝。
  resolveSession: async (headers: Headers) => {
    const m = /(?:^|;\s*)session=([^;]+)/.exec(headers.get("cookie") ?? "");
    if (!m?.[1]) return null;
    return { userId: m[1], email: `${m[1]}@test.invalid`, emailVerified: true };
  },
  close: async () => {},
};

export interface TestApp {
  app: ReturnType<typeof createApp>;
  db: Db;
  env: ApiEnv;
  queue: ReturnType<typeof createMemoryQueue>;
  close(): Promise<void>;
}

export function buildTestApp(
  opts: { notice?: NoticeLoader; storage?: ObjectStorage | null; noticeFile?: string } = {},
): TestApp {
  const pool = createPool(POOLED_URL as string, { max: 4 });
  const db = createDb(pool);
  const env = loadApiEnv({
    NODE_ENV: "test",
    DATABASE_URL: POOLED_URL as string,
    APP_ORIGIN: "http://localhost:5173,tauri://localhost",
    ...(opts.noticeFile ? { NOTICE_FILE: opts.noticeFile } : {}),
  });
  const queue = createMemoryQueue();
  const app = createApp({
    auth: fakeAuth,
    db,
    log: pino({ level: "silent" }),
    env,
    queue,
    storage: opts.storage ?? null,
    rateLimiter: createMemoryRateLimiter(),
    ...(opts.notice ? { notice: opts.notice } : {}),
  });
  return {
    app,
    db,
    env,
    queue,
    close: () => pool.end(),
  };
}

export interface Res<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

export async function call<T = Record<string, unknown>>(
  t: TestApp,
  method: string,
  path: string,
  opts: { as?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.as) headers.authorization = `Bearer test.${opts.as}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await t.app.request(path, { method, headers, ...(body !== undefined ? { body } : {}) });
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

export async function seedUserV7(db: Db, name: string): Promise<{ userId: string; workspaceId: string }> {
  const userId = uuidv7();
  await db.insert(user).values({ id: userId, name, email: `${name}-${userId.slice(-6)}@test.invalid` });
  const workspaceId = uuidv7();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, kind: "personal", ownerUserId: userId, name: `${name} 的便笺` });
  return { userId, workspaceId };
}

export async function seedOrg(
  db: Db,
  name: string,
  members: { userId: string; role: "owner" | "admin" | "member"; status?: string }[],
): Promise<{ orgId: string; workspaceId: string }> {
  const orgId = uuidv7();
  await db.insert(organization).values({ id: orgId, name, slug: `${name}-${orgId.slice(-6)}` });
  for (const m of members) {
    await db.insert(member).values({ id: uuidv7(), organizationId: orgId, userId: m.userId, role: m.role });
    if (m.status && m.status !== "active") {
      await db.execute(
        sql`UPDATE member SET status = ${m.status} WHERE "organizationId" = ${orgId} AND "userId" = ${m.userId}`,
      );
    }
  }
  const workspaceId = uuidv7();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, kind: "team", orgId, name: `${name} 共享区`, defaultNotePerm: "editor" });
  return { orgId, workspaceId };
}

export async function seedTeam(db: Db, orgId: string, name: string, userIds: string[]): Promise<string> {
  const teamId = uuidv7();
  await db.insert(team).values({ id: teamId, name, organizationId: orgId });
  for (const uid of userIds) await db.insert(teamMember).values({ id: uuidv7(), teamId, userId: uid });
  return teamId;
}

export async function seedNote(
  db: Db,
  workspaceId: string,
  createdBy: string,
  text = "标题\n正文",
): Promise<string> {
  const id = uuidv7();
  await db.execute(
    sql`INSERT INTO notes (id, workspace_id, created_by, content_text, created_at, updated_at)
        VALUES (${id}::uuid, ${workspaceId}::uuid, ${createdBy}, ${text}, now(), now())`,
  );
  return id;
}

/** 等待某条件成立（NOTIFY 是异步送达） */
export async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}
