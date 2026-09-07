// 冻结 / 改密码的真实效果（迁移 0009）：这个文件跑的是**真的** Better Auth 运行时 —— 注册、密码登录、
// PKCE 换 token、设备码，全都走真实端点。admin-api.test.ts 用假 Bearer 覆盖接口契约，
// 「冻结之后到底还能不能登录」这种事只有真实路径能回答。
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapDesktopClient } from "../../src/auth/bootstrap-client.js";
import { type AuthInternals, type AuthRuntime, createAuthWithInternals } from "../../src/auth/index.js";
import { closeDb } from "../../src/db/client.js";
import { uuidv7 } from "../../src/db/ids.js";
import { grantPlatformAdmin } from "./admin-helpers.js";
import { type Fixture, hasDb, openAdmin, POOLED_URL, truncateAll } from "./helpers.js";

const BASE = "http://127.0.0.1:3000";
const APP_ORIGIN = "http://localhost:1420";
const CLIENT_ID = "bianfa-desktop";
const SCOPE = "openid profile email offline_access";
const PASSWORD = "correct-horse-battery-staple";
const NEW_PASSWORD = "reset-by-platform-admin-1";
const SECURITY_CODE = "我的小狗叫 Bobo";
/** 每次运行换邮箱，避免与同库里别的用例互相影响 */
const RUN = Date.now().toString(36);

interface Tokens {
  access_token: string;
  refresh_token: string;
}

interface Account {
  email: string;
  name: string;
  id: string;
  cookie: string;
  device: string;
  tokens: Tokens | null;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`non-json response ${res.status}: ${text.slice(0, 300)}`);
  }
}

