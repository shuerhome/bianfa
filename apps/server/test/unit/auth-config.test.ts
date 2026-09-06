// 单测：鉴权 env 解析（test 缺省 / production 必填）、requireOrgRole 缓存工具、审计 CSV。
import { describe, expect, it } from "vitest";
import { loadAuthEnv, TEST_APP_ORIGIN, TEST_AUTH_SECRET, TEST_BASE_URL } from "../../src/auth/env.js";
import { invalidateMemberCache, isOrgRole, memberCacheSize, roleAtLeast } from "../../src/auth/org-guard.js";
import { auditToCsv } from "../../src/auth/services/audit-query.js";
import { slugify } from "../../src/auth/services/orgs.js";

const DSN = "postgres://u:p@db:5432/bianfa";

describe("auth env", () => {
  it("NODE_ENV=test 缺省：baseURL / secret / APP_ORIGIN 都有值（.env.test 存在时以文件为准）", () => {
    const env = loadAuthEnv({ NODE_ENV: "test", DATABASE_URL: DSN });
    expect(env.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:3000$/);
    expect(env.secret.length).toBeGreaterThanOrEqual(32);
    expect(env.appOrigins.length).toBeGreaterThan(0);
    expect(env.secureCookies).toBe(false);
    expect(env.isTest).toBe(true);
  });

  it("development 无文件时用内置缺省", () => {
    const env = loadAuthEnv({ NODE_ENV: "development", DATABASE_URL: DSN });
    expect(env.baseURL).toBe(TEST_BASE_URL);
    expect(env.secret).toBe(TEST_AUTH_SECRET);
    expect(env.appOrigin).toBe(TEST_APP_ORIGIN);
  });

  it("production：BETTER_AUTH_SECRET / URL / APP_ORIGIN 必填，APP_ORIGIN 逗号列表被拆开", () => {
    expect(() => loadAuthEnv({ NODE_ENV: "production", DATABASE_URL: DSN })).toThrow(/BETTER_AUTH_URL/);
    expect(() =>
      loadAuthEnv({ NODE_ENV: "production", DATABASE_URL: DSN, BETTER_AUTH_URL: "https://api.bianfa.app" }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      loadAuthEnv({
        NODE_ENV: "production",
        DATABASE_URL: DSN,
        BETTER_AUTH_URL: "https://api.bianfa.app",
        BETTER_AUTH_SECRET: "x".repeat(48),
      }),
    ).toThrow(/APP_ORIGIN/);
    const env = loadAuthEnv({
      NODE_ENV: "production",
      DATABASE_URL: DSN,
      BETTER_AUTH_URL: "https://api.bianfa.app/",
      BETTER_AUTH_SECRET: "x".repeat(48),
      APP_ORIGIN: "https://app.bianfa.app, tauri://localhost,http://tauri.localhost",
    });
    expect(env.appOrigins).toEqual(["https://app.bianfa.app", "tauri://localhost", "http://tauri.localhost"]);
    expect(env.appOrigin).toBe("https://app.bianfa.app");
    expect(env.baseURL).toBe("https://api.bianfa.app");
    expect(env.secureCookies).toBe(true);
  });

  it("短 secret 被拒", () => {
    expect(() => loadAuthEnv({ NODE_ENV: "test", DATABASE_URL: DSN, BETTER_AUTH_SECRET: "short" })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });
});

describe("org 角色工具", () => {
  it("roleAtLeast / isOrgRole", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "owner")).toBe(false);
    expect(roleAtLeast("member", "member")).toBe(true);
    expect(isOrgRole("guest")).toBe(false);
  });
  it("invalidateMemberCache 无参全清", () => {
    invalidateMemberCache();
    expect(memberCacheSize()).toBe(0);
  });
  it("slugify", () => {
    expect(slugify("Acme Inc.")).toBe("acme-inc");
    expect(slugify("便笺团队")).toBe("便笺团队");
    expect(slugify("!!!")).toBe("org");
  });
});

describe("audit csv", () => {
  it("转义逗号 / 引号 / 换行，JSON 列序列化", () => {
    const csv = auditToCsv([
      {
        id: "1",
        at: "2026-01-01T00:00:00.000Z",
        actor_type: "user",
        actor_id: "u",
        actor_device_id: null,
        action: "member.removed",
        target_type: "user",
        target_id: "v",
        outcome: "success",
        before: { role: "admin" },
        after: null,
        metadata: { note: 'say "hi", ok\nnext' },
        request_id: null,
      },
    ]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toMatch(/^id,at,/);
    expect(lines[1]).toContain('"{""role"":""admin""}"');
    expect(lines[1]).toContain("member.removed");
  });
});
