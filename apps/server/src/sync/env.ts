// sync-ws 进程的环境变量（规格 08 X12：PORT SYNC_TOKEN_SECRET DATABASE_URL DATABASE_URL_DIRECT REDIS_URL；
// 可选项 WS_ALLOWED_ORIGINS 缺省 = 不校验 Origin）。DATABASE_URL_DIRECT 别名 DATABASE_DIRECT_URL 由 config.ts 折叠。
import { z } from "zod";
import { baseEnvSchema, loadEnv } from "../config.js";

/** 测试 / 本地缺省密钥：与 api 进程在 test 环境使用的固定值一致（CI 只注入 DSN 与 PORT）；production 拒绝使用 */
export const DEV_SYNC_TOKEN_SECRET = "bianfa-dev-sync-token-secret-0123456789abcdef-xyz";

export const syncEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  SYNC_TOKEN_SECRET: z.string().min(32).default(DEV_SYNC_TOKEN_SECRET),
  /** 缺失 → 不启用 extension-redis（单副本）且 /healthz 不检查 Redis */
  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\//, "必须是 redis:// 或 rediss:// URL")
    .optional(),
  /** 逗号分隔的允许 Origin；缺失 → 不校验（无 Origin 头的桌面端请求始终放行） */
  WS_ALLOWED_ORIGINS: z.string().optional(),
});

export type SyncEnv = z.output<typeof syncEnvSchema>;

export function loadSyncEnv(raw: NodeJS.ProcessEnv = process.env): SyncEnv {
  const env = loadEnv(syncEnvSchema, raw);
  if (env.NODE_ENV === "production" && env.SYNC_TOKEN_SECRET === DEV_SYNC_TOKEN_SECRET) {
    throw new Error("SYNC_TOKEN_SECRET 未设置：production 不允许使用内置开发密钥");
  }
  return env;
}

/** 解析 WS_ALLOWED_ORIGINS：小写、去尾斜杠、去空项；未设置或全空 → null（= 功能关闭） */
export function parseAllowedOrigins(value: string | undefined): ReadonlySet<string> | null {
  if (!value) return null;
  const set = new Set<string>();
  for (const part of value.split(",")) {
    const origin = normalizeOrigin(part);
    if (origin) set.add(origin);
  }
  return set.size > 0 ? set : null;
}

export function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, "");
}