describe.skipIf(!hasDb)("平台总管理员：冻结 / 改密码（真实 Better Auth 路径）", () => {
  let f: Fixture;
  let rt: AuthRuntime & AuthInternals;
  let app: Hono;

  const admin: Account = {
    email: `pa-admin-${RUN}@test.invalid`,
    name: "Admin",
    id: "",
    cookie: "",
    device: uuidv7(),
    tokens: null,
  };
  const target: Account = {
    email: `pa-target-${RUN}@test.invalid`,
    name: "Target",
    id: "",
    cookie: "",
    device: uuidv7(),
    tokens: null,
  };
  /** 冻结前批准、但还没兑换的设备码 */
  let pendingDeviceCode = "";

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
  const v1 = (method: string, path: string, token: string | null, body?: unknown) =>
    app.request(`${BASE}/v1${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  function cookieOf(res: Response): string {
    const raw = res.headers.getSetCookie?.() ?? [];
    const pairs = raw.map((c) => c.split(";")[0] as string).filter((p) => !p.endsWith("="));
    expect(pairs.length, "expected a session cookie").toBeGreaterThan(0);
    return pairs.join("; ");
  }

  async function signUp(u: Account): Promise<void> {
    const res = await post("/api/auth/sign-up/email", {
      name: u.name,
      email: u.email,
      password: PASSWORD,
      securityCode: SECURITY_CODE,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    u.id = (await json<{ user: { id: string } }>(res)).user.id;
  }

  async function signIn(u: Account, password = PASSWORD): Promise<Response> {
    return post("/api/auth/sign-in/email", { email: u.email, password });
  }

  async function signInOk(u: Account, password = PASSWORD): Promise<string> {
    const res = await signIn(u, password);
    expect(res.status, await res.clone().text()).toBe(200);
    return cookieOf(res);
  }

  /** cookie 会话 → PKCE authorize → 换一组设备令牌 */
  async function pkceLogin(u: Account, deviceId: string): Promise<Tokens> {
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const redirect = "http://127.0.0.1:43123/cb";
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirect,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: b64url(randomBytes(16)),
      scope: SCOPE,
    });
    const authz = await app.request(`${BASE}/api/auth/oauth2/authorize?${q}`, {
      headers: { cookie: u.cookie },
    });
    expect(authz.status, await authz.clone().text()).toBe(302);
    const code = new URL(authz.headers.get("location") as string).searchParams.get("code") as string;
    const res = await form("/api/auth/oauth2/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: redirect,
      device_id: deviceId,
      device_name: "Test Box",
      platform: "linux",
      app_version: "0.1.0",
    });
    expect(res.status, await res.clone().text()).toBe(200);
    return json<Tokens>(res);
  }

  beforeAll(async () => {
    f = openAdmin();
    await truncateAll(f.admin);
    await f.admin.query('TRUNCATE "oauthClient", "deviceCode", audit_log RESTART IDENTITY CASCADE');
    rt = await createAuthWithInternals({
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: POOLED_URL as string },
      db: f.adminDb,
      log: pino({ level: "silent" }),
    });
    app = new Hono();
    app.on(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"], "/api/auth/*", (c) =>
      rt.handler(c.req.raw),
    );
    app.route("/v1", rt.v1Routes);
    await bootstrapDesktopClient(f.adminDb);

    await signUp(admin);
    await signUp(target);
    admin.cookie = await signInOk(admin);
    target.cookie = await signInOk(target);
    admin.tokens = await pkceLogin(admin, admin.device);
    target.tokens = await pkceLogin(target, target.device);
    await grantPlatformAdmin(f.admin, admin.id, "flow-test");

    // 目标用户批准了一台新设备的设备码，但还没去换 token —— 冻结必须把它作废
    const dc = await post("/api/auth/device/code", { client_id: CLIENT_ID, scope: SCOPE }, { origin: "" });
    expect(dc.status, await dc.clone().text()).toBe(200);
    const code = await json<{ device_code: string; user_code: string }>(dc);
    pendingDeviceCode = code.device_code;
    const claim = await app.request(
      `${BASE}/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`,
      { headers: { cookie: target.cookie } },
    );
    expect(claim.status, await claim.clone().text()).toBe(200);
    const approve = await post(
      "/api/auth/device/approve",
      { userCode: code.user_code },
      { cookie: target.cookie },
    );
    expect(approve.status, await approve.clone().text()).toBe(200);
  });

  afterAll(async () => {
    await rt?.close();
    await truncateAll(f.admin);
    await f.admin.end();
    await closeDb();
  });

  it("冻结前：目标用户的 access token 正常、密码能登录、设备码等着兑换", async () => {
    const me = await v1("GET", "/me", (target.tokens as Tokens).access_token);
    expect(me.status, await me.clone().text()).toBe(200);
    const status = await f.admin.query('SELECT status FROM "deviceCode" WHERE "deviceCode" = $1', [
      pendingDeviceCode,
    ]);
    expect(status.rows[0]?.status).toBe("approved");
  });

  it("冻结（管理员带真实 Bearer 调用）→ 目标的 access token 立刻失效：verifyBearer 返回 null，/v1/me 401", async () => {
    const res = await v1("POST", `/admin/users/${target.id}/freeze`, (admin.tokens as Tokens).access_token, {
      reason: "违规",
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await json<{ ok: boolean }>(res)).toMatchObject({ ok: true });

    const token = (target.tokens as Tokens).access_token;
    expect(await rt.verifyBearer(token, undefined as never)).toBeNull();
    const me = await v1("GET", "/me", token);
    expect(me.status).toBe(401);
    // 管理员自己不受影响
    const adminMe = await v1("GET", "/me", (admin.tokens as Tokens).access_token);
    expect(adminMe.status).toBe(200);
  });

  it("冻结后：正确的密码也建不了新会话（session.create.before → 403 ACCOUNT_FROZEN）+ auth.sign_in_denied 审计", async () => {
    const res = await signIn(target);
    expect(res.status).toBe(403);
    expect(await json<{ code: string }>(res)).toMatchObject({ code: "ACCOUNT_FROZEN" });
    const sessions = await f.admin.query('SELECT count(*)::int AS n FROM session WHERE "userId" = $1', [
      target.id,
    ]);
    expect(sessions.rows[0]?.n).toBe(0);
    const denied = await f.admin.query(
      "SELECT outcome, metadata->>'reason' AS reason FROM audit_log WHERE action = 'auth.sign_in_denied' AND actor_id = $1",
      [target.id],
    );
    expect(denied.rows.length).toBeGreaterThan(0);
    expect(denied.rows[0]).toMatchObject({ outcome: "denied", reason: "frozen" });
  });

  it("冻结后：批准过但没兑换的设备码变成 denied，device_code grant 换不出 token", async () => {
    const status = await f.admin.query('SELECT status FROM "deviceCode" WHERE "deviceCode" = $1', [
      pendingDeviceCode,
    ]);
    expect(status.rows[0]?.status).toBe("denied");
    const res = await form("/api/auth/oauth2/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: pendingDeviceCode,
      client_id: CLIENT_ID,
      device_id: uuidv7(),
      device_name: "Laptop",
      platform: "macos",
      app_version: "0.1.0",
    });
    expect(res.status, await res.clone().text()).toBe(400);
    const body = await json<{ error: string; access_token?: string }>(res);
    expect(body.error).toBe("access_denied");
    expect(body.access_token).toBeUndefined();
  });

  it("解冻 → 恢复正常登录：能拿新会话，也能换出新的设备令牌", async () => {
    const res = await v1("POST", `/admin/users/${target.id}/unfreeze`, (admin.tokens as Tokens).access_token);
    expect(res.status, await res.clone().text()).toBe(200);

    target.cookie = await signInOk(target);
    target.device = uuidv7();
    target.tokens = await pkceLogin(target, target.device);
    const me = await v1("GET", "/me", target.tokens.access_token);
    expect(me.status, await me.clone().text()).toBe(200);
    expect(await json<{ user: { id: string } }>(me)).toMatchObject({ user: { id: target.id } });
  });

  it("改密码：旧密码失效、新密码能登录，全部设备令牌与 Web 会话被吊销", async () => {
    const oldToken = (target.tokens as Tokens).access_token;
    const res = await v1(
      "POST",
      `/admin/users/${target.id}/password`,
      (admin.tokens as Tokens).access_token,
      { new_password: NEW_PASSWORD },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await json<{ revoked_devices: number }>(res)).toMatchObject({ ok: true, revoked_devices: 1 });

    // 设备令牌：verify-bearer 拒绝；refresh 行删光；设备行全部 revoked
    expect(await rt.verifyBearer(oldToken, undefined as never)).toBeNull();
    expect((await v1("GET", "/me", oldToken)).status).toBe(401);
    const refresh = await f.admin.query(
      'SELECT count(*)::int AS n FROM "oauthRefreshToken" WHERE "userId" = $1',
      [target.id],
    );
    expect(refresh.rows[0]?.n).toBe(0);
    const devices = await f.admin.query(
      "SELECT count(*)::int AS n FROM device WHERE user_id = $1 AND revoked_at IS NULL",
      [target.id],
    );
    expect(devices.rows[0]?.n).toBe(0);
    // Web 会话
    const sessions = await f.admin.query('SELECT count(*)::int AS n FROM session WHERE "userId" = $1', [
      target.id,
    ]);
    expect(sessions.rows[0]?.n).toBe(0);
    const stale = await app.request(`${BASE}/api/auth/get-session`, { headers: { cookie: target.cookie } });
    expect(await stale.text()).not.toContain(target.id);

    // 旧密码不再能用，新密码可以
    const old = await signIn(target, PASSWORD);
    expect(old.status).toBe(401);
    target.cookie = await signInOk(target, NEW_PASSWORD);

    // 管理员自己的令牌与会话没被殃及
    expect((await v1("GET", "/me", (admin.tokens as Tokens).access_token)).status).toBe(200);
  });

  it("改密码留下 admin.password_set 审计，且 GET /v1/admin/audit 读得到全过程", async () => {
    const res = await v1("GET", "/admin/audit?limit=100", (admin.tokens as Tokens).access_token);
    expect(res.status).toBe(200);
    const body = await json<{ entries: Array<{ action: string; target_id: string; actor_id: string }> }>(res);
    const mine = body.entries.filter((e) => e.target_id === target.id);
    const actions = new Set(mine.map((e) => e.action));
    expect(actions.has("admin.user_frozen")).toBe(true);
    expect(actions.has("admin.user_unfrozen")).toBe(true);
    expect(actions.has("admin.password_set")).toBe(true);
    expect(actions.has("auth.sign_in_denied")).toBe(true);
    for (const e of mine.filter((x) => x.action.startsWith("admin."))) {
      expect(e.actor_id).toBe(admin.id);
    }
  });
});
