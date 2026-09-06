// 同步凭据：60 s HS256 JWT（规格 03 §1.3 / 04 §3 / 08 X3）。api 签发（POST /v1/sync/token），sync-ws 校验。
import { createSecretKey, randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

export const SYNC_TOKEN_ISSUER = "bianfa-api";
export const SYNC_TOKEN_AUDIENCE = "bianfa-sync";
export const SYNC_TOKEN_TTL_SECONDS = 60;
export const SYNC_TOKEN_CLOCK_TOLERANCE_SECONDS = 5;

export interface SyncTokenClaims {
  /** user id */
  sub: string;
  /** device id（Web 会话为 null） */
  did: string | null;
  /** session id */
  sid: string | null;
  /** 客户端支持的最高 schema_version */
  msv: number;
}

export interface SyncTokenPayload extends SyncTokenClaims {
  iat: number;
  exp: number;
  jti: string;
}

function keyFromSecret(secret: string) {
  if (secret.length < 32) throw new Error("SYNC_TOKEN_SECRET 至少 32 字符");
  return createSecretKey(Buffer.from(secret, "utf8"));
}

export async function signSyncToken(
  secret: string,
  claims: SyncTokenClaims,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ token: string; expiresIn: number; expiresAt: number }> {
  const exp = now + SYNC_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({ did: claims.did, sid: claims.sid, msv: claims.msv })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SYNC_TOKEN_ISSUER)
    .setAudience(SYNC_TOKEN_AUDIENCE)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(randomUUID())
    .sign(keyFromSecret(secret));
  return { token, expiresIn: SYNC_TOKEN_TTL_SECONDS, expiresAt: exp * 1000 };
}

export type SyncTokenError = "expired" | "bad_token";

/** 校验失败返回 { ok:false, reason }，不抛（sync-ws 据此计 auth_failures_total{reason}） */
export async function verifySyncToken(
  secret: string,
  token: string,
): Promise<{ ok: true; claims: SyncTokenPayload } | { ok: false; reason: SyncTokenError }> {
  try {
    const { payload } = await jwtVerify(token, keyFromSecret(secret), {
      issuer: SYNC_TOKEN_ISSUER,
      audience: SYNC_TOKEN_AUDIENCE,
      algorithms: ["HS256"],
      clockTolerance: SYNC_TOKEN_CLOCK_TOLERANCE_SECONDS,
    });
    if (typeof payload.sub !== "string" || !payload.sub) return { ok: false, reason: "bad_token" };
    return {
      ok: true,
      claims: {
        sub: payload.sub,
        did: typeof payload.did === "string" ? payload.did : null,
        sid: typeof payload.sid === "string" ? payload.sid : null,
        msv: typeof payload.msv === "number" ? payload.msv : 1,
        iat: payload.iat ?? 0,
        exp: payload.exp ?? 0,
        jti: typeof payload.jti === "string" ? payload.jti : "",
      },
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return { ok: false, reason: code === "ERR_JWT_EXPIRED" ? "expired" : "bad_token" };
  }
}
