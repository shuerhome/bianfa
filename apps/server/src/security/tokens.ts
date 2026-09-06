// 不透明 token 工具（规格 04 §1.5 / §4.4）：token = base64url(random 32B)（43 字符）；库里只存 sha256。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** base64url(random N 字节)，默认 32B → 43 字符 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** sha256(utf8) → base64url（43 字符），用于 oauth token / 邀请 token 的库内存储键 */
export function sha256Base64url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

/** sha256(utf8) → Buffer(32)，用于 bytea 列（shares.token_hash 之类） */
export function sha256Buffer(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** 常量时间比较两个字符串（长度不同直接 false） */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 宽松 UUID 校验（任意版本；规格 7.3 要求 v7 但 Better Auth 自身 id 也可能是 v7 之外的合法 uuid） */
export function isUuidLike(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
