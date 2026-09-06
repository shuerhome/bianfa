// Web 面与 Better Auth 的桌面登录往返（apps/web 的 /login、/consent 依赖的服务端行为，逐条固定下来）：
//   未登录 GET /oauth2/authorize → 302 ${APP_ORIGIN}/login?<签名后的授权参数：client_id … state exp ba_iat ba_param sig>
//   POST /sign-in/email + oauth_query（客户端 fetch 插件按 ba_param 名单 + sig 重组）→ 200 JSON { redirect: true, url }
//     url = redirect_uri?code=…&state=…&iss=…（bianfa-desktop skip_consent，直接发 code；浏览器整页跳回 loopback）
//   POST /oauth2/consent { accept: false, oauth_query } → { redirect: true, url: redirect_uri?error=access_denied… }
//   签名被篡改 → 400 invalid_signature
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapDesktopClient } from "../../src/auth/bootstrap-client.js";
import { type AuthInternals, type AuthRuntime, createAuthWithInternals } from "../../src/auth/index.js";
import { closeDb } from "../../src/db/client.js";
import { createLogger } from "../../src/log.js";
import { clearMailOutbox } from "../../src/mail/index.js";
import { type Fixture, hasDb, openAdmin, POOLED_URL, truncateAll } from "./helpers.js";

const BASE = "http://127.0.0.1:3000";
const APP_ORIGIN = "http://localhost:1420";
const CLIENT_ID = "bianfa-desktop";
const REDIRECT = "http://127.0.0.1:43123/cb";
const PASSWORD = "correct-horse-battery-staple";
const SECURITY_CODE = "web-login-code";
const USER = { email: "web-login@test.invalid", name: "Web Login" };
const USER2 = { email: "web-signup@test.invalid", name: "Web Signup" };

/** 等价于 @better-auth/oauth-provider/client 的 buildSignedOAuthQuery：只保留 ba_param 列出的键 + sig */
function buildSignedOAuthQuery(search: string): string {
  const params = new URLSearchParams(search);
  const names = new Set(params.getAll("ba_param"));
  const out = new URLSearchParams();
  for (const [k, v] of params) if (k === "sig" || k === "ba_param" || names.has(k)) out.append(k, v);
  return out.toString();
}

function cookieOf(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw
    .map((c) => c.split(";")[0] as string)
    .filter((p) => !p.endsWith("="))
    .join("; ");
}

describe.skipIf(!hasDb)("web login round trip", () => {
  let f: Fixture;
  let rt: AuthRuntime & AuthInternals;
  let app: Hono;
  let state = "";
  let loginSearch = "";

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: APP_ORIGIN,
        // 浏览器 fetch 的特征：服务端据此回 JSON { redirect, url } 而不是 302
        "sec-fetch-mode": "cors",
        accept: "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    f = openAdmin();
    await truncateAll(f.admin);
    await f.admin.query('TRUNCATE "oauthClient", "deviceCode", audit_log RESTART IDENTITY CASCADE');
    clearMailOutbox();
    rt = await createAuthWithInternals({
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: POOLED_URL as string },
      db: f.adminDb,
      log: createLogger({ name: "web-login-test" }, "warn"),
    });
    app = new Hono();
    app.on(["GET", "POST"], "/api/auth/*", (c) => rt.handler(c.req.raw));
    await bootstrapDesktopClient(f.adminDb);
    // 注册 = 邮箱 + 密码 + 安全码；不需要验证邮件
    const res = await post("/api/auth/sign-up/email", {
      ...USER,
      password: PASSWORD,
      securityCode: SECURITY_CODE,
    });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  afterAll(async () => {
    await rt?.close();
    await f.admin.end();
    await closeDb();
  });

  it("未登录 authorize → 302 到 APP_ORIGIN/login，带签名后的原始授权参数", async () => {
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    state = randomBytes(16).toString("base64url");
    const q = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "openid profile email offline_access",
    });
    const authz = await app.request(`${BASE}/api/auth/oauth2/authorize?${q}`);
    expect(authz.status, await authz.clone().text()).toBe(302);
    const location = new URL(authz.headers.get("location") as string);
    loginSearch = location.search;
    expect(`${location.origin}${location.pathname}`).toBe(`${APP_ORIGIN}/login`);
    for (const k of ["client_id", "redirect_uri", "code_challenge", "state", "scope", "exp", "ba_iat", "sig"])
      expect(location.searchParams.get(k), k).toBeTruthy();
    expect(location.searchParams.get("state")).toBe(state);
    // ba_param = 参与签名的键名清单（sig 本身不在其中）；客户端插件据此重组 oauth_query
    const signed = location.searchParams.getAll("ba_param");
    for (const k of ["client_id", "redirect_uri", "code_challenge", "state", "scope", "exp", "ba_iat"])
      expect(signed, k).toContain(k);
  });

  it("sign-in/email + oauth_query → JSON { redirect: true, url: redirect_uri?code&state&iss }（skip_consent）", async () => {
    const res = await post("/api/auth/sign-in/email", {
      email: USER.email,
      password: PASSWORD,
      rememberMe: true,
      oauth_query: buildSignedOAuthQuery(loginSearch),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(cookieOf(res)).toMatch(/session_token/);
    const body = (await res.json()) as { redirect?: boolean; url?: string };
    expect(body.redirect).toBe(true);
    const url = new URL(body.url as string);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("code")).toBeTruthy();
    // iss = baseURL + basePath（桌面端校验 iss 时要按这个值比，不是裸 origin）
    expect(url.searchParams.get("iss")).toBe(`${BASE}/api/auth`);
  });

  it("sign-up/email + oauth_query → 注册即登录并直接回到桌面端：{ redirect: true, url: redirect_uri?code&state }", async () => {
    const res = await post("/api/auth/sign-up/email", {
      ...USER2,
      password: PASSWORD,
      securityCode: SECURITY_CODE,
      oauth_query: buildSignedOAuthQuery(loginSearch),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(cookieOf(res)).toMatch(/session_token/);
    const body = (await res.json()) as { redirect?: boolean; url?: string };
    expect(body.redirect).toBe(true);
    const url = new URL(body.url as string);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("code")).toBeTruthy();
  });

  it("oauth2/consent 拒绝 → { redirect: true, url: redirect_uri?error=access_denied&state }", async () => {
    const login = await post("/api/auth/sign-in/email", { email: USER.email, password: PASSWORD });
    const cookie = cookieOf(login);
    const res = await post(
      "/api/auth/oauth2/consent",
      { accept: false, oauth_query: buildSignedOAuthQuery(loginSearch) },
      { cookie },
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { redirect?: boolean; url?: string };
    expect(body.redirect).toBe(true);
    const url = new URL(body.url as string);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe(state);
  });

  it("篡改签名 → 400 invalid_signature（不会登录）", async () => {
    const tampered = buildSignedOAuthQuery(loginSearch).replace(/sig=[^&]+/, "sig=AAAA");
    const res = await post("/api/auth/sign-in/email", {
      email: USER.email,
      password: PASSWORD,
      oauth_query: tampered,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_signature" });
  });
});
