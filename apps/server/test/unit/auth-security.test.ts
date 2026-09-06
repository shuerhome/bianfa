// 单测：argon2、token 哈希、内存限流、列加密、安全头、CORS、requireBearer（cookie-only → 401）、邮件模板。
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type AuthVariables, requireBearer } from "../../src/auth/index.js";
import { renderMail } from "../../src/mail/index.js";
import {
  ARGON2_PARAMS,
  corsFor,
  createColumnCrypto,
  createMemoryRateLimitBackend,
  hashPassword,
  isUuidLike,
  parseOrigins,
  randomToken,
  rateLimit,
  SECURITY_HEADERS,
  securityHeaders,
  sha256Base64url,
  verifyPassword,
} from "../../src/security/index.js";

describe("argon2id", () => {
  it("hash/verify 往返，参数 m=19456 t=2 p=1，错密码 false", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(h).toContain(
      `m=${ARGON2_PARAMS.memoryCost},t=${ARGON2_PARAMS.timeCost},p=${ARGON2_PARAMS.parallelism}`,
    );
    expect(await verifyPassword({ hash: h, password: "correct horse battery staple" })).toBe(true);
    expect(await verifyPassword({ hash: h, password: "wrong" })).toBe(false);
    expect(await verifyPassword({ hash: "not-a-hash", password: "x" })).toBe(false);
  });
});

describe("token 工具", () => {
  it("randomToken 32B → 43 字符 base64url，两次不同", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).toHaveLength(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
  it("sha256Base64url 确定且 43 字符", () => {
    expect(sha256Base64url("abc")).toBe(sha256Base64url("abc"));
    expect(sha256Base64url("abc")).toHaveLength(43);
    expect(sha256Base64url("abc")).not.toBe(sha256Base64url("abd"));
  });
  it("isUuidLike", () => {
    expect(isUuidLike("0190f1a2-3b4c-7d5e-8f6a-1b2c3d4e5f60")).toBe(true);
    expect(isUuidLike("nope")).toBe(false);
    expect(isUuidLike(42)).toBe(false);
  });
});

describe("滑动窗口限流（内存后端）", () => {
  it("窗口内超过 limit 拒绝，窗口滑过后放行", async () => {
    const b = createMemoryRateLimitBackend();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect((await b.consume("k", 3, 10, t0 + i)).allowed).toBe(true);
    const denied = await b.consume("k", 3, 10, t0 + 5);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect((await b.consume("k", 3, 10, t0 + 10_001)).allowed).toBe(true);
    expect((await b.consume("other", 3, 10, t0 + 5)).allowed).toBe(true);
  });

  it("中间件：429 + Retry-After，key 为 null 时跳过", async () => {
    const app = new Hono();
    app.get(
      "/x",
      rateLimit({
        key: (c) => c.req.header("x-k") ?? null,
        limit: 2,
        windowSeconds: 60,
        backend: createMemoryRateLimitBackend(),
      }),
      (c) => c.text("ok"),
    );
    expect((await app.request("/x", { headers: { "x-k": "a" } })).status).toBe(200);
    expect((await app.request("/x", { headers: { "x-k": "a" } })).status).toBe(200);
    const r = await app.request("/x", { headers: { "x-k": "a" } });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await r.json()).toMatchObject({ error: "rate_limited" });
    expect((await app.request("/x")).status).toBe(200);
    expect((await app.request("/x")).status).toBe(200);
    expect((await app.request("/x")).status).toBe(200);
  });
});

