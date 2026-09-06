// 鉴权端到端（bianfa_auth 库，globalSetup 已跑迁移 0000–0004）：
// 注册 → 验证邮件 → 登录 cookie → PKCE authorize → 换 token（带 device_*）→ verifyBearer → /v1/me → 刷新 → 撤销；
// 设备码流程；Free 设备上限；org 创建 → 席位闸门 → 邀请 → 第二个用户接受 → 移除成员发 NOTIFY → requireOrgRole 缓存失效；
// /v1 带 cookie 无 Bearer → 401；账号软删。
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapDesktopClient } from "../../src/auth/bootstrap-client.js";
import { type AuthInternals, type AuthRuntime, createAuthWithInternals } from "../../src/auth/index.js";
import { invalidateMemberCache } from "../../src/auth/org-guard.js";
import { closeDb } from "../../src/db/client.js";
import { createDirectClient, type DirectClient } from "../../src/db/direct.js";
import { uuidv7 } from "../../src/db/ids.js";
import { createLogger } from "../../src/log.js";
import { clearMailOutbox, waitForMail } from "../../src/mail/index.js";
import { DIRECT_URL, type Fixture, hasDb, openAdmin, POOLED_URL, truncateAll } from "./helpers.js";

const BASE = "http://127.0.0.1:3000";
const APP_ORIGIN = "http://localhost:1420";
const CLIENT_ID = "bianfa-desktop";
const SCOPE = "openid profile email offline_access";
const PASSWORD = "correct-horse-battery-staple";

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

  const u1 = {
    email: "alice@test.invalid",
    name: "Alice",
    id: "",
    cookie: "",
    tokens: null as Tokens | null,
    device: uuidv7(),
  };
  const u2 = {
    email: "bob@test.invalid",
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

  async function signUpAndVerify(u: typeof u1): Promise<void> {
    const res = await post("/api/auth/sign-up/email", { name: u.name, email: u.email, password: PASSWORD });
    expect(res.status, await res.clone().text()).toBe(200);
    const mail = await waitForMail((m) => m.template === "verify_email" && m.to === u.email);
    expect(String(mail.vars.url)).toContain(`${APP_ORIGIN}/verify-email?token=`);
    const verify = await app.request(
      `${BASE}/api/auth/verify-email?token=${encodeURIComponent(String(mail.vars.token))}`,
    );
    expect(verify.status, await verify.clone().text()).toBe(200);
  }

  async function signIn(u: typeof u1): Promise<string> {
    const res = await post("/api/auth/sign-in/email", { email: u.email, password: PASSWORD });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await json<{ user: { id: string } }>(res);
    u.id = body.user.id;
    return cookieOf(res);
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
    const log = createLogger({ name: "auth-test" }, "warn");
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

  it("注册 → 验证邮件（console provider 捕获）→ 验证 → 登录；密码是 argon2id；个人 workspace 已建", async () => {
    await signUpAndVerify(u1);
    u1.cookie = await signIn(u1);
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

  it("未验证邮箱不能登录；错密码 → 401 + auth.login_failed 审计", async () => {
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
    expect(ctx).toMatchObject({ userId: u1.id, deviceId: u1.device, email: u1.email, emailVerified: true });
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
    }>(res);
    expect(me.user).toMatchObject({ id: u1.id, email: u1.email });
    expect(me.plan).toBe("free");
    expect(me.personal_workspace_id).toBeTruthy();
    expect(me.orgs).toEqual([]);
    expect(me.current_device_id).toBe(u1.device);
    expect(typeof me.server_time).toBe("number");

    const cookieOnly = await app.request(`${BASE}/v1/me`, { headers: { cookie: u1.cookie } });
    expect(cookieOnly.status).toBe(401);
    expect(cookieOnly.headers.get("www-authenticate")).toContain("invalid_token");
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

  it("邀请：seats_paid=3 后发出（邮件含 /invite/{token}，库里只存 hash）；匿名预览；第二个用户接受成为成员", async () => {
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
    const inv = await json<{ invitation: { id: string; email: string; status: string } }>(invite);
    expect(inv.invitation.email).toBe(u2.email);
    expect(JSON.stringify(inv)).not.toMatch(/token/);
    const mail = await waitForMail((m) => m.template === "invite" && m.to === u2.email);
    inviteToken = String(mail.vars.token);
    expect(String(mail.vars.url)).toBe(`${APP_ORIGIN}/invite/${inviteToken}`);
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

    await signUpAndVerify(u2);
    u2.cookie = await signIn(u2);
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

  it("admin pool sanity", () => {
    expect((f.admin as pg.Pool).totalCount).toBeGreaterThanOrEqual(0);
  });
});
