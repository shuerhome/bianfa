// =============================================================================
// 服务端敏感列加密（规格 04 §7.6 / 10:9.1.2）：XChaCha20-Poly1305（@noble/ciphers），密钥版本化。
// -----------------------------------------------------------------------------
// 环境变量：DATA_KEY_<n>（base64 / base64url / hex 的 32 字节）+ DATA_KEY_ACTIVE=<n>。
// 全部缺省 → 功能关闭而非崩溃（规格 08 X12）：encrypt 产出 `v0.<base64url(明文)>`，decrypt 两种格式都认。
// 密文格式：`v1.<key_id>.<base64url(nonce 24B)>.<base64url(ciphertext+tag)>`；轮换 = 新写用 DATA_KEY_ACTIVE，
// 旧密文靠 key_id 找旧 key 解密（惰性重加密由调用方在读到 key_id != active 时决定）。
// =============================================================================
import { randomBytes } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

export interface ColumnCrypto {
  /** 是否配置了密钥（false = 透传模式） */
  readonly enabled: boolean;
  /** 当前写入用的 key id；透传模式为 0 */
  readonly activeKeyId: number;
  encrypt(plaintext: string, aad?: string): string;
  decrypt(stored: string, aad?: string): string;
  /** 解析存储值里的 key id（v0 → 0；非法格式抛错） */
  keyIdOf(stored: string): number;
}

const KEY_RE = /^DATA_KEY_(\d+)$/;

export function parseDataKeys(env: NodeJS.ProcessEnv): {
  keys: Map<number, Uint8Array>;
  active: number | null;
} {
  const keys = new Map<number, Uint8Array>();
  for (const [name, value] of Object.entries(env)) {
    const m = KEY_RE.exec(name);
    if (!m || !value) continue;
    const id = Number(m[1]);
    const raw = decodeKey(value);
    if (raw.length !== 32)
      throw new Error(`${name}: 必须是 32 字节（base64/base64url/hex），实际 ${raw.length}`);
    keys.set(id, raw);
  }
  const activeRaw = env.DATA_KEY_ACTIVE;
  let active: number | null = null;
  if (activeRaw !== undefined && activeRaw !== "") {
    active = Number(activeRaw);
    if (!Number.isInteger(active) || !keys.has(active)) {
      throw new Error(`DATA_KEY_ACTIVE=${activeRaw} 没有对应的 DATA_KEY_${activeRaw}`);
    }
  } else if (keys.size > 0) {
    active = Math.max(...keys.keys());
  }
  return { keys, active };
}

function decodeKey(value: string): Uint8Array {
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return new Uint8Array(Buffer.from(v, "hex"));
  return new Uint8Array(Buffer.from(v, v.includes("-") || v.includes("_") ? "base64url" : "base64"));
}

export function createColumnCrypto(env: NodeJS.ProcessEnv = process.env): ColumnCrypto {
  const { keys, active } = parseDataKeys(env);
  const enabled = active !== null;

  function keyIdOf(stored: string): number {
    if (stored.startsWith("v0.")) return 0;
    if (stored.startsWith("v1.")) {
      const id = Number(stored.split(".")[1]);
      if (Number.isInteger(id)) return id;
    }
    throw new Error("column-crypto: 无法识别的密文格式");
  }

  return {
    enabled,
    activeKeyId: active ?? 0,

    encrypt(plaintext, aad) {
      if (!enabled || active === null) return `v0.${Buffer.from(plaintext, "utf8").toString("base64url")}`;
      const key = keys.get(active) as Uint8Array;
      const nonce = new Uint8Array(randomBytes(24));
      const cipher = xchacha20poly1305(key, nonce, aad === undefined ? undefined : Buffer.from(aad, "utf8"));
      const ct = cipher.encrypt(new Uint8Array(Buffer.from(plaintext, "utf8")));
      return `v1.${active}.${Buffer.from(nonce).toString("base64url")}.${Buffer.from(ct).toString("base64url")}`;
    },

    decrypt(stored, aad) {
      if (stored.startsWith("v0.")) return Buffer.from(stored.slice(3), "base64url").toString("utf8");
      const parts = stored.split(".");
      if (parts.length !== 4 || parts[0] !== "v1") throw new Error("column-crypto: 无法识别的密文格式");
      const id = Number(parts[1]);
      const key = keys.get(id);
      if (!key) throw new Error(`column-crypto: 缺少 DATA_KEY_${parts[1]}，无法解密`);
      const nonce = new Uint8Array(Buffer.from(parts[2] as string, "base64url"));
      const ct = new Uint8Array(Buffer.from(parts[3] as string, "base64url"));
      const cipher = xchacha20poly1305(key, nonce, aad === undefined ? undefined : Buffer.from(aad, "utf8"));
      return Buffer.from(cipher.decrypt(ct)).toString("utf8");
    },

    keyIdOf,
  };
}
