// 通知写入（docs/07 §6.4 去重三条硬规则的服务端部分）：① 永不通知 actor 自己；② 同 group_key 30 s 内只发一条（合并计数）。
// 桌面推送 / 邮件 digest 由 worker 与客户端承担，这里只写 notifications 行。
import { sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { one } from "./db-util.js";

export const NOTIFICATION_GROUP_WINDOW_SECONDS = 30;

export interface NotifyInput {
  userId: string;
  kind: string;
  actorId?: string | null;
  orgId?: string | null;
  subjectType: string;
  subjectId: string;
  payload?: Record<string, unknown>;
  groupKey?: string | null;
}

/** 返回 inserted=false 表示被去重规则吞掉 */
export async function notify(tx: Tx, input: NotifyInput): Promise<{ inserted: boolean }> {
  if (input.actorId && input.actorId === input.userId) return { inserted: false };
  if (input.groupKey) {
    const recent = await one<{ id: string }>(
      tx,
      sql`UPDATE notifications SET payload = payload || jsonb_build_object('count', COALESCE((payload->>'count')::int, 1) + 1)
           WHERE id = (SELECT id FROM notifications
                        WHERE user_id = ${input.userId} AND group_key = ${input.groupKey} AND read_at IS NULL
                          AND created_at > now() - make_interval(secs => ${NOTIFICATION_GROUP_WINDOW_SECONDS})
                        ORDER BY created_at DESC LIMIT 1)
           RETURNING id`,
    );
    if (recent) return { inserted: false };
  }
  await tx.execute(
    sql`INSERT INTO notifications (user_id, org_id, kind, actor_id, subject_type, subject_id, payload, group_key)
        VALUES (${input.userId}, ${input.orgId ?? null}, ${input.kind}, ${input.actorId ?? null}, ${input.subjectType},
                ${input.subjectId}, ${JSON.stringify(input.payload ?? {})}::jsonb, ${input.groupKey ?? null})`,
  );
  return { inserted: true };
}
