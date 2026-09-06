// 通知（服务端 src/routes/notifications.ts）：GET /v1/notifications、POST /v1/notifications/read。
import { apiJson, isoToMs, isoToMsOr } from "./http.js";

export interface Notification {
  id: number;
  orgId: string | null;
  kind: string;
  actor: { userId: string; name: string | null } | null;
  subject: { type: string; id: string };
  payload: Record<string, unknown>;
  groupKey: string | null;
  readAt: number | null;
  seenAt: number | null;
  createdAt: number;
}

interface NotificationDto {
  id: number;
  org_id: string | null;
  kind: string;
  actor: { user_id: string; name: string | null } | null;
  subject: { type: string; id: string };
  payload: Record<string, unknown>;
  group_key: string | null;
  read_at: string | null;
  seen_at: string | null;
  created_at: string;
}

export function mapNotification(n: NotificationDto): Notification {
  return {
    id: n.id,
    orgId: n.org_id ?? null,
    kind: n.kind,
    actor: n.actor ? { userId: n.actor.user_id, name: n.actor.name ?? null } : null,
    subject: n.subject,
    payload: n.payload ?? {},
    groupKey: n.group_key ?? null,
    readAt: isoToMs(n.read_at),
    seenAt: isoToMs(n.seen_at),
    createdAt: isoToMsOr(n.created_at, 0),
  };
}

export interface NotificationsPage {
  notifications: Notification[];
  unreadCount: number;
  nextCursor: number | null;
}

/** GET /v1/notifications?cursor&limit&unread → { notifications, unread_count, next_cursor } */
export async function fetchNotifications(
  opts: { cursor?: number; limit?: number; unread?: boolean } = {},
): Promise<NotificationsPage> {
  const r = await apiJson<{
    notifications: NotificationDto[];
    unread_count: number;
    next_cursor: number | null;
  }>("GET", "/v1/notifications", {
    query: { cursor: opts.cursor, limit: opts.limit, unread: opts.unread ? "true" : undefined },
  });
  return {
    notifications: (r.notifications ?? []).map(mapNotification),
    unreadCount: r.unread_count ?? 0,
    nextCursor: r.next_cursor ?? null,
  };
}

/** POST /v1/notifications/read { ids } | { all: true } → { updated } */
export async function markNotificationsRead(target: { ids: number[] } | { all: true }): Promise<number> {
  const r = await apiJson<{ updated: number }>("POST", "/v1/notifications/read", { body: target });
  return r.updated ?? 0;
}
