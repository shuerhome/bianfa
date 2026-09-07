// =============================================================================
// Bearer 校验（规格 04 §1.5 / R19）：只认 oauth-provider 的不透明 access token。
// -----------------------------------------------------------------------------
// 与插件 validateOpaqueAccessToken 同一套判定（token hash 命中 → 未过期 → 未撤销 → client 未禁用 → 若绑了 session 则 session
// 仍有效），外加账号状态（banned / frozen_at / deleted_at → 拒绝）。一条 JOIN 查询完成；任何异常 → null（绝不抛）。
// sessionId：Web 会话 id（authorize 时的 cookie 会话）；桌面 token 通常没有 → 退回 refresh 行 id（= 该设备的 token family）。
// =============================================================================
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { Db } from "../db/client.js";
import { oauthAccessToken, oauthClient, oauthRefreshDevice, session, user } from "../db/schema/index.js";
import type { AuthContext, BearerVerifier } from "./index.js";
import { accessTokenLookupHash } from "./oauth-tokens.js";

export function createBearerVerifier(db: Db, log?: Logger): BearerVerifier {
  return async (token): Promise<AuthContext | null> => {
    if (typeof token !== "string" || token.length < 16 || token.length > 512) return null;
    try {
      const rows = await db
        .select({
          userId: oauthAccessToken.userId,
          sessionId: oauthAccessToken.sessionId,
          refreshId: oauthAccessToken.refreshId,
          expiresAt: oauthAccessToken.expiresAt,
          revoked: oauthAccessToken.revoked,
          scopes: oauthAccessToken.scopes,
          clientDisabled: oauthClient.disabled,
          email: user.email,
          emailVerified: user.emailVerified,
          banned: user.banned,
          frozenAt: user.frozenAt,
          deletedAt: user.deletedAt,
          deviceId: oauthRefreshDevice.deviceId,
          sessionExpiresAt: session.expiresAt,
        })
        .from(oauthAccessToken)
        .innerJoin(user, eq(user.id, oauthAccessToken.userId))
        .innerJoin(oauthClient, eq(oauthClient.clientId, oauthAccessToken.clientId))
        .leftJoin(oauthRefreshDevice, eq(oauthRefreshDevice.refreshTokenId, oauthAccessToken.refreshId))
        .leftJoin(session, eq(session.id, oauthAccessToken.sessionId))
        .where(eq(oauthAccessToken.token, accessTokenLookupHash(token)))
        .limit(1);
      const row = rows[0];
      if (!row?.userId) return null;
      const now = Date.now();
      if (!row.expiresAt || row.expiresAt.getTime() <= now) return null;
      if (row.revoked) return null;
      if (row.clientDisabled) return null;
      if (row.banned || row.frozenAt || row.deletedAt) return null;
      if (row.sessionId && (!row.sessionExpiresAt || row.sessionExpiresAt.getTime() <= now)) return null;
      return {
        userId: row.userId,
        sessionId: row.sessionId ?? row.refreshId ?? null,
        deviceId: row.deviceId ?? null,
        email: row.email,
        emailVerified: row.emailVerified,
        scopes: row.scopes ?? [],
      };
    } catch (err) {
      log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "verifyBearer failed (treated as invalid)",
      );
      return null;
    }
  };
}
