// =============================================================================
// oauth-provider token 行的直接访问（规格 04 §2.2 / §2.4）。
// -----------------------------------------------------------------------------
// * 库里存 sha256(token) 的 base64url（oauthProvider.storeTokens.hash 与此保持一致）；客户端拿到的 token 带前缀
//   bfa_（access）/ bfr_（refresh），前缀不入库（插件 prefix 选项行为）。
// * refresh ↔ device 绑定放旁表 oauth_refresh_device（插件表不支持 additionalFields）。
// * 撤销 = 删除 refresh 行（oauthAccessToken.refreshId ON DELETE CASCADE 连带 access）。
// =============================================================================
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { device, oauthAccessToken, oauthRefreshDevice, oauthRefreshToken } from "../db/schema/index.js";
import { sha256Base64url } from "../security/tokens.js";

export const DESKTOP_CLIENT_ID = "bianfa-desktop";
export const ACCESS_TOKEN_PREFIX = "bfa_";
export const REFRESH_TOKEN_PREFIX = "bfr_";
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 180 * 24 * 3600;
export const REFRESH_REUSE_INTERVAL_SECONDS = 30;
export const FREE_PLAN_DEVICE_LIMIT = 2;
export const DEVICE_PLATFORMS = ["windows", "macos", "linux"] as const;

type Queryable = Db | Tx;

export function stripTokenPrefix(token: string, prefix: string): string {
  return token.startsWith(prefix) ? token.slice(prefix.length) : token;
}

export function accessTokenLookupHash(token: string): string {
  return sha256Base64url(stripTokenPrefix(token, ACCESS_TOKEN_PREFIX));
}

export function refreshTokenLookupHash(token: string): string {
  return sha256Base64url(stripTokenPrefix(token, REFRESH_TOKEN_PREFIX));
}

export interface RefreshRow {
  id: string;
  userId: string;
  clientId: string;
  sessionId: string | null;
  revoked: Date | null;
  rotationReplayExpiresAt: Date | null;
  expiresAt: Date | null;
}

export async function findRefreshRowByToken(q: Queryable, token: string): Promise<RefreshRow | null> {
  const rows = await q
    .select({
      id: oauthRefreshToken.id,
      userId: oauthRefreshToken.userId,
      clientId: oauthRefreshToken.clientId,
      sessionId: oauthRefreshToken.sessionId,
      revoked: oauthRefreshToken.revoked,
      rotationReplayExpiresAt: oauthRefreshToken.rotationReplayExpiresAt,
      expiresAt: oauthRefreshToken.expiresAt,
    })
    .from(oauthRefreshToken)
    .where(eq(oauthRefreshToken.token, refreshTokenLookupHash(token)))
    .limit(1);
  return rows[0] ?? null;
}

/** access token → 所属 refresh 行 id（access 未绑 refresh 时 null） */
export async function findRefreshIdByAccessToken(q: Queryable, token: string): Promise<string | null> {
  const rows = await q
    .select({ refreshId: oauthAccessToken.refreshId })
    .from(oauthAccessToken)
    .where(eq(oauthAccessToken.token, accessTokenLookupHash(token)))
    .limit(1);
  return rows[0]?.refreshId ?? null;
}

export async function findDeviceForRefresh(q: Queryable, refreshId: string): Promise<string | null> {
  const rows = await q
    .select({ deviceId: oauthRefreshDevice.deviceId })
    .from(oauthRefreshDevice)
    .where(eq(oauthRefreshDevice.refreshTokenId, refreshId))
    .limit(1);
  return rows[0]?.deviceId ?? null;
}

export async function bindRefreshToDevice(
  q: Queryable,
  refreshId: string,
  deviceId: string,
  userId: string,
): Promise<void> {
  await q
    .insert(oauthRefreshDevice)
    .values({ refreshTokenId: refreshId, deviceId, userId })
    .onConflictDoUpdate({ target: oauthRefreshDevice.refreshTokenId, set: { deviceId, userId } });
}

export interface DeviceUpsert {
  id: string;
  userId: string;
  name: string;
  platform: string;
  appVersion: string;
  ip: string | null;
}

