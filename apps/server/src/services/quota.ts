// 配额（规格 04 §4.5）：云存储 Free 100 MB / Pro 2 GB / Team 10 GB per org；单张图片 ≤ 10 MB。
// 执行点 POST /v1/attachments/presign：sum(byte_size) 按 personal workspace 归 user、team workspace 归 org。
import { sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.js";
import { num, one } from "./db-util.js";

export const MB = 1024 * 1024;
export const GB = 1024 * MB;

export type Plan = "free" | "pro" | "team";

export const STORAGE_LIMITS: Record<Plan, number> = {
  free: 100 * MB,
  pro: 2 * GB,
  team: 10 * GB,
};

export const ATTACHMENT_MAX_BYTES = 10 * MB;
/**
 * 总管理员的单文件上限。**不是**「无限」，这条限制拿不掉：桌面端上传是
 * `std::fs::read(&path)` —— 整个文件读进内存再 PUT（apps/desktop/src-tauri/src/app/attachments.rs）。
 * 真要无限得先把客户端改成流式上传，那是另一件事。200 MB 峰值内存约 400 MB（读一份 + HTTP 客户端再拷一份），
 * 桌面端扛得住；再往上就该做流式而不是继续调大这个数了。
 * 另外 S3/R2 单次 PUT 的协议上限是 5 GiB，超过必须走分片。
 */
export const ADMIN_ATTACHMENT_MAX_BYTES = 200 * MB;
/** Free 同步设备上限（token 端点执行；B1 的 /me/devices 亦用） */
export const DEVICE_LIMITS: Record<Plan, number> = {
  free: 2,
  pro: Number.POSITIVE_INFINITY,
  team: Number.POSITIVE_INFINITY,
};

export function normalizePlan(raw: string | null | undefined): Plan {
  return raw === "pro" || raw === "team" ? raw : "free";
}

/**
 * 总管理员及其团队不受套餐限制（存储配额 / 同步设备数 / 团队席位）。
 *
 * 判定是**自动**的：个人工作区看 owner 是不是总管理员，团队工作区看这个组织里有没有
 * 活跃的总管理员成员。不引入「无限制」这个套餐值，也不加手动标记 —— 套餐是给外部用户
 * 分层用的，自托管的所有者不该被自己搭的收费墙挡住，而这件事应该跟着「谁是总管理员」
 * 自动成立，不要变成一份需要维护的名单。
 *
 * platform_admin 表开了 RLS 但有 `FOR SELECT ... USING (true)` 策略，所以 bianfa_app 读得到；
 * 写不进去（没有写策略），授予总管理员只能走 bianfa_worker，见 0009 迁移。
 */
export async function isPlatformAdminUser(tx: Tx | Db, userId: string): Promise<boolean> {
  const row = await one<{ ok: boolean }>(
    tx as Tx,
    sql`SELECT EXISTS (SELECT 1 FROM platform_admin WHERE user_id = ${userId}) AS ok`,
  );
  return row?.ok === true;
}

/** 组织里有没有活跃的总管理员成员 */
export async function orgHasPlatformAdmin(tx: Tx | Db, orgId: string): Promise<boolean> {
  const row = await one<{ ok: boolean }>(
    tx as Tx,
    sql`SELECT EXISTS (
          SELECT 1 FROM member m
            JOIN platform_admin pa ON pa.user_id = m."userId"
           WHERE m."organizationId" = ${orgId} AND m.status = 'active'
        ) AS ok`,
  );
  return row?.ok === true;
}

/** 这个工作区是否不受套餐限制 */
export async function isUnlimitedWorkspace(
  tx: Tx,
  ws: { kind: "personal" | "team"; org_id: string | null; owner_user_id: string | null },
): Promise<boolean> {
  if (ws.kind === "team" && ws.org_id) return orgHasPlatformAdmin(tx, ws.org_id);
  if (ws.owner_user_id) return isPlatformAdminUser(tx, ws.owner_user_id);
  return false;
}

export interface QuotaCheck {
  ok: boolean;
  used: number;
  limit: number;
  incoming: number;
  /** 超出后剩余可用（负数表示超出量） */
  remaining: number;
}

/** 纯函数：used + incoming ≤ limit */
export function checkStorageQuota(used: number, incoming: number, plan: Plan): QuotaCheck {
  const limit = STORAGE_LIMITS[plan];
  const remaining = limit - used - incoming;
  return { ok: incoming <= ATTACHMENT_MAX_BYTES && remaining >= 0, used, limit, incoming, remaining };
}

/** 已用字节：personal → 该 owner 全部个人工作区；team → 该 org 全部 team 工作区（committed 且未删除） */
export async function storageUsedBytes(
  tx: Tx,
  scope: { kind: "personal"; ownerUserId: string } | { kind: "team"; orgId: string },
): Promise<number> {
  const row =
    scope.kind === "personal"
      ? await one<{ used: string }>(
          tx,
          sql`SELECT COALESCE(sum(a.byte_size), 0)::text AS used FROM attachments a
                JOIN workspaces w ON w.id = a.workspace_id
               WHERE w.kind = 'personal' AND w.owner_user_id = ${scope.ownerUserId}
                 AND a.status = 'committed' AND a.deleted_at IS NULL`,
        )
      : await one<{ used: string }>(
          tx,
          sql`SELECT COALESCE(sum(a.byte_size), 0)::text AS used FROM attachments a
                JOIN workspaces w ON w.id = a.workspace_id
               WHERE w.kind = 'team' AND w.org_id = ${scope.orgId}
                 AND a.status = 'committed' AND a.deleted_at IS NULL`,
        );
  return num(row?.used ?? 0);
}

/** 工作区所属套餐：team → organization.plan；personal → free（用户级套餐列由 B1 补齐后在此接入） */
export async function planForWorkspace(
  tx: Tx,
  ws: { kind: "personal" | "team"; org_id: string | null },
): Promise<Plan> {
  if (ws.kind === "team" && ws.org_id) {
    const org = await one<{ plan: string }>(tx, sql`SELECT plan FROM organization WHERE id = ${ws.org_id}`);
    return normalizePlan(org?.plan);
  }
  return "free";
}
