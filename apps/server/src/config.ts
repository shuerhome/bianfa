// =============================================================================
// 环境变量加载与校验 —— 只做 DB / 通用部分（规格 01 §3.1 + DSN）。
// api / sync / worker 各自的 config 用 `loadEnv(baseEnvSchema.extend({...}))` 在此基础上扩展。
// -----------------------------------------------------------------------------
// * 直连 DSN 规范名 DATABASE_URL_DIRECT（compose / .env.prod.example）；CI（backend.yml）用的是 DATABASE_DIRECT_URL，
//   规格 01 §11-2 裁定：加载器同时接受别名，规范名优先；backend.yml 改名前不得移除别名。
// * `.env.test` 只在 NODE_ENV=test 时读（语义同 node --env-file：已存在的环境变量优先，文件只补缺）。
// * 不读取规格 01 §3.6 列出的"永不进入容器"的变量。
// =============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";

export const TEST_ENV_FILE = fileURLToPath(new URL("../.env.test", import.meta.url));

const postgresDsn = z
  .string()
  .min(1)
  .regex(/^postgres(ql)?:\/\//, "必须是 postgres:// 或 postgresql:// DSN");

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  /** 业务连接：prod 经 PgBouncer transaction 模式；迁移时 CI 会把它覆盖成直连 */
  DATABASE_URL: postgresDsn,
  /** 唯一直连 DSN：只供 LISTEN（sync-ws）；别名 DATABASE_DIRECT_URL 在 normalizeEnv 里折叠到这里 */
  DATABASE_URL_DIRECT: postgresDsn.optional(),
});

export type BaseEnv = z.output<typeof baseEnvSchema>;

/** 直连 DSN 的别名映射：规范名优先，别名只在规范名缺失时生效 */
const ALIASES: ReadonlyArray<readonly [canonical: string, alias: string]> = [
  ["DATABASE_URL_DIRECT", "DATABASE_DIRECT_URL"],
];

export function normalizeEnv(raw: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...raw };
  for (const [canonical, alias] of ALIASES) {
    if (isBlank(out[canonical]) && !isBlank(out[alias])) out[canonical] = out[alias];
  }
  // 空串视为未设置（compose 的 ${X:-} 会注入空串）
  for (const key of Object.keys(out)) if (out[key] === "") delete out[key];
  return out;
}

function isBlank(v: string | undefined): boolean {
  return v === undefined || v === "";
}

/** 把 .env.test 里 target 尚未设置的键补进 target（不覆盖）；文件不存在则忽略 */
export function applyTestEnvFile(target: NodeJS.ProcessEnv, file: string = TEST_ENV_FILE): void {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const [key, value] of Object.entries(parseEnv(content))) {
    if (target[key] === undefined) target[key] = value;
  }
}

/**
 * 通用加载入口：NODE_ENV=test 时先补 .env.test，再折叠别名，最后按 schema 校验。
 * 传入自定义 raw 对象时只对该对象生效（单测用），默认对 process.env 生效。
 */
export function loadEnv<S extends z.ZodObject>(schema: S, raw: NodeJS.ProcessEnv = process.env): z.output<S> {
  if (raw.NODE_ENV === "test") applyTestEnvFile(raw);
  const result = schema.safeParse(normalizeEnv(raw));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`环境变量校验失败：${issues}`);
  }
  return result.data;
}

export function loadBaseEnv(raw: NodeJS.ProcessEnv = process.env): BaseEnv {
  return loadEnv(baseEnvSchema, raw);
}
