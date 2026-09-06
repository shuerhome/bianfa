// 便笺 CRDT 存储（规格 03 §1.5 / §4）：note_snapshots + note_updates → 状态；追加 update；阈值压缩。
// 服务端唯一的 Y.Doc 读写口，sync-ws 的 onLoadDocument/onStoreDocument 与 worker 的 projector 共用。
// 执行器既可以是 withUserTx 的事务句柄，也可以是绑定到单个 pg 连接的 drizzle 实例（sync-ws 为了让 pg-boss
// 在同一事务内入队而自管 BEGIN/COMMIT，见 src/sync/persistence.ts）。
// notes.crdt_sv（迁移 0006）不在 schema/notes.ts 的表定义里，这里用 sql 片段直接读写。
import { and, asc, desc, type ExtractTablesWithRelations, eq, gt, lte, sql } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase } from "drizzle-orm/pg-core";
import * as Y from "yjs";
import type * as schema from "../db/schema/index.js";
import { noteSnapshots, notes, noteUpdates } from "../db/schema/index.js";

/** 事务句柄（Tx）或绑定到单连接的 drizzle 实例；只用 select/insert/update/delete/execute */
export type DocStoreExecutor = PgDatabase<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** 压缩阈值（03 §1.5 #4）：自上次快照起 ≥200 条 update 或累计 ≥512 KB */
export const COMPACT_UPDATE_COUNT = 200;
export const COMPACT_BYTES = 512 * 1024;

export interface CompactionThresholds {
  updates?: number;
  bytes?: number;
}

export interface NoteState {
  /** 合并后的 update V2（可直接 applyUpdateV2 到空 Doc）；无任何数据时为 null */
  stateV2: Uint8Array | null;
  headSeq: number;
  snapshotUptoSeq: number;
}

/** 读取快照 + 其后的 updates，合并为单个 V2 update（不构造 Doc） */
export async function loadNoteState(tx: DocStoreExecutor, noteId: string): Promise<NoteState> {
  const [snap] = await tx
    .select({ uptoSeq: noteSnapshots.uptoSeq, stateV2: noteSnapshots.stateV2 })
    .from(noteSnapshots)
    .where(eq(noteSnapshots.noteId, noteId))
    .orderBy(desc(noteSnapshots.uptoSeq))
    .limit(1);
  const uptoSeq = snap ? snap.uptoSeq : 0;
  const rows = await tx
    .select({ seq: noteUpdates.seq, updateV2: noteUpdates.updateV2 })
    .from(noteUpdates)
    .where(and(eq(noteUpdates.noteId, noteId), gt(noteUpdates.seq, uptoSeq)))
    .orderBy(asc(noteUpdates.seq));
  const parts: Uint8Array[] = [];
  if (snap) parts.push(new Uint8Array(snap.stateV2));
  for (const r of rows) parts.push(new Uint8Array(r.updateV2));
  const headSeq = rows.length > 0 ? (rows[rows.length - 1]?.seq ?? uptoSeq) : uptoSeq;
  return {
    stateV2:
      parts.length === 0 ? null : parts.length === 1 ? (parts[0] as Uint8Array) : Y.mergeUpdatesV2(parts),
    headSeq,
    snapshotUptoSeq: uptoSeq,
  };
}

/** 从存储重建 Y.Doc（gc:true）；调用方负责 destroy()。stateBytes = 合并后 update V2 的字节数（0 = 空） */
export async function loadNoteDoc(
  tx: DocStoreExecutor,
  noteId: string,
): Promise<{ doc: Y.Doc; headSeq: number; stateBytes: number }> {
  const state = await loadNoteState(tx, noteId);
  const doc = new Y.Doc({ guid: noteId, gc: true });
  if (state.stateV2) Y.applyUpdateV2(doc, state.stateV2, "load");
  return { doc, headSeq: state.headSeq, stateBytes: state.stateV2?.byteLength ?? 0 };
}

export interface NoteHead {
  headSeq: number;
  /** 上次持久化时的 state vector（V2）；从未持久化为 null */
  crdtSv: Uint8Array | null;
  crdtBytes: number;
}

/** `SELECT head_seq, crdt_sv FROM notes WHERE id=$1 FOR UPDATE`：行锁是多副本下 seq 唯一性的保障（03 §1.5 #1） */
export async function lockNoteHead(tx: DocStoreExecutor, noteId: string): Promise<NoteHead | null> {
  const result = await tx.execute<{ head_seq: string | number; crdt_sv: Buffer | null; crdt_bytes: number }>(
    sql`SELECT head_seq, crdt_sv, crdt_bytes FROM notes WHERE id = ${noteId} FOR UPDATE`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    headSeq: Number(row.head_seq),
    crdtSv: row.crdt_sv ? new Uint8Array(row.crdt_sv) : null,
    crdtBytes: row.crdt_bytes,
  };
}

export interface AppendResult {
  seq: number;
  compacted: boolean;
}

