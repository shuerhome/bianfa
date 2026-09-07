// 平台总管理员判定与中间件（迁移 0009）。
//
// 判定**不缓存**：org 成员那套 30 秒缓存是为了扛高频调用，而总管理员端点是低频高危操作，
// 多一次索引命中的查询换「撤销即刻生效」是划算的。
//
// 拒绝时返回 403 insufficient_role（而不是伪装成 404）：/v1 全程要求 Bearer，能走到这里的都是已登录用户，
// 「存在一个 /v1/admin」本身不是秘密，真正的边界是这里的判定本身；伪装 404 反而要求响应与全局 404 逐字一致，
// 而 v1 的 fail() 会多一个 server_time 字段，做不到逐字一致，等于给出一个更细的 oracle 还自欺欺人。
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { audit } from "../audit/index.js";
import type { Db } from "../db/client.js";
import { platformAdmin } from "../db/schema/admin.js";
import { ApiFailure, requestMeta } from "./http.js";
import type { AuthVariables } from "./index.js";

export type AdminVariables = AuthVariables & { platformAdmin: true };

/** 名单里有这个人吗。任何异常一律当作「不是」（fail-closed）。 */
export async function isPlatformAdmin(db: Db, userId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({ userId: platformAdmin.userId })
      .from(platformAdmin)
      .where(eq(platformAdmin.userId, userId))
      .limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

export interface AdminGuardDeps {
  db: Db;
  /** PLATFORM_ADMIN_ENABLED=0 时整个管理面下线（出事时一分钟内能落下的闸）*/
  enabled: boolean;
}

/**
 * `/v1/admin/*` 的闸门。必须挂在 requireBearer 之后。
 * 管理面被关掉时一律 404 —— 这时端点在这个部署里确实不存在，不是权限问题。
 */
export function requireSuperAdmin(deps: AdminGuardDeps): MiddlewareHandler<{ Variables: AdminVariables }> {
  return async (c, next) => {
    if (!deps.enabled) throw new ApiFailure(404, "not_found");
    const auth = c.get("auth");
    if (!auth?.userId) throw new ApiFailure(401, "unauthorized");
    if (await isPlatformAdmin(deps.db, auth.userId)) {
      c.set("platformAdmin", true);
      return next();
    }
    const meta = requestMeta(c);
    // 被拒绝也要留痕：普通用户摸管理端点是值得看见的信号
    await deps.db
      .transaction((tx) =>
        audit(tx, {
          action: "authz.denied",
          actorId: auth.userId,
          actorDeviceId: auth.deviceId,
          actorIp: meta.ip,
          actorUa: meta.ua,
          targetType: "platform_admin",
          targetId: auth.userId,
          outcome: "denied",
          metadata: { required: "platform_admin", path: c.req.path, method: c.req.method },
          requestId: meta.requestId,
        }),
      )
      .catch(() => {
        /* 审计写失败不能把拒绝变成放行 */
      });
    throw new ApiFailure(403, "insufficient_role", { required: "platform_admin" });
  };
}
