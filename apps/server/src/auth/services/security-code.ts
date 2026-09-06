// =============================================================================
// POST /v1/auth/reset-with-code（匿名）：邮箱 + 安全码 + 新密码 → 重置密码，不经邮件。
// -----------------------------------------------------------------------------
// * 邮箱不存在 / 没设安全码 / 安全码错 → 一律 400 invalid_security_code（用户明确要简单流程，不做「恒 200」的枚举防护；
//   但路由层 5 次 / 15 分钟 / ip+email 限流，且未知邮箱也跑一次 verify 让耗时接近）。
// * 成功：Better Auth internalAdapter 写新密码 hash（deps.setUserPassword）→ 同一事务撤销全部桌面 token / 设备 + NOTIFY(session:*)
//   + 审计 auth.password_changed { via: 'security_code' } → 撤销全部 Web 会话（deps.revokeWebSessions）。
// * 新密码不能等于安全码（否则安全码等于第二个密码）。
// =============================================================================
import { eq, sql } from "drizzle-orm";
import { audit } from "../../audit/index.js";
import { withUserTx } from "../../db/client.js";
import { user } from "../../db/schema/index.js";
import { notifyAuthzRevoked } from "../db-helpers.js";
import type { RequestMeta } from "../http.js";
import { ApiFailure } from "../http.js";
import { revokeAllUserTokens } from "../oauth-tokens.js";
import { normalizeSecurityCode } from "../security-code.js";
import type { ServiceDeps } from "./context.js";

export interface ResetWithCodeInput {
  email: string;
  securityCode: string;
  newPassword: string;
}

/** 未知邮箱时也跑一次 verify 用的哈希（首次调用时用哈希器算一次，之后复用） */
let dummyHash: Promise<string> | null = null;
function dummyHashFor(deps: ServiceDeps): Promise<string> {
  if (!deps.password) throw new ApiFailure(500, "internal_error");
  dummyHash ??= deps.password.hash("bianfa-dummy-security-code");
  return dummyHash;
}

export async function resetPasswordWithSecurityCode(
  deps: ServiceDeps,
  meta: RequestMeta,
  input: ResetWithCodeInput,
) {
  const hasher = deps.password;
  const setUserPassword = deps.setUserPassword;
  if (!hasher || !setUserPassword) throw new ApiFailure(500, "internal_error");
  const code = normalizeSecurityCode(input.securityCode);
  if (input.newPassword === code) throw new ApiFailure(400, "password_equals_security_code");

  const rows = await deps.db
    .select({
      id: user.id,
      securityCodeHash: user.securityCodeHash,
      banned: user.banned,
      deletedAt: user.deletedAt,
    })
    .from(user)
    .where(sql`lower(${user.email}) = ${input.email.toLowerCase()}`)
    .limit(1);
  const u = rows[0];
  const usable = u && !u.banned && !u.deletedAt && u.securityCodeHash;
  const hash = usable ? (u.securityCodeHash as string) : await dummyHashFor(deps);
  const matched = await hasher.verify({ hash, password: code });
  if (!usable || !matched) {
    if (u) {
      await deps.db.transaction((tx) =>
        audit(tx, {
          action: "auth.password_reset_denied",
          actorId: u.id,
          actorIp: meta.ip,
          actorUa: meta.ua,
          targetType: "user",
          targetId: u.id,
          outcome: "denied",
          metadata: { via: "security_code", reason: usable ? "mismatch" : "unavailable" },
          requestId: meta.requestId,
        }),
      );
    }
    throw new ApiFailure(400, "invalid_security_code");
  }

  await setUserPassword(u.id, input.newPassword);
  const revoked = await withUserTx(
    u.id,
    async (tx) => {
      const devices = await revokeAllUserTokens(tx, u.id);
      await tx.update(user).set({ updatedAt: new Date() }).where(eq(user.id, u.id));
      await notifyAuthzRevoked(tx, u.id, "session", "*");
      await audit(tx, {
        action: "auth.password_changed",
        actorId: u.id,
        actorIp: meta.ip,
        actorUa: meta.ua,
        targetType: "user",
        targetId: u.id,
        metadata: { via: "security_code", revoked_devices: devices.length },
        requestId: meta.requestId,
      });
      return devices;
    },
    deps.db,
  );
  await deps.revokeWebSessions?.(u.id);
  deps.log.info({ userId: u.id, revokedDevices: revoked.length }, "password reset with security code");
  return { ok: true as const, revoked_devices: revoked.length };
}
