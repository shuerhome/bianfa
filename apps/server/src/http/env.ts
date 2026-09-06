// api 进程的环境变量（规格 01 §3.2 / 08 X12）：在 baseEnvSchema 上扩展。
// 原则：除 DATABASE_URL 外全部可缺省（CI integration 只设 NODE_ENV/DATABASE_URL/DATABASE_DIRECT_URL/REDIS_URL）；
// 缺失的可选项 = 对应功能关闭（R2 → attachments_disabled；NOTICE_FILE → 204；REDIS_URL → 进程内限流）。
// SYNC_TOKEN_SECRET 在 production 必填（≥32 字符）；test/development 用固定开发值。
import { z } from "zod";
import { baseEnvSchema, loadEnv } from "../config.js";

/** 48 字符固定开发密钥（NODE_ENV≠production 时的缺省；sync-ws 本地联调用同一值） */
export const DEV_SYNC_TOKEN_SECRET = "bianfa-dev-sync-token-secret-0123456789abcdef012";

export const apiEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** CORS 精确匹配 origin 列表，逗号分隔（规格 01 §3.2） */
  APP_ORIGIN: z.string().default("http://localhost:5173"),
  PUBLIC_API_URL: z.string().url().optional(),
  SYNC_TOKEN_SECRET: z.string().min(32).optional(),
  REDIS_URL: z.string().optional(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ATTACHMENTS_BUCKET: z.string().default("bianfa-attachments"),
  R2_ATTACHMENTS_ACCESS_KEY_ID: z.string().optional(),
  R2_ATTACHMENTS_SECRET_ACCESS_KEY: z.string().optional(),
  /** 导出 ZIP 所在桶；缺省与附件同桶（key 前缀 exports/） */
  R2_EXPORTS_BUCKET: z.string().optional(),
  /** kill switch 公告静态 JSON 路径；缺省 → GET /v1/notice 恒 204 */
  NOTICE_FILE: z.string().optional(),
  /** R2 缺失时导出 ZIP 的落盘目录（仅开发/测试） */
  EXPORT_LOCAL_DIR: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
});

export type ApiEnv = z.output<typeof apiEnvSchema> & { SYNC_TOKEN_SECRET: string; APP_ORIGINS: string[] };

export function parseOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadApiEnv(raw: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = loadEnv(apiEnvSchema, raw);
  let secret = parsed.SYNC_TOKEN_SECRET;
  if (!secret) {
    if (parsed.NODE_ENV === "production") {
      throw new Error("环境变量校验失败：SYNC_TOKEN_SECRET 在 production 必填（≥32 字符）");
    }
    secret = DEV_SYNC_TOKEN_SECRET;
  }
  return { ...parsed, SYNC_TOKEN_SECRET: secret, APP_ORIGINS: parseOrigins(parsed.APP_ORIGIN) };
}

export interface R2Config {
  endpoint: string;
  bucket: string;
  exportsBucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** R2 四件套齐全才启用附件/导出对象存储；否则返回 null（功能关闭而非崩溃） */
export function r2ConfigFromEnv(env: {
  R2_ACCOUNT_ID?: string | undefined;
  R2_ATTACHMENTS_BUCKET?: string | undefined;
  R2_ATTACHMENTS_ACCESS_KEY_ID?: string | undefined;
  R2_ATTACHMENTS_SECRET_ACCESS_KEY?: string | undefined;
  R2_EXPORTS_BUCKET?: string | undefined;
}): R2Config | null {
  if (!env.R2_ACCOUNT_ID || !env.R2_ATTACHMENTS_ACCESS_KEY_ID || !env.R2_ATTACHMENTS_SECRET_ACCESS_KEY)
    return null;
  const bucket = env.R2_ATTACHMENTS_BUCKET || "bianfa-attachments";
  return {
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket,
    exportsBucket: env.R2_EXPORTS_BUCKET || bucket,
    accessKeyId: env.R2_ATTACHMENTS_ACCESS_KEY_ID,
    secretAccessKey: env.R2_ATTACHMENTS_SECRET_ACCESS_KEY,
  };
}
