// =============================================================================
// 鉴权相关环境变量（规格 04 §1.2 / 规格 08 X12）。在 baseEnvSchema 上扩展；createAuth 用 deps.env 解析。
// -----------------------------------------------------------------------------
// * NODE_ENV=test 的缺省：BETTER_AUTH_URL=http://127.0.0.1:3000、BETTER_AUTH_SECRET=固定 48 字符开发串、
//   APP_ORIGIN=http://localhost:1420（.env.test 已提供时以文件为准）。
// * production：BETTER_AUTH_SECRET（≥32 字符）、BETTER_AUTH_URL、APP_ORIGIN 必填。
// * 可选：RESEND_API_KEY / MAIL_FROM、GOOGLE_*、APPLE_*、DATA_KEY_* —— 缺 → 对应功能关闭而非崩溃。
// =============================================================================
import { z } from "zod";
import { baseEnvSchema, loadEnv } from "../config.js";
import { parseOrigins } from "../security/cors.js";

export const TEST_AUTH_SECRET = "bianfa-test-secret-do-not-use-in-production-0001";
export const TEST_BASE_URL = "http://127.0.0.1:3000";
export const TEST_APP_ORIGIN = "http://localhost:1420";

const optionalString = z.string().min(1).optional();

export const authEnvSchema = baseEnvSchema.extend({
  BETTER_AUTH_URL: z.string().url().optional(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET 至少 32 字符").optional(),
  PUBLIC_API_URL: z.string().url().optional(),
  /** 逗号分隔的精确 origin 列表 */
  APP_ORIGIN: optionalString,
  RESEND_API_KEY: optionalString,
  MAIL_FROM: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  APPLE_CLIENT_ID: optionalString,
  APPLE_APP_BUNDLE_ID: optionalString,
  /** 已签好的 client secret（JWT）；与 APPLE_TEAM_ID/KEY_ID/P8_KEY 二选一 */
  APPLE_CLIENT_SECRET: optionalString,
  APPLE_TEAM_ID: optionalString,
  APPLE_KEY_ID: optionalString,
  APPLE_P8_KEY: optionalString,
  /** 测试里显式打开 Better Auth 内置限流（默认只在 production 开） */
  AUTH_RATE_LIMIT: z.enum(["0", "1"]).optional(),
  /** 逗号分隔的可信代理 CIDR（Better Auth ipAddress.trustedProxies）；缺省不配置 */
  AUTH_TRUSTED_PROXIES: optionalString,
});

export type AuthEnvRaw = z.output<typeof authEnvSchema>;

export interface AuthEnv extends AuthEnvRaw {
  baseURL: string;
  secret: string;
  appOrigins: string[];
  /** 第一个 APP_ORIGIN：邮件链接、登录页等 Web 面用它 */
  appOrigin: string;
  isProduction: boolean;
  isTest: boolean;
  secureCookies: boolean;
  /** 原始 env（DATA_KEY_* 扫描用） */
  raw: NodeJS.ProcessEnv;
}

export function loadAuthEnv(raw: NodeJS.ProcessEnv): AuthEnv {
  const parsed = loadEnv(authEnvSchema, raw);
  const isTest = parsed.NODE_ENV === "test";
  const isProduction = parsed.NODE_ENV === "production";

  const baseURL =
    parsed.BETTER_AUTH_URL ?? parsed.PUBLIC_API_URL ?? (isProduction ? undefined : TEST_BASE_URL);
  if (!baseURL) throw new Error("环境变量校验失败：BETTER_AUTH_URL 在 production 必填");
  const secret = parsed.BETTER_AUTH_SECRET ?? (isProduction ? undefined : TEST_AUTH_SECRET);
  if (!secret)
    throw new Error("环境变量校验失败：BETTER_AUTH_SECRET 在 production 必填（openssl rand -base64 48）");
  const appOrigins = parseOrigins(parsed.APP_ORIGIN ?? (isProduction ? undefined : TEST_APP_ORIGIN));
  if (appOrigins.length === 0)
    throw new Error("环境变量校验失败：APP_ORIGIN 在 production 必填（逗号分隔的 origin 列表）");

  return {
    ...parsed,
    baseURL: baseURL.replace(/\/+$/, ""),
    secret,
    appOrigins,
    appOrigin: appOrigins[0] as string,
    isProduction,
    isTest,
    secureCookies: baseURL.startsWith("https://"),
    raw,
  };
}
