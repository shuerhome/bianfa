// 迁移 0005 的领域表（B2）：claimed_local_ids、export_jobs、notifications(+preferences/quiet_hours)、comments。
// notes.projected_seq / expires_at / archived_at 与 workspaces.deleted_at 同样由 0005 追加，但 notes.ts / workspaces.ts
// 不属本模块，业务代码对这几列用 sql`` 原生引用（见 src/services/notes.ts）。
// 这些表不开 RLS：访问全部经应用层（authorizeNote / user_id 过滤），worker 以 bianfa_worker 直读。
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { notes } from "./notes.js";

export const claimedLocalIds = pgTable(
  "claimed_local_ids",
  {
    localUserId: uuid("local_user_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("claimed_local_ids_user_idx").on(t.userId)],
);

export const EXPORT_JOB_STATUSES = ["queued", "building", "ready", "failed", "expired"] as const;
export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number];

export const exportJobs = pgTable(
  "export_jobs",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("user").$type<"user" | "org">(),
    status: text("status").notNull().default("queued").$type<ExportJobStatus>(),
    storageKey: text("storage_key"),
    byteSize: bigint("byte_size", { mode: "number" }),
    error: text("error"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    check("export_jobs_scope_check", sql`${t.scope} IN ('user','org')`),
    check("export_jobs_status_check", sql`${t.status} IN ('queued','building','ready','failed','expired')`),
    index("export_jobs_user_idx").on(t.userId, t.createdAt.desc()),
  ],
);

export const NOTIFICATION_KINDS = [
  "note.shared",
  "note.mentioned",
  "comment.created",
  "handoff.due",
  "invite.accepted",
  "seat.limit",
  "note.expiring",
  "export.ready",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const notifications = pgTable(
  "notifications",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
    groupKey: text("group_key"),
    readAt: timestamp("read_at", { withTimezone: true }),
    seenAt: timestamp("seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_user_created_idx").on(t.userId, t.createdAt.desc()),
    index("notif_unread").on(t.userId).where(sql`${t.readAt} IS NULL`),
    index("notif_group").on(t.userId, t.groupKey, t.createdAt.desc()).where(sql`${t.groupKey} IS NOT NULL`),
  ],
);

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    orgId: text("org_id").references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("*"),
    inApp: boolean("in_app").notNull().default(true),
    desktop: boolean("desktop").notNull().default(true),
    email: text("email").notNull().default("digest").$type<"off" | "instant" | "digest">(),
  },
  (t) => [
    check("notification_preferences_email_check", sql`${t.email} IN ('off','instant','digest')`),
    // 迁移里是 UNIQUE NULLS NOT DISTINCT 约束；这里只为类型/查询提示
    uniqueIndex("notification_preferences_uq").on(t.userId, t.orgId, t.kind),
  ],
);

export const notificationQuietHours = pgTable(
  "notification_quiet_hours",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    timezone: text("timezone").notNull().default("UTC"),
    startMinute: smallint("start_minute").notNull().default(1320),
    endMinute: smallint("end_minute").notNull().default(480),
    daysMask: smallint("days_mask").notNull().default(127),
    dndUntil: timestamp("dnd_until", { withTimezone: true }),
    suppressDesktop: boolean("suppress_desktop").notNull().default(true),
    suppressEmail: boolean("suppress_email").notNull().default(false),
  },
  (t) => [
    check(
      "notification_quiet_hours_minutes_check",
      sql`${t.startMinute} BETWEEN 0 AND 1439 AND ${t.endMinute} BETWEEN 0 AND 1439`,
    ),
    check("notification_quiet_hours_days_check", sql`${t.daysMask} BETWEEN 0 AND 127`),
  ],
);

export const COMMENT_MAX_CHARS = 4000;

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey(), // 客户端 UUIDv7，ON CONFLICT DO NOTHING 幂等
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("comments_body_len_check", sql`char_length(${t.body}) BETWEEN 1 AND 4000`),
    index("comments_note_idx").on(t.noteId, t.createdAt),
  ],
);
