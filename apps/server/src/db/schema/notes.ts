// 规格 02 §1.3 / §1.4 / §1.6：notes（投影 + 元数据）、note_updates、note_snapshots、checklist_items。
// 真源是每便笺一个 Y.Doc；content / content_text / color / z_mode / checklist_items 只由 projector 写。
//
// 序列 global_lsn（change feed 唯一权威顺序）由 custom migration 0000 用 CREATE SEQUENCE IF NOT EXISTS 建，
// 这里只通过 DEFAULT nextval('global_lsn') 引用，不用 pgSequence()（否则 drizzle-kit 会再生成一遍 CREATE SEQUENCE）。
// notes_list_idx 带 INCLUDE 子句，drizzle 索引 builder 表达不了，同样放在 custom migration 0002。

import { NOTE_COLORS, type NoteColor } from "@bianfa/shared";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { device } from "./device.js";

import { bytea } from "./types.js";
import { workspaces } from "./workspaces.js";

export const GLOBAL_LSN_SEQUENCE = "global_lsn";
/** `nextval('global_lsn')`：notes.lsn / note_updates.lsn 的默认值，也可在 UPDATE notes SET lsn = … 时复用 */
export const nextGlobalLsn = sql`nextval('global_lsn')`;

// 20 色的唯一定义在 @bianfa/shared（枚举名 = 存储值），这里只转出去，避免两处清单各改各的
export { NOTE_COLORS, type NoteColor } from "@bianfa/shared";

/** CHECK 约束里的颜色字面量列表；迁移 0008 与本文件必须一致 */
const NOTE_COLOR_LITERALS = NOTE_COLORS.map((c) => `'${c}'`).join(",");

export const EMPTY_DOC = { type: "doc", content: [] } as const;

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey(), // 客户端 UUIDv7
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    // ── 投影列：只由 projector 写 ──
    content: jsonb("content")
      .notNull()
      .default(sql`'{"type":"doc","content":[]}'::jsonb`)
      .$type<Record<string, unknown>>(),
    contentText: text("content_text").notNull().default(""),
    titleCache: text("title_cache").generatedAlwaysAs(sql`left(split_part(content_text, E'\\n', 1), 120)`),
    color: text("color").notNull().default("graphite").$type<NoteColor>(),
    zMode: smallint("z_mode").notNull().default(0), // 0 普通 / 1 置顶 / 2 贴桌面
    pinned: boolean("pinned").generatedAlwaysAs(sql`z_mode = 1`),
    schemaVersion: smallint("schema_version").notNull().default(1),
    headSeq: bigint("head_seq", { mode: "number" }).notNull().default(0),
    crdtBytes: integer("crdt_bytes").notNull().default(0),
    lsn: bigint("lsn", { mode: "number" }).notNull().default(nextGlobalLsn),
    // ── 迁移幂等键 ──
    importSource: text("import_source"),
    importExternalId: text("import_external_id"),
    // ── E2EE 预留 ──
    encryption: text("encryption").notNull().default("server"),
    vaultId: uuid("vault_id"),
    wrappedDek: bytea("wrapped_dek"),
    keyEpoch: integer("key_epoch"),
    // ── 时间 / 删除（= Y.Map('meta') 的 createdAt / updatedAt / deletedAt）──
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    purgeAfter: timestamp("purge_after", { withTimezone: true }),
    purgedAt: timestamp("purged_at", { withTimezone: true }),
  },
  (t) => [
    check("notes_color_check", sql`${t.color} IN (${sql.raw(NOTE_COLOR_LITERALS)})`),
    check("notes_z_mode_check", sql`${t.zMode} BETWEEN 0 AND 2`),
    check("notes_import_source_check", sql`${t.importSource} IN ('plum.sqlite','snt','json')`),
    check("notes_encryption_check", sql`${t.encryption} IN ('server','e2ee')`),
    check("notes_purge_shape", sql`${t.purgeAfter} IS NULL OR ${t.deletedAt} IS NOT NULL`),
    index("notes_trash_idx").on(t.workspaceId, t.deletedAt.desc()).where(sql`${t.deletedAt} IS NOT NULL`),
    index("notes_feed_idx").on(t.workspaceId, t.lsn),
    index("notes_purge_idx")
      .on(t.purgeAfter)
      .where(sql`${t.purgeAfter} IS NOT NULL AND ${t.purgedAt} IS NULL`),
    uniqueIndex("notes_import_uq")
      .on(t.workspaceId, t.importSource, t.importExternalId)
      .where(sql`${t.importExternalId} IS NOT NULL`),
    // 中文检索：pg_bigm GIN（第 1 章 C6）
    index("notes_content_bigm_idx")
      .using("gin", t.contentText.op("gin_bigm_ops"))
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const noteUpdates = pgTable(
  "note_updates",
  {
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(), // 每便笺单调递增，服务端分配
    updateV2: bytea("update_v2").notNull(), // Yjs updateV2；e2ee 时为密文
    authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
    deviceId: uuid("device_id").references(() => device.id, { onDelete: "set null" }),
    lsn: bigint("lsn", { mode: "number" }).notNull().default(nextGlobalLsn),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.noteId, t.seq] }), index("note_updates_lsn_idx").on(t.lsn)],
);

export const noteSnapshots = pgTable(
  "note_snapshots",
  {
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    uptoSeq: bigint("upto_seq", { mode: "number" }).notNull(),
    stateV2: bytea("state_v2").notNull(),
    sv: bytea("sv").notNull(),
    isMilestone: boolean("is_milestone").notNull().default(false),
    byteSize: integer("byte_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.noteId, t.uptoSeq] }),
    uniqueIndex("note_snapshots_head_uq").on(t.noteId).where(sql`NOT ${t.isMilestone}`), // 每便笺一个 head
    index("note_snapshots_milestone_idx").on(t.createdAt).where(sql`${t.isMilestone}`),
  ],
);

export const checklistItems = pgTable(
  "checklist_items",
  {
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    blockId: text("block_id").notNull(), // taskItem.attrs.id（nanoid(10)）
    text: text("text").notNull(),
    checked: boolean("checked").notNull(),
    ordinal: integer("ordinal").notNull(),
  },
  (t) => [primaryKey({ columns: [t.noteId, t.blockId] })],
);
