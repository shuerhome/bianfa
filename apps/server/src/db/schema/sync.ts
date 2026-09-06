// 规格 03 §6：note_versions（版本历史；projector 写、sync-ws 不写）。建表在 custom migration 0006_sync.sql。
// notes.crdt_sv（同一迁移新增）不在 notes.ts 的表定义里（该文件非本模块所有），sync 代码用 sql`crdt_sv` 直接读写。
import { bigint, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { notes } from "./notes.js";
import { bytea } from "./types.js";

export const noteVersions = pgTable(
  "note_versions",
  {
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    crdtStateV2: bytea("crdt_state_v2").notNull(),
    contentText: text("content_text").notNull().default(""),
    authorId: text("author_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    label: text("label"),
  },
  (t) => [
    primaryKey({ columns: [t.noteId, t.seq] }),
    index("note_versions_note_created_idx").on(t.noteId, t.createdAt.desc()),
  ],
);
