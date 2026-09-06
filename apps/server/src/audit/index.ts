// 审计写入（规格 04 §4.7）：与业务同事务；metadata/before/after 绝不放正文、token、密钥（CI 正则扫描 audit( 调用点）。
import { sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";

export type AuditOutcome = "success" | "denied" | "error";

export interface AuditEntry {
  action: string;
  orgId?: string | null;
  actorType?: "user" | "system";
  actorId?: string | null;
  actorIp?: string | null;
  actorDeviceId?: string | null;
  actorUa?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  outcome?: AuditOutcome;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
}

const FORBIDDEN_KEYS =
  /^(content|content_text|body|text|token|refresh_token|access_token|password|secret|code|code_verifier|user_code|update_v2|state_v2)$/i;

/** 防御：审计 JSON 里出现禁用键名直接抛错（开发期就暴露） */
function assertSafe(obj: Record<string, unknown> | null | undefined, where: string): void {
  if (!obj) return;
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.test(k)) throw new Error(`audit ${where}: 禁止字段 ${k}`);
  }
}

export async function audit(tx: Tx, e: AuditEntry): Promise<void> {
  assertSafe(e.metadata, "metadata");
  assertSafe(e.before, "before");
  assertSafe(e.after, "after");
  await tx.execute(sql`
    INSERT INTO audit_log (org_id, actor_type, actor_id, actor_ip, actor_device_id, actor_ua, action, target_type, target_id, outcome, before, after, metadata, request_id)
    VALUES (${e.orgId ?? null}, ${e.actorType ?? "user"}, ${e.actorId ?? null}, ${e.actorIp ?? null}::inet, ${e.actorDeviceId ?? null}::uuid, ${e.actorUa ?? null},
            ${e.action}, ${e.targetType ?? null}, ${e.targetId ?? null}, ${e.outcome ?? "success"},
            ${e.before ? JSON.stringify(e.before) : null}::jsonb, ${e.after ? JSON.stringify(e.after) : null}::jsonb,
            ${JSON.stringify(e.metadata ?? {})}::jsonb, ${e.requestId ?? null})`);
}