describe("列加密（XChaCha20-Poly1305）", () => {
  const key1 = Buffer.alloc(32, 1).toString("base64");
  const key2 = Buffer.alloc(32, 2).toString("base64");

  it("往返 + AAD 绑定 + 密钥轮换后旧密文仍可解", () => {
    const c1 = createColumnCrypto({ DATA_KEY_1: key1, DATA_KEY_ACTIVE: "1" });
    expect(c1.enabled).toBe(true);
    const ct = c1.encrypt("secret 秘密", "row-1");
    expect(ct.startsWith("v1.1.")).toBe(true);
    expect(c1.decrypt(ct, "row-1")).toBe("secret 秘密");
    expect(() => c1.decrypt(ct, "row-2")).toThrow();
    const c2 = createColumnCrypto({ DATA_KEY_1: key1, DATA_KEY_2: key2, DATA_KEY_ACTIVE: "2" });
    expect(c2.activeKeyId).toBe(2);
    expect(c2.decrypt(ct, "row-1")).toBe("secret 秘密");
    expect(c2.keyIdOf(c2.encrypt("x"))).toBe(2);
    const c3 = createColumnCrypto({ DATA_KEY_2: key2, DATA_KEY_ACTIVE: "2" });
    expect(() => c3.decrypt(ct, "row-1")).toThrow(/DATA_KEY_1/);
  });

  it("未配置密钥 → 透传模式（v0），不崩溃", () => {
    const c = createColumnCrypto({});
    expect(c.enabled).toBe(false);
    const v = c.encrypt("plain");
    expect(v.startsWith("v0.")).toBe(true);
    expect(c.decrypt(v)).toBe("plain");
    expect(c.keyIdOf(v)).toBe(0);
  });

  it("非法密钥长度 / ACTIVE 指向不存在的 key 报错", () => {
    expect(() => createColumnCrypto({ DATA_KEY_1: "short" })).toThrow(/32/);
    expect(() => createColumnCrypto({ DATA_KEY_1: key1, DATA_KEY_ACTIVE: "9" })).toThrow(/DATA_KEY_9/);
  });
});

describe("securityHeaders / corsFor", () => {
  it("所有响应带规格 §7.2 头，且无 X-Powered-By", async () => {
    const app = new Hono();
    app.use("*", securityHeaders());
    app.get("/", (c) => {
      c.header("X-Powered-By", "hono");
      return c.text("ok");
    });
    const r = await app.request("/");
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(r.headers.get(k)).toBe(v);
    expect(r.headers.get("x-powered-by")).toBeNull();
  });

  it("CORS 只精确匹配白名单 origin，不反射；预检 204", async () => {
    const app = new Hono();
    app.use("*", corsFor("https://app.bianfa.app, tauri://localhost"));
    app.get("/", (c) => c.text("ok"));
    const good = await app.request("/", { headers: { origin: "https://app.bianfa.app" } });
    expect(good.headers.get("access-control-allow-origin")).toBe("https://app.bianfa.app");
    expect(good.headers.get("access-control-allow-credentials")).toBe("true");
    expect(good.headers.get("vary")).toContain("Origin");
    const bad = await app.request("/", { headers: { origin: "https://evil.example" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await app.request("/", { method: "OPTIONS", headers: { origin: "tauri://localhost" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("PATCH");
    expect(pre.headers.get("access-control-allow-headers")).toContain("X-Organization-Id");
    expect(parseOrigins("a.com/, ,b.com")).toEqual(["a.com", "b.com"]);
  });
});

describe("requireBearer", () => {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use(
    "*",
    requireBearer(async (token) =>
      token === "good"
        ? { userId: "u1", sessionId: null, deviceId: null, email: "u@x", emailVerified: true, scopes: [] }
        : null,
    ),
  );
  app.get("/", (c) => c.json({ user: c.get("auth").userId }));

  it("只有 cookie 没有 Bearer → 401 + WWW-Authenticate", async () => {
    const r = await app.request("/", { headers: { cookie: "bianfa.session_token=abc" } });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(await r.json()).toEqual({ error: "unauthorized" });
  });
  it("无效 Bearer → 401；有效 → 200", async () => {
    expect((await app.request("/", { headers: { authorization: "Bearer bad" } })).status).toBe(401);
    const r = await app.request("/", { headers: { authorization: "Bearer good" } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ user: "u1" });
  });
});

describe("邮件模板", () => {
  it("双语渲染，链接进正文，不泄漏别的字段", () => {
    const m = renderMail("invite", {
      org_name: "Acme",
      inviter_name: "张三",
      role: "member",
      url: "https://app/invite/tok",
    });
    expect(m.subject).toContain("Acme");
    expect(m.text).toContain("https://app/invite/tok");
    expect(m.text).toContain("invited you");
    expect(m.text).toContain("邀请你");
    expect(m.html).toContain("&quot;Acme&quot;");
    const v = renderMail("verify_email", { url: "https://app/verify?token=<x>" });
    expect(v.html).toContain("&lt;x&gt;");
    const s = renderMail("security_alert", { reason: "test", devices: ["Mac (macos)"] });
    expect(s.text).toContain("Mac (macos)");
  });
});
