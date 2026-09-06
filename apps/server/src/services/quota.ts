// 配额（规格 04 §4.5）：云存储 Free 100 MB / Pro 2 GB / Team 10 GB per org；单张图片 ≤ 10 MB。
// 执行点 POST /v1/attachments/presign：sum(byte_size) 按 personal workspace 归 user、team workspace 归 org。
import { sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
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
/** Free 同步设备上限（token 端点执行；B1 的 /me/devices 亦用） */
export const DEVICE_LIMITS: Record<Plan, number> = {
  free: 2,
  pro: Number.POSITIVE_INFINITY,
  team: Number.POSITIVE_INFINITY,
};

export function normalizePlan(raw: string | null | undefined): Plan {
  return raw === "pro" || raw === "team" ? raw : "free";
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
