// =============================================================================
// Bearer 校验（规格 04 §1.5 / R19）：只认 oauth-provider 的不透明 access token。
// -----------------------------------------------------------------------------
// 与插件 validateOpaqueAccessToken 基本同一套判定（token hash 命中 → 未过期 → 未撤销 → client 未禁用 → 若绑了 session
// 则 session 仍有效），外加账号状态（banned / frozen_at / deleted_at → 拒绝）。一条 JOIN 查询完成；任何异常 → null（绝不抛）。
// 与插件不同的一处：有 refresh 家族的 token（桌面端）不要求绑定的 session 还活着，原因见下面那条判定。
// sessionId：Web 会话 id（authorize 时的 cookie 会话；桌面端走浏览器 PKCE 登录，所以通常也有）；
// 没有 → 退回 refresh 行 id（= 该设备的 token family）。
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
      // 绑着 Web 会话的 token 跟着会话走——但有 refresh 家族的（桌面端，offline_access）除外。
      // 桌面端登录走浏览器 PKCE，authorize 时的 cookie 会话被记进了 token 的 sessionId；那个会话 7 天过期
      // （SESSION_EXPIRES_IN），桌面端从不续它。以前这里一律要求它活着，于是每台桌面端登录满 7 天后：
      // refresh 照样成功（refresh token 180 天），换来的每张 access token 一用就 401——客户端以为自己
      // 还登录着，同步无声无息地停摆。桌面 token 的生命周期由 refresh token 与撤销决定：撤销某台设备
      // （revokeDeviceTokens）、改密 / 重置安全码 / 注销全部设备 / 管理员 / 删号（revokeAllUserTokens）
      // 都直接把 token 标成 revoked，上面那行就拒了，从来不靠这个会话过期。
      if (row.sessionId && !row.refreshId && (!row.sessionExpiresAt || row.sessionExpiresAt.getTime() <= now))
        return null;
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
