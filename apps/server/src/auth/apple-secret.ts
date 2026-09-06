// Apple client secret（规格 04 §1.5）：用 .p8 私钥签 ES256 JWT，最长 6 个月；本进程缓存 150 天后重签。
// 也可直接提供已签好的 APPLE_CLIENT_SECRET。全部缺省 → apple 登录关闭（createAuth 不注册 provider）。
import { importPKCS8, SignJWT } from "jose";

export interface AppleSecretConfig {
  clientId: string;
  clientSecret?: string | undefined;
  teamId?: string | undefined;
  keyId?: string | undefined;
  p8Key?: string | undefined;
}

export const APPLE_SECRET_MAX_AGE_SECONDS = 15_777_000; // 6 个月（Apple 上限）
export const APPLE_SECRET_ROTATE_AFTER_MS = 150 * 24 * 3600 * 1000;

export function appleConfigured(cfg: AppleSecretConfig): boolean {
  return Boolean(cfg.clientId && (cfg.clientSecret || (cfg.teamId && cfg.keyId && cfg.p8Key)));
}

export function createAppleSecretProvider(cfg: AppleSecretConfig): () => Promise<string> {
  let cached: { value: string; at: number } | undefined;
  return async () => {
    if (cfg.clientSecret) return cfg.clientSecret;
    if (cached && Date.now() - cached.at < APPLE_SECRET_ROTATE_AFTER_MS) return cached.value;
    if (!cfg.teamId || !cfg.keyId || !cfg.p8Key)
      throw new Error("apple: 缺 APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_P8_KEY");
    const pem = cfg.p8Key.includes("BEGIN")
      ? cfg.p8Key.replace(/\\n/g, "\n")
      : `-----BEGIN PRIVATE KEY-----\n${cfg.p8Key}\n-----END PRIVATE KEY-----`;
    const key = await importPKCS8(pem, "ES256");
    const now = Math.floor(Date.now() / 1000);
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: cfg.keyId })
      .setIssuer(cfg.teamId)
      .setIssuedAt(now)
      .setExpirationTime(now + APPLE_SECRET_MAX_AGE_SECONDS)
      .setAudience("https://appleid.apple.com")
      .setSubject(cfg.clientId)
      .sign(key);
    cached = { value, at: Date.now() };
    return value;
  };
}