/** 登录/换 token 时 upsert 设备行；设备换了账号 → 旧账号在这台设备上的 token 全部作废 */
export async function upsertDevice(q: Queryable, d: DeviceUpsert): Promise<void> {
  const existing = await q.select({ userId: device.userId }).from(device).where(eq(device.id, d.id)).limit(1);
  const prevUser = existing[0]?.userId;
  if (prevUser && prevUser !== d.userId) {
    const stale = await q
      .select({ id: oauthRefreshDevice.refreshTokenId })
      .from(oauthRefreshDevice)
      .where(and(eq(oauthRefreshDevice.deviceId, d.id), eq(oauthRefreshDevice.userId, prevUser)));
    if (stale.length) {
      await q.delete(oauthRefreshToken).where(
        inArray(
          oauthRefreshToken.id,
          stale.map((s) => s.id),
        ),
      );
    }
  }
  await q
    .insert(device)
    .values({
      id: d.id,
      userId: d.userId,
      name: d.name,
      platform: d.platform,
      appVersion: d.appVersion,
      lastIp: d.ip,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: device.id,
      set: {
        userId: d.userId,
        name: d.name,
        platform: d.platform,
        appVersion: d.appVersion,
        lastIp: d.ip,
        lastSeenAt: new Date(),
        revokedAt: null,
      },
    });
}

export async function touchDevice(q: Queryable, deviceId: string, ip: string | null): Promise<void> {
  await q
    .update(device)
    .set({ lastSeenAt: new Date(), ...(ip ? { lastIp: ip } : {}) })
    .where(eq(device.id, deviceId));
}

/** 该用户处于活跃状态（未撤销）的设备数，可排除某台 */
export async function countActiveDevices(
  q: Queryable,
  userId: string,
  excludeDeviceId?: string,
): Promise<number> {
  const rows = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(device)
    .where(
      and(
        eq(device.userId, userId),
        isNull(device.revokedAt),
        excludeDeviceId ? ne(device.id, excludeDeviceId) : sql`true`,
      ),
    );
  return rows[0]?.n ?? 0;
}

/** 撤销一台设备：删该设备的全部 refresh 行（级联 access），device.revoked_at = now()。返回是否存在该设备 */
export async function revokeDeviceTokens(q: Queryable, userId: string, deviceId: string): Promise<boolean> {
  const rows = await q
    .select({ id: device.id })
    .from(device)
    .where(and(eq(device.id, deviceId), eq(device.userId, userId)))
    .limit(1);
  if (!rows[0]) return false;
  const mapped = await q
    .select({ id: oauthRefreshDevice.refreshTokenId })
    .from(oauthRefreshDevice)
    .where(and(eq(oauthRefreshDevice.deviceId, deviceId), eq(oauthRefreshDevice.userId, userId)));
  if (mapped.length) {
    await q.delete(oauthRefreshToken).where(
      inArray(
        oauthRefreshToken.id,
        mapped.map((m) => m.id),
      ),
    );
  }
  await q.update(device).set({ revokedAt: new Date() }).where(eq(device.id, deviceId));
  return true;
}

/** 撤销用户全部桌面 token（可保留当前设备）；返回被撤销设备的名字列表（security_alert 邮件用） */
export async function revokeAllUserTokens(
  q: Queryable,
  userId: string,
  opts: { exceptDeviceId?: string | null } = {},
): Promise<Array<{ id: string; name: string; platform: string }>> {
  const devices = await q
    .select({ id: device.id, name: device.name, platform: device.platform })
    .from(device)
    .where(
      and(
        eq(device.userId, userId),
        isNull(device.revokedAt),
        opts.exceptDeviceId ? ne(device.id, opts.exceptDeviceId) : sql`true`,
      ),
    );
  const ids = devices.map((d) => d.id);
  if (opts.exceptDeviceId) {
    // 保留当前设备的 refresh 行，其余全删
    await q
      .delete(oauthRefreshToken)
      .where(
        and(
          eq(oauthRefreshToken.userId, userId),
          sql`${oauthRefreshToken.id} NOT IN (SELECT refresh_token_id FROM oauth_refresh_device WHERE device_id = ${opts.exceptDeviceId})`,
        ),
      );
  } else {
    await q.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, userId));
  }
  if (ids.length) {
    await q.update(device).set({ revokedAt: new Date() }).where(inArray(device.id, ids));
  }
  return devices;
}

/** 是否是 device 表接受的平台值 */
export function isDevicePlatform(value: unknown): value is (typeof DEVICE_PLATFORMS)[number] {
  return typeof value === "string" && (DEVICE_PLATFORMS as readonly string[]).includes(value);
}
