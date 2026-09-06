// 便笺 CRDT 存储（规格 03 §1.5 / §4）：note_snapshots + note_updates → 状态；追加 update；阈值压缩。
// 服务端唯一的 Y.Doc 读写口，sync-ws 的 onLoadDocument/onStoreDocument 与 worker 的 projector 共用。
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import * as Y from "yjs";
import type { Tx } from "../db/client.js";
import { noteSnapshots, notes, noteUpdates } from "../db/schema/index.js";

/** 压缩阈值（03 §1.5 #4）：自上次快照起 ≥200 条 update 或累计 ≥512 KB */
export const COMPACT_UPDATE_COUNT = 200;
export const COMPACT_BYTES = 512 * 1024;

export interface NoteState {
  /** 合并后的 update V2（可直接 applyUpdateV2 到空 Doc）；无任何数据时为 null */
  stateV2: Uint8Array | null;
  headSeq: number;
  snapshotUptoSeq: number;
}

/** 读取快照 + 其后的 updates，合并为单个 V2 update（不构造 Doc） */
export async function loadNoteState(tx: Tx, noteId: string): Promise<NoteState> {
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

/** 从存储重建 Y.Doc（gc:true）；调用方负责 destroy() */
export async function loadNoteDoc(tx: Tx, noteId: string): Promise<{ doc: Y.Doc; headSeq: number }> {
  const state = await loadNoteState(tx, noteId);
  const doc = new Y.Doc({ guid: noteId, gc: true });
  if (state.stateV2) Y.applyUpdateV2(doc, state.stateV2, "load");
  return { doc, headSeq: state.headSeq };
}

export interface AppendResult {
  seq: number;
  compacted: boolean;
}

/**
 * 追加一条 update（调用方必须已在同一事务内 `SELECT … FROM notes WHERE id=$1 FOR UPDATE` 或持有等价行锁）。
 * - seq = head_seq + 1，写 note_updates，更新 notes.head_seq / crdt_bytes / lsn / updated_at
 * - 达到阈值时用 fullStateV2（调用方提供，通常 = Y.encodeStateAsUpdateV2(doc)）写快照并删除 seq <= 新快照的 updates
 */
export async function appendNoteUpdate(
  tx: Tx,
  input: {
    noteId: string;
    updateV2: Uint8Array;
    authorId: string | null;
    deviceId: string | null;
    /** 当前完整状态（用于快照与 crdt_bytes）；给 null 则跳过压缩 */
    fullStateV2: Uint8Array | null;
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
  await tx
    .update(notes)
    .set({
      headSeq: seq,
      crdtBytes: input.fullStateV2 ? input.fullStateV2.byteLength : undefined,
      lsn: sql`nextval('global_lsn')`,
      updatedAt: sql`now()`,
    })
    .where(eq(notes.id, input.noteId));

  let compacted = false;
  if (input.fullStateV2) {
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
    if (agg && (agg.n >= COMPACT_UPDATE_COUNT || agg.bytes >= COMPACT_BYTES)) {
      await writeSnapshot(tx, input.noteId, seq, input.fullStateV2);
      compacted = true;
    }
  }
  return { seq, compacted };
}

/** 写快照并删除已覆盖的 updates（历史由 note_versions 承担，03 §6） */
export async function writeSnapshot(
  tx: Tx,
  noteId: string,
  uptoSeq: number,
  stateV2: Uint8Array,
): Promise<void> {
  const sv = Y.encodeStateVectorFromUpdateV2(stateV2);
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
  await tx
    .delete(noteSnapshots)
    .where(
      and(
        eq(noteSnapshots.noteId, noteId),
        sql`${noteSnapshots.uptoSeq} < ${uptoSeq}`,
        eq(noteSnapshots.isMilestone, false),
      ),
    );
}
