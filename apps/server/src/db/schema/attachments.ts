// 规格 02 §1.5 / §8：attachments（对象元数据，客户端生成 id）与 attachment_refs（projector 投影，mark-and-sweep GC）。
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { notes } from "./notes.js";
import { bytea } from "./types.js";
import { workspaces } from "./workspaces.js";

export const ATTACHMENT_MAX_BYTES = 10_485_760;
export const ATTACHMENT_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    contentHash: bytea("content_hash").notNull(), // BLAKE3-256；e2ee 取密文 hash
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    mime: text("mime").notNull(),
    width: integer("width"),
    height: integer("height"),
    blurhash: text("blurhash"),
    storageKey: text("storage_key").notNull(), // 'ws/<workspace_id>/blake3/<hex[0:2]>/<hex[2:4]>/<hex>'
    status: text("status").notNull().default("pending"),
    encrypted: boolean("encrypted").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check("attachments_hash_len_check", sql`octet_length(${t.contentHash}) = 32`),
    check("attachments_byte_size_check", sql`${t.byteSize} > 0 AND ${t.byteSize} <= 10485760`),
    check("attachments_mime_check", sql`${t.mime} IN ('image/png','image/jpeg','image/gif','image/webp')`),
    check("attachments_status_check", sql`${t.status} IN ('pending','committed')`),
    index("attachments_hash_idx")
      .on(t.workspaceId, t.contentHash)
      .where(sql`${t.status} = 'committed' AND NOT ${t.encrypted}`),
    index("attachments_pending_idx").on(t.createdAt).where(sql`${t.status} = 'pending'`),
  ],
);

export const attachmentRefs = pgTable(
  "attachment_refs",
  {
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    attachmentId: uuid("attachment_id")
      .notNull()
      .references(() => attachments.id, { onDelete: "cascade" }),
    lastReferencedAt: timestamp("last_referenced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.noteId, t.attachmentId] }),
    index("attachment_refs_att_idx").on(t.attachmentId, t.lastReferencedAt),
  ],
);