/**
 * 追加一条 update（调用方必须已在同一事务内 `SELECT … FROM notes WHERE id=$1 FOR UPDATE` 或持有等价行锁；
 * 本函数会再锁一次，同事务内重复加锁是空操作）。
 * - seq = head_seq + 1，写 note_updates，更新 notes.head_seq / crdt_bytes / crdt_sv / lsn / updated_at
 * - 达到阈值时用 fullStateV2（调用方提供，通常 = Y.encodeStateAsUpdateV2(doc)）写快照并删除 seq <= 新快照的 updates
 */
export async function appendNoteUpdate(
  tx: DocStoreExecutor,
  input: {
    noteId: string;
    updateV2: Uint8Array;
    authorId: string | null;
    deviceId: string | null;
    /** 当前完整状态（用于快照、crdt_bytes 与 crdt_sv）；给 null 则跳过压缩且不更新 crdt_sv */
    fullStateV2: Uint8Array | null;
    /** 压缩阈值覆盖（测试用；缺省 200 条 / 512 KB） */
    thresholds?: CompactionThresholds;
  },
): Promise<AppendResult> {
  const [row] = await tx
    .select({ headSeq: notes.headSeq })
    .from(notes)
    .where(eq(notes.id, input.noteId))
    .for("update");
  if (!row) throw new Error(`note ${input.noteId} not found`);
  const seq = row.headSeq + 1;
  await tx.insert(noteUpdates).values({
    noteId: input.noteId,
    seq,
    updateV2: Buffer.from(input.updateV2),
    authorId: input.authorId,
    deviceId: input.deviceId,
  });
  if (input.fullStateV2) {
    const sv = Buffer.from(Y.encodeStateVectorFromUpdateV2(input.fullStateV2));
    await tx.execute(sql`
      UPDATE notes
         SET head_seq = ${seq}, crdt_bytes = ${input.fullStateV2.byteLength}, crdt_sv = ${sv},
             lsn = nextval('global_lsn'), updated_at = now()
       WHERE id = ${input.noteId}`);
  } else {
    await tx
      .update(notes)
      .set({ headSeq: seq, lsn: sql`nextval('global_lsn')`, updatedAt: sql`now()` })
      .where(eq(notes.id, input.noteId));
  }

  let compacted = false;
  if (input.fullStateV2) {
    const maxUpdates = input.thresholds?.updates ?? COMPACT_UPDATE_COUNT;
    const maxBytes = input.thresholds?.bytes ?? COMPACT_BYTES;
    const [snap] = await tx
      .select({ uptoSeq: noteSnapshots.uptoSeq })
      .from(noteSnapshots)
      .where(eq(noteSnapshots.noteId, input.noteId))
      .orderBy(desc(noteSnapshots.uptoSeq))
      .limit(1);
    const uptoSeq = snap ? snap.uptoSeq : 0;
    const [agg] = await tx
      .select({
        n: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(octet_length(update_v2)),0)::int`,
      })
      .from(noteUpdates)
      .where(and(eq(noteUpdates.noteId, input.noteId), gt(noteUpdates.seq, uptoSeq)));
    if (agg && (agg.n >= maxUpdates || agg.bytes >= maxBytes)) {
      await writeSnapshot(tx, input.noteId, seq, input.fullStateV2);
      compacted = true;
    }
  }
  return { seq, compacted };
}

/**
 * 写快照并删除已覆盖的 updates（历史由 note_versions 承担，03 §6）。
 * note_snapshots_head_uq 是 `(note_id) WHERE NOT is_milestone` 的部分唯一索引（每便笺一个 head），
 * 所以必须先删旧 head 再插新 head，否则第二次压缩起就撞唯一约束。
 */
export async function writeSnapshot(
  tx: DocStoreExecutor,
  noteId: string,
  uptoSeq: number,
  stateV2: Uint8Array,
): Promise<void> {
  const sv = Y.encodeStateVectorFromUpdateV2(stateV2);
  await tx
    .delete(noteSnapshots)
    .where(
      and(
        eq(noteSnapshots.noteId, noteId),
        sql`${noteSnapshots.uptoSeq} < ${uptoSeq}`,
        eq(noteSnapshots.isMilestone, false),
      ),
    );
  await tx
    .insert(noteSnapshots)
    .values({
      noteId,
      uptoSeq,
      stateV2: Buffer.from(stateV2),
      sv: Buffer.from(sv),
      byteSize: stateV2.byteLength,
    })
    .onConflictDoUpdate({
      target: [noteSnapshots.noteId, noteSnapshots.uptoSeq],
      set: { stateV2: Buffer.from(stateV2), sv: Buffer.from(sv), byteSize: stateV2.byteLength },
    });
  await tx.delete(noteUpdates).where(and(eq(noteUpdates.noteId, noteId), lte(noteUpdates.seq, uptoSeq)));
}

/** update V2 是否不含任何 struct 且 delete set 为空（= 对存储没有新信息） */
export function isEmptyUpdateV2(update: Uint8Array): boolean {
  const { structs, ds } = Y.decodeUpdateV2(update);
  return structs.length === 0 && ds.clients.size === 0;
}
