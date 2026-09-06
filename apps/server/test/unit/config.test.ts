import { describe, expect, it } from "vitest";
import { applyTestEnvFile, loadBaseEnv, normalizeEnv, TEST_ENV_FILE } from "../../src/config.js";

const DSN = "postgres://u:p@db.internal:5432/bianfa";
const DIRECT = "postgresql://u:p@postgres:5432/bianfa";

describe("config：DSN 与别名", () => {
  it("接受别名 DATABASE_DIRECT_URL（backend.yml），折叠到规范名 DATABASE_URL_DIRECT", () => {
    const env = loadBaseEnv({ NODE_ENV: "production", DATABASE_URL: DSN, DATABASE_DIRECT_URL: DIRECT });
    expect(env.DATABASE_URL_DIRECT).toBe(DIRECT);
  });

  it("规范名与别名同时存在时规范名优先", () => {
    const env = loadBaseEnv({
      NODE_ENV: "production",
      DATABASE_URL: DSN,
      DATABASE_URL_DIRECT: DIRECT,
      DATABASE_DIRECT_URL: "postgres://wrong@x/y",
    });
    expect(env.DATABASE_URL_DIRECT).toBe(DIRECT);
  });

  it("空串视为未设置（compose 的 X:- 缺省写法会注入空串），此时别名生效", () => {
    const out = normalizeEnv({ DATABASE_URL_DIRECT: "", DATABASE_DIRECT_URL: DIRECT, LOG_LEVEL: "" });
    expect(out.DATABASE_URL_DIRECT).toBe(DIRECT);
    expect("LOG_LEVEL" in out).toBe(false);
  });

  it("直连 DSN 可缺省（api / worker 没有这个变量）", () => {
    const env = loadBaseEnv({ NODE_ENV: "production", DATABASE_URL: DSN });
    expect(env.DATABASE_URL_DIRECT).toBeUndefined();
  });

  it("DATABASE_URL 缺失或不是 postgres DSN 时抛错并指出字段", () => {
    expect(() => loadBaseEnv({ NODE_ENV: "production" })).toThrow(/DATABASE_URL/);
    expect(() => loadBaseEnv({ NODE_ENV: "production", DATABASE_URL: "mysql://x/y" })).toThrow(
      /DATABASE_URL/,
    );
    expect(() =>
      loadBaseEnv({ NODE_ENV: "production", DATABASE_URL: DSN, DATABASE_DIRECT_URL: "nope" }),
    ).toThrow(/DATABASE_URL_DIRECT/);
  });

  it("NODE_ENV / LOG_LEVEL 有默认值，非法值拒绝", () => {
    const env = loadBaseEnv({ DATABASE_URL: DSN });
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
    expect(() => loadBaseEnv({ DATABASE_URL: DSN, LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
  });
});

describe("config：.env.test 只在 NODE_ENV=test 时读", () => {
  it("NODE_ENV=test：补入文件里的键，但不覆盖已设置的环境变量", () => {
    const raw: NodeJS.ProcessEnv = { NODE_ENV: "test", DATABASE_URL: DSN, LOG_LEVEL: "debug" };
    const env = loadBaseEnv(raw);
    expect(raw.BETTER_AUTH_SECRET).toBeTruthy(); // 来自 .env.test
    expect(env.LOG_LEVEL).toBe("debug"); // 环境变量优先于文件里的 warn
  });

  it("NODE_ENV=test 且未设置 LOG_LEVEL 时取文件值", () => {
    const env = loadBaseEnv({ NODE_ENV: "test", DATABASE_URL: DSN });
    expect(env.LOG_LEVEL).toBe("warn");
  });

  it("NODE_ENV=production：不读文件", () => {
    const raw: NodeJS.ProcessEnv = { NODE_ENV: "production", DATABASE_URL: DSN };
    loadBaseEnv(raw);
    expect(raw.BETTER_AUTH_SECRET).toBeUndefined();
    expect(raw.LOG_LEVEL).toBeUndefined();
  });

  it("文件不存在时静默忽略", () => {
    const raw: NodeJS.ProcessEnv = {};
    expect(() => applyTestEnvFile(raw, `${TEST_ENV_FILE}.does-not-exist`)).not.toThrow();
    expect(Object.keys(raw)).toHaveLength(0);
  });
});
