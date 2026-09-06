import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../src/db/ids.js";
import { DEV_SYNC_TOKEN_SECRET, loadApiEnv, parseOrigins, r2ConfigFromEnv } from "../../src/http/env.js";
import { emailLower, LIMITS, listLimit, noteColor, uuidV7, zMode } from "../../src/http/validate.js";
import { noticeEnvelopeSchema } from "../../src/services/notice.js";

const DSN = "postgres://u:p@db.internal:5432/bianfa";

describe("校验限值（规格 04 §7.3）", () => {
  it("硬限常量", () => {
    expect(LIMITS.listMax).toBe(500);
    expect(LIMITS.batchMax).toBe(200);
    expect(LIMITS.titleMax).toBe(200);
    expect(LIMITS.commentMax).toBe(4000);
    expect(LIMITS.bodyBytesMax).toBe(256 * 1024);
  });

  it("UUID 必须是 v7", () => {
    expect(uuidV7.safeParse(uuidv7()).success).toBe(true);
    expect(uuidV7.safeParse(crypto.randomUUID()).success).toBe(false);
    expect(uuidV7.safeParse("not-a-uuid").success).toBe(false);
  });

  it("email 小写归一化", () => {
    expect(emailLower.parse("  Foo.Bar@Example.COM ")).toBe("foo.bar@example.com");
    expect(emailLower.safeParse("nope").success).toBe(false);
  });

  it("limit ≤ 500，缺省 100", () => {
    expect(listLimit.parse(undefined)).toBe(100);
    expect(listLimit.parse("500")).toBe(500);
    expect(listLimit.safeParse("501").success).toBe(false);
    expect(listLimit.safeParse("0").success).toBe(false);
  });

  it("颜色 / zMode 枚举", () => {
    expect(noteColor.safeParse("azure").success).toBe(true);
    expect(noteColor.safeParse("#fff").success).toBe(false);
    expect(zMode.safeParse(2).success).toBe(true);
    expect(zMode.safeParse(3).success).toBe(false);
  });

  it("notice 信封形状（规格 04 §7.8）", () => {
    expect(noticeEnvelopeSchema.safeParse({ v: 1, payload: "eyJhIjoxfQ", sig: "AAAA" }).success).toBe(true);
    expect(noticeEnvelopeSchema.safeParse({ v: 2, payload: "x", sig: "y" }).success).toBe(false);
    expect(noticeEnvelopeSchema.safeParse({ v: 1, payload: "x", sig: "y", extra: 1 }).success).toBe(false);
  });
});

describe("api env（规格 08 X12：可选项缺省即关闭）", () => {
  it("test 环境只给 DATABASE_URL 也能启动：SYNC_TOKEN_SECRET 取 .env.test 或开发缺省，R2 关闭", () => {
    const env = loadApiEnv({ NODE_ENV: "test", DATABASE_URL: DSN });
    expect(env.SYNC_TOKEN_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(env.PORT).toBe(3000);
    expect(env.APP_ORIGINS.length).toBeGreaterThan(0);
    expect(r2ConfigFromEnv(env)).toBeNull();
  });

  it("development 无 .env.test 时用固定 48 字符开发密钥", () => {
    const env = loadApiEnv({ NODE_ENV: "development", DATABASE_URL: DSN });
    expect(env.SYNC_TOKEN_SECRET).toBe(DEV_SYNC_TOKEN_SECRET);
    expect(DEV_SYNC_TOKEN_SECRET).toHaveLength(48);
    expect(env.APP_ORIGIN).toBe("http://localhost:5173");
  });

  it("production 必须显式给 SYNC_TOKEN_SECRET", () => {
    expect(() => loadApiEnv({ NODE_ENV: "production", DATABASE_URL: DSN })).toThrow(/SYNC_TOKEN_SECRET/);
    expect(() =>
      loadApiEnv({ NODE_ENV: "production", DATABASE_URL: DSN, SYNC_TOKEN_SECRET: "short" }),
    ).toThrow();
  });

  it("APP_ORIGIN 逗号分隔、去空白；R2 四件套齐全才启用", () => {
    expect(parseOrigins(" https://app.bianfa.app, tauri://localhost ,")).toEqual([
      "https://app.bianfa.app",
      "tauri://localhost",
    ]);
    expect(
      r2ConfigFromEnv({
        R2_ACCOUNT_ID: "acc",
        R2_ATTACHMENTS_ACCESS_KEY_ID: "k",
        R2_ATTACHMENTS_SECRET_ACCESS_KEY: "s",
      }),
    ).toMatchObject({ endpoint: "https://acc.r2.cloudflarestorage.com", bucket: "bianfa-attachments" });
    expect(r2ConfigFromEnv({ R2_ACCOUNT_ID: "acc" })).toBeNull();
  });
});
