// 鉴权端到端（bianfa_auth 库，globalSetup 已跑迁移 0000–0007）：
// 注册（邮箱 + 密码 + 安全码，不验证邮箱）→ 登录 cookie → PKCE authorize → 换 token（带 device_*）→ verifyBearer → /v1/me
// → 修改安全码 → 安全码重置密码（旧密码 / 旧 token / 旧会话全部失效）→ 刷新 → 撤销；设备码流程；Free 设备上限；
// org 创建 → 席位闸门 → 邀请（响应带 invite_url）→ 第二个用户接受 → 移除成员发 NOTIFY → requireOrgRole 缓存失效；
// /v1 带 cookie 无 Bearer → 401；账号软删。全程断言明文安全码既不落库也不进日志。
import { createHash, randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { Hono } from "hono";
import type pg from "pg";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapDesktopClient } from "../../src/auth/bootstrap-client.js";
import { type AuthInternals, type AuthRuntime, createAuthWithInternals } from "../../src/auth/index.js";
import { invalidateMemberCache } from "../../src/auth/org-guard.js";
import { closeDb } from "../../src/db/client.js";
import { createDirectClient, type DirectClient } from "../../src/db/direct.js";
import { uuidv7 } from "../../src/db/ids.js";
import { clearMailOutbox, getMailOutbox, waitForMail } from "../../src/mail/index.js";
import { DIRECT_URL, type Fixture, hasDb, openAdmin, POOLED_URL, truncateAll } from "./helpers.js";

const BASE = "http://127.0.0.1:3000";
const APP_ORIGIN = "http://localhost:1420";
const CLIENT_ID = "bianfa-desktop";
const SCOPE = "openid profile email offline_access";
const PASSWORD = "correct-horse-battery-staple";
const PASSWORD_2 = "new-password-after-reset-1";
/** 安全码：任意字符、4–32；这里故意带空格与中文，且首尾空白会被 trim */
const SECURITY_CODE = "  我的 小狗 叫 Bobo!  ";
const SECURITY_CODE_2 = "second code 2024";
/** 每次运行换邮箱：reset-with-code 的限流计数按 ip+email 存 Redis（15 分钟窗口），避免连跑两次互相影响 */
const RUN = Date.now().toString(36);

interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function cookieOf(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  const pairs = raw.map((c) => c.split(";")[0] as string).filter((p) => !p.endsWith("="));
  expect(pairs.length, "expected a session cookie").toBeGreaterThan(0);
  return pairs.join("; ");
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`non-json response ${res.status}: ${text.slice(0, 300)}`);
  }
}

