// 表单校验（与服务端一致：密码 8–128；安全码 trim 后 4–32 且 ≠ 密码；邮箱小写归一化）
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const SECURITY_CODE_MIN = 4;
export const SECURITY_CODE_MAX = 32;
export const USER_CODE_LENGTH = 8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidEmail(raw: string): boolean {
  const v = normalizeEmail(raw);
  return v.length <= 254 && EMAIL_RE.test(v);
}

export function passwordProblem(pw: string): "short" | "long" | null {
  if (pw.length < PASSWORD_MIN) return "short";
  if (pw.length > PASSWORD_MAX) return "long";
  return null;
}

/** 安全码：只去首尾空白（服务端 normalizeSecurityCode 同规则） */
export function normalizeSecurityCode(raw: string): string {
  return raw.trim();
}

export function securityCodeProblem(
  raw: string,
  password: string,
): "required" | "short" | "long" | "same_as_password" | null {
  const code = normalizeSecurityCode(raw);
  if (!code) return "required";
  if (code.length < SECURITY_CODE_MIN) return "short";
  if (code.length > SECURITY_CODE_MAX) return "long";
  if (code === password) return "same_as_password";
  return null;
}

/** 设备码：去掉非字母数字、大写（服务端 normalizeUserCode 同规则） */
export function normalizeUserCode(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/** 展示：XXXX-XXXX */
export function formatUserCode(raw: string): string {
  const v = normalizeUserCode(raw).slice(0, USER_CODE_LENGTH);
  return v.length > 4 ? `${v.slice(0, 4)}-${v.slice(4)}` : v;
}
