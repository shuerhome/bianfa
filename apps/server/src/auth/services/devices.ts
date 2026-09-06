// /v1/me/devices（规格 04 §2.4）：远程登出只撤 token/session，本地数据一个字节不动。
import { eq } from "drizzle-orm";
import { audit } from "../../audit/index.js";
import { withUserTx } from "../../db/client.js";
import { device } from "../../db/schema/index.js";
import { notifyAuthzRevoked } from "../db-helpers.js";
import { ApiFailure } from "../http.js";
import { revokeAllUserTokens, revokeDeviceTokens } from "../oauth-tokens.js";
import { type Actor, actorEntry, type ServiceDeps } from "./context.js";

export async function listDevices(deps: ServiceDeps, actor: Actor) {
  const rows = await deps.db.select().from(device).where(eq(device.userId, actor.userId));
  rows.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  return {
    devices: rows.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      app_version: d.appVersion,
      last_ip: d.lastIp,
      last_seen_at: d.lastSeenAt.toISOString(),
      created_at: d.createdAt.toISOString(),
      revoked_at: d.revokedAt ? d.revokedAt.toISOString() : null,
      current: d.id === actor.deviceId,
    })),
  };
}

export async function revokeDevice(deps: ServiceDeps, actor: Actor, deviceId: string) {
  return withUserTx(
    actor.userId,
    async (tx) => {
      const found = await revokeDeviceTokens(tx, actor.userId, deviceId);
      if (!found) throw new ApiFailure(404, "not_found");
      await notifyAuthzRevoked(tx, actor.userId, "session", deviceId);
      await audit(
        tx,
        actorEntry(actor, {
          action: "auth.device_revoked",
          targetType: "device",
          targetId: deviceId,
          metadata: { via: "v1/me/devices", self: deviceId === actor.deviceId },
        }),
      );
      return { revoked: true, device_id: deviceId };
    },
    deps.db,
  );
}

export async function revokeAllDevices(deps: ServiceDeps, actor: Actor, opts: { keepCurrent: boolean }) {
  const revoked = await withUserTx(
    actor.userId,
    async (tx) => {
      const devices = await revokeAllUserTokens(tx, actor.userId, {
        exceptDeviceId: opts.keepCurrent ? actor.deviceId : null,
      });
      await notifyAuthzRevoked(tx, actor.userId, "session", "*");
      await audit(
        tx,
        actorEntry(actor, {
          action: "auth.device_revoked",
          targetType: "user",
          targetId: actor.userId,
          metadata: {
            via: "v1/me/devices/revoke-all",
            count: devices.length,
            keep_current: opts.keepCurrent,
          },
        }),
      );
      return devices;
    },
    deps.db,
  );
  if (!opts.keepCurrent) await deps.revokeWebSessions?.(actor.userId);
  return { revoked: revoked.map((d) => d.id), count: revoked.length };
}