describe.skipIf(!hasDb)("auth end-to-end", () => {
  let f: Fixture;
  let rt: AuthRuntime & AuthInternals;
  let app: Hono;
  let direct: DirectClient;
  const notifications: Array<{ user_id: string; scope: string; id: string }> = [];
  /** 全部日志（trace 级）都收进来，最后断言明文安全码从未出现 */
  const logLines: string[] = [];

  const u1 = {
    email: `alice-${RUN}@test.invalid`,
    name: "Alice",
    id: "",
    cookie: "",
    tokens: null as Tokens | null,
    device: uuidv7(),
  };
  const u2 = {
    email: `bob-${RUN}@test.invalid`,
    name: "Bob",
    id: "",
    cookie: "",
    tokens: null as Tokens | null,
    device: uuidv7(),
  };
  let orgId = "";
  let inviteToken = "";

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: APP_ORIGIN, ...headers },
      body: JSON.stringify(body),
    });
  const form = (path: string, fields: Record<string, string>) =>
    app.request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  const v1 = (
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(`${BASE}/v1${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  /** 注册 = 邮箱 + 密码 + 安全码；不需要验证邮件，注册即登录（响应带 session cookie） */
  async function signUp(u: typeof u1): Promise<Response> {
    const res = await post("/api/auth/sign-up/email", {
      name: u.name,
      email: u.email,
      password: PASSWORD,
      securityCode: SECURITY_CODE,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json<{ user: Record<string, unknown> }>(res.clone());
    // returned: false → 响应里没有安全码相关字段
    expect(Object.keys(body.user)).not.toContain("securityCode");
    expect(Object.keys(body.user)).not.toContain("securityCodeHash");
    expect(JSON.stringify(body)).not.toContain(SECURITY_CODE.trim());
    return res;
  }

  async function signIn(u: typeof u1, password = PASSWORD): Promise<string> {
    const res = await post("/api/auth/sign-in/email", { email: u.email, password });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json<{ user: { id: string } }>(res);
    u.id = body.user.id;
    return cookieOf(res);
  }

  /** 库里任何一列都不能含明文安全码（user / account 两张表） */
  async function assertPlainCodeNotStored(userId: string, plain: string): Promise<void> {
    const code = plain.trim();
    for (const q of ['SELECT * FROM "user" WHERE id = $1', 'SELECT * FROM account WHERE "userId" = $1']) {
      const rows = await f.admin.query(q, [userId]);
      expect(rows.rows.length).toBeGreaterThan(0);
      for (const row of rows.rows as Record<string, unknown>[]) {
        for (const [col, val] of Object.entries(row)) {
          if (val === null || val === undefined) continue;
          expect(String(val), `${q} → column ${col}`).not.toContain(code);
          expect(String(val), `${q} → column ${col}`).not.toContain(plain);
        }
      }
    }
  }

  async function pkceLogin(
    cookie: string,
    deviceId: string,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const state = b64url(randomBytes(16));
    const redirect = "http://127.0.0.1:43123/cb";
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirect,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: SCOPE,
    });
    const authz = await app.request(`${BASE}/api/auth/oauth2/authorize?${q}`, { headers: { cookie } });
    expect(authz.status, await authz.clone().text()).toBe(302);
    const location = new URL(authz.headers.get("location") as string);
    expect(`${location.origin}${location.pathname}`).toBe(redirect);
    expect(location.searchParams.get("state")).toBe(state);
    const code = location.searchParams.get("code") as string;
    expect(code).toBeTruthy();
    return form("/api/auth/oauth2/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: redirect,
      device_id: deviceId,
      device_name: "Test Box",
      platform: "linux",
      app_version: "0.1.0",
      ...extra,
    });
  }

  beforeAll(async () => {
    f = openAdmin();
    await truncateAll(f.admin);
    await f.admin.query('TRUNCATE "oauthClient", "deviceCode", audit_log RESTART IDENTITY CASCADE');
    clearMailOutbox();
    invalidateMemberCache();
    const sink = new Writable({
      write(chunk, _enc, cb) {
        logLines.push(String(chunk));
        cb();
      },
    });
    const log = pino({ level: "trace", base: { name: "auth-test" } }, sink);
    rt = await createAuthWithInternals({
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: POOLED_URL as string },
      db: f.adminDb,
      ...(process.env.REDIS_URL ? { redisUrl: process.env.REDIS_URL } : {}),
      log,
    });
    app = new Hono();
    app.on(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"], "/api/auth/*", (c) =>
      rt.handler(c.req.raw),
    );
    app.route("/v1", rt.v1Routes);
    direct = createDirectClient({ connectionString: DIRECT_URL as string, reconnectBaseMs: 50 });
    await direct.listen("authz_revoked", (payload) => notifications.push(JSON.parse(payload)));
    await direct.waitConnected();
  });

  afterAll(async () => {
    await direct?.close();
    await rt?.close();
    await f.admin.end();
    await closeDb();
  });

  it("bootstrap：幂等创建 public client bianfa-desktop", async () => {
    expect(await bootstrapDesktopClient(f.adminDb)).toEqual({ created: true, clientId: CLIENT_ID });
    expect(await bootstrapDesktopClient(f.adminDb)).toEqual({ created: false, clientId: CLIENT_ID });
    const row = await f.admin.query(
      'SELECT "tokenEndpointAuthMethod" AS m, "applicationType" AS t, "redirectUris" AS r, "skipConsent" AS s FROM "oauthClient" WHERE "clientId" = $1',
      [CLIENT_ID],
    );
    expect(row.rows[0]).toMatchObject({ m: "none", t: "native", r: ["http://127.0.0.1/cb"], s: true });
    expect(rt.passwordHasher).toBe("argon2id");
  });

  it("注册前校验：缺安全码 / 太短 / 与密码相同 → 400，不建用户", async () => {
    const base = { name: u1.name, email: u1.email, password: PASSWORD };
    const missing = await post("/api/auth/sign-up/email", base);
    expect(missing.status).toBe(400);
    expect((await json(missing)).code).toBe("SECURITY_CODE_REQUIRED");
    const short = await post("/api/auth/sign-up/email", { ...base, securityCode: " ab " });
    expect(short.status).toBe(400);
    expect((await json(short)).code).toBe("SECURITY_CODE_TOO_SHORT");
    const same = await post("/api/auth/sign-up/email", { ...base, securityCode: PASSWORD });
    expect(same.status).toBe(400);
    expect((await json(same)).code).toBe("SECURITY_CODE_EQUALS_PASSWORD");
    const users = await f.admin.query('SELECT count(*)::int AS n FROM "user" WHERE email = $1', [u1.email]);
    expect(users.rows[0]?.n).toBe(0);
  });

  it("注册（邮箱 + 密码 + 安全码）→ 无需验证邮件即可登录；不发验证邮件；密码 argon2id；安全码只存 hash；个人 workspace 已建", async () => {
    const signup = await signUp(u1);
    expect(cookieOf(signup)).toMatch(/session_token/);
    u1.cookie = await signIn(u1);
    expect(getMailOutbox().filter((m) => m.template === "verify_email")).toHaveLength(0);
    const row = await f.admin.query(
      'SELECT "emailVerified", security_code, security_code_hash, security_code_set_at FROM "user" WHERE id = $1',
      [u1.id],
    );
    expect(row.rows[0]?.emailVerified).toBe(false);
    // 明文列只为 adapter 的 schema diff 而存在：永远 NULL，且有 CHECK 约束兜底
    expect(row.rows[0]?.security_code).toBeNull();
    await expect(
      f.admin.query('UPDATE "user" SET security_code = $2 WHERE id = $1', [u1.id, "leak"]),
    ).rejects.toThrow(/user_security_code_never_stored/);
    expect(String(row.rows[0]?.security_code_hash)).toMatch(/^\$argon2id\$/);
    expect(row.rows[0]?.security_code_set_at).not.toBeNull();
    await assertPlainCodeNotStored(u1.id, SECURITY_CODE);
    // 库里存的是 trim 后的码的 hash：用配置的哈希器验证
    expect(
      await rt.services.password?.verify({
        hash: String(row.rows[0]?.security_code_hash),
        password: SECURITY_CODE.trim(),
      }),
    ).toBe(true);
    const acct = await f.admin.query('SELECT password FROM account WHERE "userId" = $1', [u1.id]);
    expect(String(acct.rows[0]?.password)).toMatch(/^\$argon2id\$/);
    const ws = await f.admin.query(
      "SELECT id, name FROM workspaces WHERE owner_user_id = $1 AND kind = 'personal'",
      [u1.id],
    );
    expect(ws.rows).toHaveLength(1);
    expect(ws.rows[0]?.name).toBe("我的便笺");
    const audit = await f.admin.query(
      "SELECT action FROM audit_log WHERE actor_id = $1 AND action = 'auth.login_ok'",
      [u1.id],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it("错密码 → 401 + auth.login_failed 审计", async () => {
    const bad = await post("/api/auth/sign-in/email", { email: u1.email, password: "wrong-password-1" });
    expect(bad.status).toBe(401);
    const audit = await f.admin.query(
      "SELECT outcome FROM audit_log WHERE actor_id = $1 AND action = 'auth.login_failed'",
      [u1.id],
    );
    expect(audit.rows[0]?.outcome).toBe("denied");
  });

  it("PKCE authorize（cookie 会话，skip_consent）→ 换 token 携带 device_*：设备行 + 绑定；verifyBearer 返回用户与设备", async () => {
    const res = await pkceLogin(u1.cookie, u1.device);
    expect(res.status, await res.clone().text()).toBe(200);
    const tokens = await json<Tokens>(res);
    u1.tokens = tokens;
    expect(tokens.access_token.startsWith("bfa_")).toBe(true);
    expect(tokens.refresh_token.startsWith("bfr_")).toBe(true);
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(900);
    expect(tokens.scope.split(" ")).toContain("offline_access");

    const dev = await f.admin.query(
      "SELECT user_id, name, platform, app_version, revoked_at FROM device WHERE id = $1",
      [u1.device],
    );
    expect(dev.rows[0]).toMatchObject({
      user_id: u1.id,
      name: "Test Box",
      platform: "linux",
      app_version: "0.1.0",
      revoked_at: null,
    });
    const bind = await f.admin.query(
      "SELECT count(*)::int AS n FROM oauth_refresh_device WHERE device_id = $1 AND user_id = $2",
      [u1.device, u1.id],
    );
    expect(bind.rows[0]?.n).toBe(1);

    const ctx = await rt.verifyBearer(tokens.access_token, undefined as never);
    // 账号模型不验证邮箱：emailVerified 恒为 false，但不影响任何流程
    expect(ctx).toMatchObject({ userId: u1.id, deviceId: u1.device, email: u1.email, emailVerified: false });
    expect(ctx?.scopes).toContain("openid");
    expect(await rt.verifyBearer("bfa_nope", undefined as never)).toBeNull();
  });

  it("/v1/me：Bearer → 200（snake_case + server_time + personal_workspace_id）；只带 cookie → 401", async () => {
    const res = await v1("GET", "/me", (u1.tokens as Tokens).access_token);
    expect(res.status).toBe(200);
    const me = await json<{
      user: { id: string; email: string };
      plan: string;
      personal_workspace_id: string | null;
      orgs: unknown[];
      server_time: number;
      current_device_id: string;
      security_code_set_at: string | null;
    }>(res);
    expect(me.user).toMatchObject({ id: u1.id, email: u1.email });
    expect(me.plan).toBe("free");
    expect(typeof me.security_code_set_at).toBe("string");
    expect(me.personal_workspace_id).toBeTruthy();
    expect(me.orgs).toEqual([]);
    expect(me.current_device_id).toBe(u1.device);
    expect(typeof me.server_time).toBe("number");

    const cookieOnly = await app.request(`${BASE}/v1/me`, { headers: { cookie: u1.cookie } });
    expect(cookieOnly.status).toBe(401);
    expect(cookieOnly.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("/v1/me/security-code：错密码 403 invalid_password；新码 = 密码 400；正确 → set_at 更新、hash 换新、明文不落库、审计", async () => {
    const t = (u1.tokens as Tokens).access_token;
    const before = await f.admin.query(
      'SELECT security_code_hash, security_code_set_at FROM "user" WHERE id = $1',
      [u1.id],
    );
    const wrong = await v1("POST", "/me/security-code", t, {
      password: "not-the-password-1",
      new_security_code: SECURITY_CODE_2,
    });
    expect(wrong.status).toBe(403);
    expect((await json(wrong)).error).toBe("invalid_password");
    const same = await v1("POST", "/me/security-code", t, {
      password: PASSWORD,
      new_security_code: PASSWORD,
    });
    expect(same.status).toBe(400);
    expect((await json(same)).error).toBe("security_code_equals_password");
    const tooShort = await v1("POST", "/me/security-code", t, {
      password: PASSWORD,
      new_security_code: "ab",
    });
    expect(tooShort.status).toBe(400);
    expect((await json(tooShort)).error).toBe("validation_failed");

    const ok = await v1("POST", "/me/security-code", t, {
      password: PASSWORD,
      new_security_code: SECURITY_CODE_2,
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const body = await json<{ security_code_set_at: string }>(ok);
    expect(new Date(body.security_code_set_at).getTime()).toBeGreaterThanOrEqual(
      new Date(String(before.rows[0]?.security_code_set_at)).getTime(),
    );
    const after = await f.admin.query('SELECT security_code_hash FROM "user" WHERE id = $1', [u1.id]);
    expect(after.rows[0]?.security_code_hash).not.toBe(before.rows[0]?.security_code_hash);
    await assertPlainCodeNotStored(u1.id, SECURITY_CODE_2);
    await assertPlainCodeNotStored(u1.id, SECURITY_CODE);
    const me = await json<{ security_code_set_at: string }>(await v1("GET", "/me", t));
    expect(me.security_code_set_at).toBe(body.security_code_set_at);
    const audit = await f.admin.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.security_code_changed' AND actor_id = $1",
      [u1.id],
    );
    expect(audit.rows[0]?.n).toBe(1);
  });

  it("安全码重置密码（匿名）：错码 / 未知邮箱 → 400 invalid_security_code；正确 → 旧密码失效、新密码可登录、旧 token / 旧会话全部撤销、NOTIFY(session:*)、审计", async () => {
    const before = notifications.length;
    const oldTokens = u1.tokens as Tokens;
    const oldCookie = u1.cookie;
    const reset = (body: unknown) =>
      app.request(`${BASE}/v1/auth/reset-with-code`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: oldCookie },
        body: JSON.stringify(body),
      });

    // 旧码（已被 /me/security-code 换掉）→ 400
    const wrong = await reset({ email: u1.email, security_code: SECURITY_CODE, new_password: PASSWORD_2 });
    expect(wrong.status).toBe(400);
    expect((await json(wrong)).error).toBe("invalid_security_code");
    const unknown = await reset({
      email: `nobody-${RUN}@test.invalid`,
      security_code: SECURITY_CODE_2,
      new_password: PASSWORD_2,
    });
    expect(unknown.status).toBe(400);
    expect((await json(unknown)).error).toBe("invalid_security_code");
    const sameAsCode = await reset({
      email: u1.email,
      security_code: SECURITY_CODE_2,
      new_password: SECURITY_CODE_2,
    });
    expect(sameAsCode.status).toBe(400);
    expect((await json(sameAsCode)).error).toBe("password_equals_security_code");
    const badBody = await reset({ email: u1.email, security_code: SECURITY_CODE_2, new_password: "short" });
    expect(badBody.status).toBe(400);
    expect((await json(badBody)).error).toBe("validation_failed");
    // 密码没变
    expect((await post("/api/auth/sign-in/email", { email: u1.email, password: PASSWORD })).status).toBe(200);
    const denied = await f.admin.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.password_reset_denied' AND actor_id = $1",
      [u1.id],
    );
    expect(denied.rows[0]?.n).toBe(1);

    // 正确的码（大小写 / 首尾空白：trim 后比较）
    const ok = await reset({
      email: u1.email.toUpperCase(),
      security_code: `  ${SECURITY_CODE_2}  `,
      new_password: PASSWORD_2,
    });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await json(ok)).ok).toBe(true);

    const oldPw = await post("/api/auth/sign-in/email", { email: u1.email, password: PASSWORD });
    expect(oldPw.status).toBe(401);
    expect(await rt.verifyBearer(oldTokens.access_token, undefined as never)).toBeNull();
    const refresh = await form("/api/auth/oauth2/token", {
      grant_type: "refresh_token",
      refresh_token: oldTokens.refresh_token,
      client_id: CLIENT_ID,
    });
    expect(refresh.status).toBe(400);
    expect((await json(refresh)).error).toBe("invalid_grant");
    const session = await app.request(`${BASE}/api/auth/get-session`, { headers: { cookie: oldCookie } });
    expect(await session.text()).toMatch(/^(null|)$/);
    const dev = await f.admin.query("SELECT revoked_at FROM device WHERE id = $1", [u1.device]);
    expect(dev.rows[0]?.revoked_at).not.toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect(notifications.slice(before)).toContainEqual({ user_id: u1.id, scope: "session", id: "*" });
    const audit = await f.admin.query(
      "SELECT metadata FROM audit_log WHERE action = 'auth.password_changed' AND actor_id = $1 ORDER BY id DESC LIMIT 1",
      [u1.id],
    );
    expect(audit.rows[0]?.metadata).toMatchObject({ via: "security_code" });
    const acct = await f.admin.query('SELECT password FROM account WHERE "userId" = $1', [u1.id]);
    expect(String(acct.rows[0]?.password)).toMatch(/^\$argon2id\$/);
    await assertPlainCodeNotStored(u1.id, SECURITY_CODE_2);
    expect(
      await rt.services.password?.verify({ hash: String(acct.rows[0]?.password), password: PASSWORD_2 }),
    ).toBe(true);

    // 新密码登录，同一台设备重新拿 token，后面的用例继续用
    u1.cookie = await signIn(u1, PASSWORD_2);
    const again = await pkceLogin(u1.cookie, u1.device);
    expect(again.status, await again.clone().text()).toBe(200);
    u1.tokens = await json<Tokens>(again);
  });

  it("安全码重置密码：同一 ip+email 15 分钟内第 6 次 → 429", async () => {
    const email = `ratelimit-${RUN}@test.invalid`;
    for (let i = 0; i < 5; i++) {
      const res = await app.request(`${BASE}/v1/auth/reset-with-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, security_code: `guess-${i}`, new_password: PASSWORD_2 }),
      });
      expect(res.status).toBe(400);
    }
    const sixth = await app.request(`${BASE}/v1/auth/reset-with-code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, security_code: "guess-6", new_password: PASSWORD_2 }),
    });
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toBeTruthy();
  });

  it("refresh：新 token 沿用设备绑定；revoke：access 立即失效、设备 revoked_at、审计 + NOTIFY(session)", async () => {
    const before = notifications.length;
    const first = u1.tokens as Tokens;
    const res = await form("/api/auth/oauth2/token", {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
      client_id: CLIENT_ID,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const next = await json<Tokens>(res);
    expect(next.refresh_token).not.toBe(first.refresh_token);
    const ctx = await rt.verifyBearer(next.access_token, undefined as never);
    expect(ctx?.deviceId).toBe(u1.device);

    const revoke = await form("/api/auth/oauth2/revoke", {
      token: next.refresh_token,
      token_type_hint: "refresh_token",
      client_id: CLIENT_ID,
    });
    expect(revoke.status, await revoke.clone().text()).toBe(200);
    expect(await rt.verifyBearer(next.access_token, undefined as never)).toBeNull();
    const dev = await f.admin.query("SELECT revoked_at FROM device WHERE id = $1", [u1.device]);
    expect(dev.rows[0]?.revoked_at).not.toBeNull();
    const audit = await f.admin.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.device_revoked' AND target_id = $1",
      [u1.device],
    );
    expect(audit.rows[0]?.n).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(notifications.slice(before)).toContainEqual({ user_id: u1.id, scope: "session", id: u1.device });

    // 重新登录同一台设备：revoked_at 清空
    const again = await pkceLogin(u1.cookie, u1.device);
    expect(again.status).toBe(200);
    u1.tokens = await json<Tokens>(again);
    const dev2 = await f.admin.query("SELECT revoked_at FROM device WHERE id = $1", [u1.device]);
    expect(dev2.rows[0]?.revoked_at).toBeNull();
  });

  it("设备码流程：/device/code → /device/approve（cookie）→ /oauth2/token device_code grant → 同一组 token；审计 auth.device_requested", async () => {
    const dc = await post("/api/auth/device/code", { client_id: CLIENT_ID, scope: SCOPE }, { origin: "" });
    expect(dc.status, await dc.clone().text()).toBe(200);
    const body = await json<{
      device_code: string;
      user_code: string;
      verification_uri: string;
      interval: number;
      expires_in: number;
    }>(dc);
    expect(body.user_code.replace(/-/g, "")).toHaveLength(8);
    expect(body.verification_uri).toBe(`${APP_ORIGIN}/device`);
    expect(body.interval).toBe(5);
    expect(body.expires_in).toBe(1800);
    // Web /device 页：已登录会话先 GET /device?user_code= 认领（显示设备信息），再 approve —— 1.7.3 插件硬要求这一步
    const verify = await app.request(
      `${BASE}/api/auth/device?user_code=${encodeURIComponent(body.user_code)}`,
      {
        headers: { cookie: u1.cookie },
      },
    );
    expect(verify.status, await verify.clone().text()).toBe(200);
    const approve = await post(
      "/api/auth/device/approve",
      { userCode: body.user_code },
      { cookie: u1.cookie },
    );
    expect(approve.status, await approve.clone().text()).toBe(200);
    const device2 = uuidv7();
    const tok = await form("/api/auth/oauth2/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: body.device_code,
      client_id: CLIENT_ID,
      device_id: device2,
      device_name: "Laptop",
      platform: "macos",
      app_version: "0.1.0",
    });
    expect(tok.status, await tok.clone().text()).toBe(200);
    const tokens = await json<Tokens>(tok);
    const ctx = await rt.verifyBearer(tokens.access_token, undefined as never);
    expect(ctx).toMatchObject({ userId: u1.id, deviceId: device2 });
    const audit = await f.admin.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.device_requested'",
    );
    expect(audit.rows[0]?.n).toBeGreaterThan(0);
  });

  it("Free 计划第 3 台设备 → 403 device_limit_reached，且签发的 token 已作废；撤销一台后可再登录", async () => {
    const device3 = uuidv7();
    const res = await pkceLogin(u1.cookie, device3);
    expect(res.status).toBe(403);
    const body = await json<{ error: string; limit: number }>(res);
    expect(body).toMatchObject({ error: "device_limit_reached", limit: 2 });
    const bind = await f.admin.query(
      "SELECT count(*)::int AS n FROM oauth_refresh_device WHERE device_id = $1",
      [device3],
    );
    expect(bind.rows[0]?.n).toBe(0);

    const devices = await v1("GET", "/me/devices", (u1.tokens as Tokens).access_token);
    const list = await json<{ devices: Array<{ id: string; current: boolean; revoked_at: string | null }> }>(
      devices,
    );
    expect(list.devices.filter((d) => !d.revoked_at)).toHaveLength(2);
    const other = list.devices.find((d) => d.id !== u1.device) as { id: string };
    const del = await v1("DELETE", `/me/devices/${other.id}`, (u1.tokens as Tokens).access_token);
    expect(del.status, await del.clone().text()).toBe(200);
    const ok = await pkceLogin(u1.cookie, device3);
    expect(ok.status).toBe(200);
    await v1("DELETE", `/me/devices/${device3}`, (u1.tokens as Tokens).access_token);
  });

  it("org：创建（owner + 默认「共享区」workspace）→ 详情 → Free 席位闸门 409 seat_limit", async () => {
    const t = (u1.tokens as Tokens).access_token;
    const created = await v1("POST", "/orgs", t, { name: "Acme 便笺" });
    expect(created.status, await created.clone().text()).toBe(201);
    const body = await json<{
      org: { id: string; slug: string; role: string };
      default_workspace_id: string;
    }>(created);
    orgId = body.org.id;
    expect(body.org.role).toBe("owner");
    const ws = await f.admin.query("SELECT kind, name FROM workspaces WHERE id = $1", [
      body.default_workspace_id,
    ]);
    expect(ws.rows[0]).toMatchObject({ kind: "team", name: "共享区" });

    const missing = await v1("GET", `/orgs/${orgId}`, t);
    expect(missing.status).toBe(400);
    expect((await json(missing)).error).toBe("no_active_organization");

    const detail = await v1("GET", `/orgs/${orgId}`, t, undefined, { "x-organization-id": orgId });
    expect(detail.status).toBe(200);
    expect((await json<{ org: Record<string, unknown> }>(detail)).org).toMatchObject({
      plan: "free",
      seats_paid: 1,
      active_seats: 1,
      role: "owner",
    });

    const invite = await v1(
      "POST",
      `/orgs/${orgId}/invites`,
      t,
      { email: u2.email, role: "member" },
      { "x-organization-id": orgId },
    );
    expect(invite.status).toBe(409);
    expect((await json(invite)).error).toBe("seat_limit");
  });

  it("邀请：seats_paid=3 后发出（响应带 invite_url，邮件同链接，库里只存 hash）；匿名预览；第二个用户不验证邮箱也能接受", async () => {
    await f.admin.query("UPDATE organization SET seats_paid = 3 WHERE id = $1", [orgId]);
    const t = (u1.tokens as Tokens).access_token;
    const invite = await v1(
      "POST",
      `/orgs/${orgId}/invites`,
      t,
      { email: u2.email.toUpperCase(), role: "member" },
      { "x-organization-id": orgId },
    );
    expect(invite.status, await invite.clone().text()).toBe(201);
    const inv = await json<{
      invitation: { id: string; email: string; status: string };
      invite_url: string;
    }>(invite);
    expect(inv.invitation.email).toBe(u2.email);
    expect(JSON.stringify(inv.invitation)).not.toMatch(/token/);
    // 无邮件服务时邀请人靠这个链接：${APP_ORIGIN}/invite/<token>
    expect(inv.invite_url).toMatch(new RegExp(`^${APP_ORIGIN}/invite/[A-Za-z0-9_-]{43}$`));
    inviteToken = inv.invite_url.slice(`${APP_ORIGIN}/invite/`.length);
    const mail = await waitForMail((m) => m.template === "invite" && m.to === u2.email);
    expect(String(mail.vars.url)).toBe(inv.invite_url);
    const resent = await v1("POST", `/orgs/${orgId}/invites/${inv.invitation.id}/resend`, t, undefined, {
      "x-organization-id": orgId,
    });
    expect(resent.status, await resent.clone().text()).toBe(200);
    const resentBody = await json<{ invite_url: string }>(resent);
    expect(resentBody.invite_url).toMatch(new RegExp(`^${APP_ORIGIN}/invite/[A-Za-z0-9_-]{43}$`));
    expect(resentBody.invite_url).not.toBe(inv.invite_url);
    inviteToken = resentBody.invite_url.slice(`${APP_ORIGIN}/invite/`.length);
    const stored = await f.admin.query("SELECT token_hash FROM invitation WHERE id = $1", [
      inv.invitation.id,
    ]);
    expect(stored.rows[0]?.token_hash).not.toBe(inviteToken);
    expect(stored.rows[0]?.token_hash).toHaveLength(43);

    const preview = await app.request(`${BASE}/v1/invites/${inviteToken}/preview`);
    expect(preview.status).toBe(200);
    expect((await json<{ invitation: Record<string, unknown> }>(preview)).invitation).toMatchObject({
      org_name: "Acme 便笺",
      inviter_name: "Alice",
      role: "member",
    });

    await signUp(u2);
    u2.cookie = await signIn(u2);
    const u2row = await f.admin.query('SELECT "emailVerified" FROM "user" WHERE id = $1', [u2.id]);
    expect(u2row.rows[0]?.emailVerified).toBe(false);
    const tok = await pkceLogin(u2.cookie, u2.device);
    expect(tok.status, await tok.clone().text()).toBe(200);
    u2.tokens = await json<Tokens>(tok);

    const wrong = await v1("POST", "/invites/accept", (u1.tokens as Tokens).access_token, {
      token: inviteToken,
    });
    expect(wrong.status).toBe(403);
    expect((await json(wrong)).error).toBe("invitation_email_mismatch");

    const accept = await v1("POST", "/invites/accept", u2.tokens.access_token, { token: inviteToken });
    expect(accept.status, await accept.clone().text()).toBe(200);
    expect((await json<{ member: { role: string } }>(accept)).member.role).toBe("member");
    await waitForMail((m) => m.template === "invite_accepted" && m.to === u1.email);

    const members = await v1("GET", `/orgs/${orgId}/members`, t, undefined, { "x-organization-id": orgId });
    const list = await json<{ members: Array<{ user_id: string; role: string }> }>(members);
    expect(list.members.map((m) => m.role).sort()).toEqual(["member", "owner"]);

    const again = await v1("POST", "/invites/accept", u2.tokens.access_token, { token: inviteToken });
    expect(again.status).toBe(404);
  });

  it("成员视角：可读 org；管理操作 403 insufficient_role + authz.denied 审计；owner 有其他成员时不能删账号", async () => {
    const t2 = (u2.tokens as Tokens).access_token;
    const detail = await v1("GET", `/orgs/${orgId}`, t2, undefined, { "x-organization-id": orgId });
    expect(detail.status).toBe(200);
    const denied = await v1(
      "POST",
      `/orgs/${orgId}/invites`,
      t2,
      { email: "carol@test.invalid", role: "member" },
      { "x-organization-id": orgId },
    );
    expect(denied.status).toBe(403);
    expect(await json(denied)).toMatchObject({
      error: "insufficient_role",
      required: { resource: "org", action: "admin" },
    });
    const audit = await f.admin.query(
      "SELECT outcome FROM audit_log WHERE action = 'authz.denied' AND actor_id = $1 AND org_id = $2",
      [u2.id, orgId],
    );
    expect(audit.rows[0]?.outcome).toBe("denied");

    const del = await v1("POST", "/me/delete", (u1.tokens as Tokens).access_token, { confirm: "DELETE" });
    expect(del.status).toBe(409);
    expect((await json(del)).error).toBe("transfer_ownership_first");
    const badBody = await v1("POST", "/me/delete", (u1.tokens as Tokens).access_token, {
      confirm: "DELETE",
      extra: 1,
    });
    expect(badBody.status).toBe(400);
  });

  it("团队：创建 → 加成员 → 移除成员 NOTIFY(team)", async () => {
    const t = (u1.tokens as Tokens).access_token;
    const h = { "x-organization-id": orgId };
    const created = await v1("POST", `/orgs/${orgId}/teams`, t, { name: "设计", color: "#ff8800" }, h);
    expect(created.status, await created.clone().text()).toBe(201);
    const teamId = (await json<{ team: { id: string } }>(created)).team.id;
    const add = await v1("PUT", `/orgs/${orgId}/teams/${teamId}/members/${u2.id}`, t, undefined, h);
    expect(add.status).toBe(200);
    expect((await json<{ member_count: number }>(add)).member_count).toBe(1);
    const before = notifications.length;
    const rm = await v1("DELETE", `/orgs/${orgId}/teams/${teamId}/members/${u2.id}`, t, undefined, h);
    expect(rm.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(notifications.slice(before)).toContainEqual({ user_id: u2.id, scope: "team", id: teamId });
  });

  it("移除成员：一次事务（status=removed, epoch+1, teamMember 清理）→ NOTIFY(org) → 缓存失效后成员立刻 404", async () => {
    const t = (u1.tokens as Tokens).access_token;
    const t2 = (u2.tokens as Tokens).access_token;
    const h = { "x-organization-id": orgId };
    expect((await v1("GET", `/orgs/${orgId}`, t2, undefined, h)).status).toBe(200);
    const before = notifications.length;
    const rm = await v1("DELETE", `/orgs/${orgId}/members/${u2.id}`, t, undefined, h);
    expect(rm.status, await rm.clone().text()).toBe(200);
    const row = await f.admin.query(
      'SELECT status, session_epoch, removed_at FROM member WHERE "organizationId" = $1 AND "userId" = $2',
      [orgId, u2.id],
    );
    expect(row.rows[0]?.status).toBe("removed");
    expect(row.rows[0]?.session_epoch).toBeGreaterThanOrEqual(1);
    expect(row.rows[0]?.removed_at).not.toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect(notifications.slice(before)).toContainEqual({ user_id: u2.id, scope: "org", id: orgId });
    expect((await v1("GET", `/orgs/${orgId}`, t2, undefined, h)).status).toBe(404);
    const audit = await f.admin.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'member.removed' AND target_id = $1 AND org_id = $2",
      [u2.id, orgId],
    );
    expect(audit.rows[0]?.n).toBe(1);
    const me2 = await json<{ orgs: unknown[] }>(await v1("GET", "/me", t2));
    expect(me2.orgs).toEqual([]);
  });

  it("账号软删：deleted_at / deletion_due_at(+30d)，token 立即失效，邮件 account_deletion_scheduled", async () => {
    const t2 = (u2.tokens as Tokens).access_token;
    const del = await v1("POST", "/me/delete", t2, { confirm: "DELETE" });
    expect(del.status, await del.clone().text()).toBe(202);
    const body = await json<{ deletion_due_at: string }>(del);
    expect(new Date(body.deletion_due_at).getTime() - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000);
    expect(await rt.verifyBearer(t2, undefined as never)).toBeNull();
    await waitForMail((m) => m.template === "account_deletion_scheduled" && m.to === u2.email);
    const user = await f.admin.query('SELECT deleted_at FROM "user" WHERE id = $1', [u2.id]);
    expect(user.rows[0]?.deleted_at).not.toBeNull();
  });

  it("每条 /v1 响应都带 server_time；未知 body 字段被 strict 拒绝", async () => {
    const t = (u1.tokens as Tokens).access_token;
    const res = await v1("POST", "/orgs", t, { name: "X", bogus: true });
    expect(res.status).toBe(400);
    const body = await json<{ error: string; server_time: number; issues: unknown[] }>(res);
    expect(body.error).toBe("validation_failed");
    expect(typeof body.server_time).toBe("number");
  });

  it("明文安全码从未出现在任何日志行里", () => {
    expect(logLines.length).toBeGreaterThan(0);
    const all = logLines.join("");
    expect(all).not.toContain(SECURITY_CODE.trim());
    expect(all).not.toContain(SECURITY_CODE_2);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(PASSWORD_2);
  });

  it("admin pool sanity", () => {
    expect((f.admin as pg.Pool).totalCount).toBeGreaterThanOrEqual(0);
  });
});
