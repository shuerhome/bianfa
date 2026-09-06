// org 审计查询（规格 04 §6.3：GET /v1/orgs/{id}/audit?since&until&action&cursor + export.csv）。
// 游标 = audit_log.id（降序）；metadata 本就不含禁用字段。
import { sql } from "drizzle-orm";
import { withUserTx } from "../../db/client.js";
import type { OrgContext } from "../org-guard.js";
import type { Actor, ServiceDeps } from "./context.js";

export interface AuditQuery {
  since?: Date | undefined;
  until?: Date | undefined;
  action?: string | undefined;
  cursor?: string | undefined;
  limit: number;
}

export interface AuditRow {
  id: string;
  at: string;
  actor_type: string;
  actor_id: string | null;
  actor_device_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: string;
  before: unknown;
  after: unknown;
  metadata: unknown;
  request_id: string | null;
}

export async function listAudit(
  deps: ServiceDeps,
  actor: Actor,
  org: OrgContext,
  q: AuditQuery,
): Promise<{ entries: AuditRow[]; next_cursor: string | null }> {
  return withUserTx(
    actor.userId,
    async (tx) => {
      const limit = Math.min(Math.max(q.limit, 1), 500);
      const r = await tx.execute(sql`
        SELECT id::text, at, actor_type, actor_id, actor_device_id::text, action, target_type, target_id, outcome, before, after, metadata, request_id
        FROM audit_log
        WHERE org_id = ${org.orgId}
          AND (${q.since ?? null}::timestamptz IS NULL OR at >= ${q.since ?? null}::timestamptz)
          AND (${q.until ?? null}::timestamptz IS NULL OR at < ${q.until ?? null}::timestamptz)
          AND (${q.action ?? null}::text IS NULL OR action = ${q.action ?? null}::text)
          AND (${q.cursor ?? null}::bigint IS NULL OR id < ${q.cursor ?? null}::bigint)
        ORDER BY id DESC
        LIMIT ${limit + 1}`);
      const rows = r.rows as Array<Record<string, unknown>>;
      const page = rows.slice(0, limit);
      const entries: AuditRow[] = page.map((row) => ({
        id: String(row.id),
        at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
        actor_type: String(row.actor_type),
        actor_id: (row.actor_id as string | null) ?? null,
        actor_device_id: (row.actor_device_id as string | null) ?? null,
        action: String(row.action),
        target_type: (row.target_type as string | null) ?? null,
        target_id: (row.target_id as string | null) ?? null,
        outcome: String(row.outcome),
        before: row.before ?? null,
        after: row.after ?? null,
        metadata: row.metadata ?? {},
        request_id: (row.request_id as string | null) ?? null,
      }));
      const next = rows.length > limit ? (entries[entries.length - 1]?.id ?? null) : null;
      return { entries, next_cursor: next };
    },
    deps.db,
  );
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function auditToCsv(entries: AuditRow[]): string {
  const header = [
    "id",
    "at",
    "actor_type",
    "actor_id",
    "actor_device_id",
    "action",
    "target_type",
    "target_id",
    "outcome",
    "before",
    "after",
    "metadata",
    "request_id",
  ];
  const lines = [header.join(",")];
  for (const e of entries) {
    lines.push(header.map((h) => csvCell((e as unknown as Record<string, unknown>)[h])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
