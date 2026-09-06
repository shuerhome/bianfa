// =============================================================================
// 安全码（security code）：注册时用户自选，只用于「忘记密码」时重置密码；账号模型完全不依赖邮件送达。
// -----------------------------------------------------------------------------
// * 规则：去掉首尾空白后 4–32 个任意字符；不能与密码相同（注册 / 改码 / 用码重置时都检查）。
// * 存储：只存 hash（与密码同一套哈希器：argon2id，加载失败回退 Better Auth scrypt）；明文只在
//   databaseHooks.user.create.before 里出现一次，哈希后以 `securityCode: undefined` 覆盖 —— adapter 的 transformInput
//   会跳过值为 undefined 的字段（@better-auth/core db/adapter/factory.mjs），所以明文从不进 INSERT。
//   drizzle adapter 启动时的 schema diff 要求 additionalFields 每个字段都有列，所以 "user".security_code 列存在，
//   但带 CHECK (security_code IS NULL)：永远为 NULL，任何试图写明文的路径都会被数据库拒绝。
// * 校验放在 /sign-up/email 的 before hook（securityCodePlugin）：只约束邮箱密码注册；社交登录建的用户没有安全码
//   （security_code_set_at = null），之后在桌面端「设置 → 账号」补设。
// =============================================================================
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";

export const SECURITY_CODE_MIN = 4;
export const SECURITY_CODE_MAX = 32;

export interface PasswordHasher {
  hash: (password: string) => Promise<string>;
  verify: (data: { hash: string; password: string }) => Promise<boolean>;
}

/** 首尾空白不算；中间字符原样保留（用户可以用短语） */
export function normalizeSecurityCode(raw: string): string {
  return raw.trim();
}

export type SecurityCodeProblem = "required" | "short" | "long" | "equals_password";

export function securityCodeProblem(raw: unknown, password: string | null): SecurityCodeProblem | null {
  if (typeof raw !== "string") return "required";
  const code = normalizeSecurityCode(raw);
  if (!code) return "required";
  if (code.length < SECURITY_CODE_MIN) return "short";
  if (code.length > SECURITY_CODE_MAX) return "long";
  if (password !== null && code === password) return "equals_password";
  return null;
}

export const SECURITY_CODE_ERROR = {
  required: { code: "SECURITY_CODE_REQUIRED", message: "security code is required" },
  short: {
    code: "SECURITY_CODE_TOO_SHORT",
    message: `security code must be at least ${SECURITY_CODE_MIN} characters`,
  },
  long: {
    code: "SECURITY_CODE_TOO_LONG",
    message: `security code must be at most ${SECURITY_CODE_MAX} characters`,
  },
  equals_password: {
    code: "SECURITY_CODE_EQUALS_PASSWORD",
    message: "security code must differ from the password",
  },
} as const;

/** /v1 路由用的 zod：trim 后 4–32 */
export const securityCodeSchema = z.string().trim().min(SECURITY_CODE_MIN).max(SECURITY_CODE_MAX);

/**
 * Better Auth 插件：/sign-up/email 的 before hook 校验 body.securityCode（存在、长度、≠ password）。
 * 哈希本身在 databaseHooks.user.create.before（better-auth.ts）里做，因为只有那里能把 hash 写进 user 行。
 */
export function securityCodePlugin(): BetterAuthPlugin {
  return {
    id: "bianfa-security-code",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/sign-up/email",
          handler: createAuthMiddleware(async (ctx) => {
            const body =
              ctx.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};
            const password = typeof body.password === "string" ? body.password : null;
            const problem = securityCodeProblem(body.securityCode, password);
            if (problem) throw new APIError("BAD_REQUEST", SECURITY_CODE_ERROR[problem]);
          }),
        },
      ],
    },
  };
}

/**
 * databaseHooks.user.create.before：把明文安全码换成 hash + set_at；返回的 data 会与原 data 合并，
 * `securityCode: undefined` 让 adapter 跳过该字段（明文不落库）。没有安全码（社交登录）时只清掉字段。
 */
export async function hashSecurityCodeForCreate(
  user: Record<string, unknown>,
  hasher: PasswordHasher,
): Promise<{ data: Record<string, unknown> }> {
  const raw = user.securityCode;
  if (typeof raw !== "string" || !normalizeSecurityCode(raw)) {
    return { data: { securityCode: undefined } };
  }
  const securityCodeHash = await hasher.hash(normalizeSecurityCode(raw));
  return { data: { securityCode: undefined, securityCodeHash, securityCodeSetAt: new Date() } };
}
