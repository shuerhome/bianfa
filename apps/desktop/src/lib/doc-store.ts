// 便笺窗的 Y.Doc 生命周期（specs/05 §7.2、03 §2.1、02 §3）：
//   load bundle → Y.Doc；本地事务 → 合并后 note_append_update(origin 'local', projection)；
//   快照 50 条 / 5 min / 失焦；db:changed → note_updates_since 增量应用（origin 'remote'）；
//   UndoManager 每 doc 一份，trackedOrigins = { ySyncPluginKey, LOCAL, 'ai' }。
import {
  createNoteDoc,
  encodeStateV2,
  encodeStateVector,
  getBody,
  getMetaMap,
  mergeUpdatesV2,
  type NoteColor,
  type NoteMetaPatch,
  Origins,
  openNoteDoc,
  readMeta,
  writeMeta,
} from "@bianfa/shared";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { buildProjection } from "../editor/projection.js";
import {
  noteAppendUpdate,
  noteCreate,
  noteLoadDoc,
  noteUpdatesSince,
  noteWriteSnapshot,
} from "../ipc/commands.js";
import type { NoteProjection } from "../ipc/types.js";
import { fromB64, toB64 } from "./base64.js";
import { debounce } from "./time.js";

/** 本地写入 origin（规格 02 §3：本地 = client id；这里用带 clientID 的稳定字符串） */
export const LOCAL_ORIGIN = "local";
/** 从本地库回放（初次加载 / db:changed 增量），不再落库 */
const LOAD_ORIGIN = "load";

export const FLUSH_DEBOUNCE_MS = 400;
export const FLUSH_MAX_WAIT_MS = 1000;
export const SNAPSHOT_EVERY_UPDATES = 50;
export const SNAPSHOT_EVERY_MS = 5 * 60_000;

export interface OpenOptions {
  /** note.html?fresh=1：Rust 只分配了 id，JS 负责 note_create */
  fresh?: boolean | undefined;
  color?: NoteColor | undefined;
  workspaceId?: string | null | undefined;
}

export interface NoteSession {
  readonly noteId: string;
  readonly doc: Y.Doc;
  readonly undoManager: Y.UndoManager;
  /** 本地库已应用到的 seq */
  headSeq: number;
  /** 最近一次投影（含 bodyHtml），供静态视图与标题 */
  projection: NoteProjection;
  /** 立即落盘（Ctrl+S / 失焦 / 关窗前） */
  flush(): Promise<void>;
  /** 写快照（失焦 / 关窗前也会调用） */
  snapshot(): Promise<void>;
  /** db:changed 后拉增量；IME 组合期挂起，compositionend 后放行 */
  applyRemoteSince(): Promise<void>;
  setComposing(composing: boolean): void;
  /** 本地 meta 写入（颜色 / zMode / 删除）；走同一条落盘队列 */
  updateMeta(patch: NoteMetaPatch): void;
  onProjection(cb: (p: NoteProjection) => void): () => void;
  destroy(): void;
}

export async function openNoteSession(noteId: string, opts: OpenOptions = {}): Promise<NoteSession> {
  let doc: Y.Doc;
  let headSeq: number;
  if (opts.fresh) {
    doc = createNoteDoc(noteId, { meta: opts.color ? { color: opts.color } : {}, origin: LOAD_ORIGIN });
    const projection = buildProjection(doc);
    const created = await noteCreate({
      noteId,
      updateV2B64: toB64(encodeStateV2(doc)),
      projection,
      workspaceId: opts.workspaceId ?? null,
    });
    headSeq = created.headSeq;
  } else {
    const bundle = await noteLoadDoc(noteId);
    const updates: Uint8Array[] = [];
    if (bundle.snapshotB64) updates.push(fromB64(bundle.snapshotB64));
    for (const u of bundle.updatesB64) updates.push(fromB64(u));
    doc = openNoteDoc(noteId, updates, LOAD_ORIGIN);
    headSeq = bundle.headSeq;
  }
  return createSession(noteId, doc, headSeq);
}

function createSession(noteId: string, doc: Y.Doc, initialHeadSeq: number): NoteSession {
  const undoManager = new Y.UndoManager(getBody(doc), {
    trackedOrigins: new Set<unknown>([ySyncPluginKey, LOCAL_ORIGIN, Origins.ai]),
    captureTimeout: 500,
  });
  const listeners = new Set<(p: NoteProjection) => void>();
  let pendingUpdates: Uint8Array[] = [];
  let appendsSinceSnapshot = 0;
  let dirtySinceSnapshot = false;
  let composing = false;
  let remoteQueued = false;
  let chain: Promise<void> = Promise.resolve();
  let destroyed = false;

  const session: NoteSession = {
    noteId,
    doc,
    undoManager,
    headSeq: initialHeadSeq,
    projection: buildProjection(doc),
    flush,
    snapshot,
    applyRemoteSince,
    setComposing,
    updateMeta,
    onProjection(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    destroy,
  };

  const notify = () => {
    session.projection = buildProjection(doc);
    for (const cb of listeners) cb(session.projection);
  };

  /** 串行化所有落库调用，保证 seq 单调 */
  const enqueue = (task: () => Promise<void>) => {
    chain = chain.then(task, task);
    return chain;
  };

  async function persistPending(): Promise<void> {
    if (pendingUpdates.length === 0 || destroyed) return;
    const batch = pendingUpdates;
    pendingUpdates = [];
    const merged = batch.length === 1 ? (batch[0] as Uint8Array) : mergeUpdatesV2(batch);
    // updatedAt 每个持久化批次写一次（规格 02 §3）；写在同一批里避免多一条 update
    const projection = buildProjection(doc);
    const { seq } = await noteAppendUpdate({
      noteId,
      updateV2B64: toB64(merged),
      origin: "local",
      projection,
    });
    session.headSeq = Math.max(session.headSeq, seq);
    appendsSinceSnapshot += 1;
    dirtySinceSnapshot = true;
    if (appendsSinceSnapshot >= SNAPSHOT_EVERY_UPDATES) await writeSnapshot();
  }

  const scheduleFlush = debounce(() => void enqueue(persistPending), FLUSH_DEBOUNCE_MS, FLUSH_MAX_WAIT_MS);

  // 每个 persist 批次前把 updatedAt 记进 meta（与同步 debounce 同拍，≤1 次 / 批）
  const stampUpdatedAt = () => {
    const meta = getMetaMap(doc);
    const now = Date.now();
    const prev = meta.get("updatedAt");
    if (typeof prev === "number" && now - prev < 2000) return;
    doc.transact(() => {
      meta.set("updatedAt", now);
    }, LOCAL_ORIGIN);
  };

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === LOAD_ORIGIN || origin === Origins.remote) return;
    pendingUpdates.push(update);
    scheduleFlush();
  };
  doc.on("updateV2", onUpdate);

  // 正文事务（编辑器 origin = ySyncPluginKey）后再补 updatedAt，与正文 update 合并进同一批
  const onAfter = (tr: Y.Transaction) => {
    if (tr.origin === ySyncPluginKey || tr.origin === Origins.ai) stampUpdatedAt();
    if (tr.origin !== LOAD_ORIGIN) notify();
    else notify();
  };
  doc.on("afterTransaction", onAfter);

  async function flush(): Promise<void> {
    scheduleFlush.cancel();
    await enqueue(persistPending);
  }

  async function writeSnapshot(): Promise<void> {
    if (!dirtySinceSnapshot || destroyed) return;
    dirtySinceSnapshot = false;
    appendsSinceSnapshot = 0;
    await noteWriteSnapshot({
      noteId,
      stateV2B64: toB64(encodeStateV2(doc)),
      svB64: toB64(encodeStateVector(doc)),
      uptoSeq: session.headSeq,
    });
  }

  async function snapshot(): Promise<void> {
    await flush();
    await enqueue(writeSnapshot);
  }

  const snapshotTimer = window.setInterval(() => void enqueue(writeSnapshot), SNAPSHOT_EVERY_MS);

  async function applyRemoteSince(): Promise<void> {
    if (destroyed) return;
    if (composing) {
      remoteQueued = true;
      return;
    }
    await enqueue(async () => {
      const res = await noteUpdatesSince(noteId, session.headSeq);
      if (res.updatesB64.length > 0) {
        doc.transact(() => {
          for (const u of res.updatesB64) Y.applyUpdateV2(doc, fromB64(u), Origins.remote);
        }, Origins.remote);
      }
      session.headSeq = Math.max(session.headSeq, res.headSeq);
    });
  }

  function setComposing(next: boolean): void {
    composing = next;
    if (!next && remoteQueued) {
      remoteQueued = false;
      void applyRemoteSince();
    }
  }

  function updateMeta(patch: NoteMetaPatch): void {
    writeMeta(doc, { ...patch, updatedAt: Date.now() }, LOCAL_ORIGIN);
  }

  function destroy(): void {
    destroyed = true;
    scheduleFlush.cancel();
    window.clearInterval(snapshotTimer);
    doc.off("updateV2", onUpdate);
    doc.off("afterTransaction", onAfter);
    undoManager.destroy();
    listeners.clear();
  }

  return session;
}

/** 便于其它窗口做一次性 meta 修改：读 bundle → 改 → 落库（不保留 doc） */
export async function withNoteDoc(
  noteId: string,
  mutate: (doc: Y.Doc) => void,
  origin: "local" | "import" | "ai" = "local",
): Promise<{ seq: number; projection: NoteProjection }> {
  const bundle = await noteLoadDoc(noteId);
  const updates: Uint8Array[] = [];
  if (bundle.snapshotB64) updates.push(fromB64(bundle.snapshotB64));
  for (const u of bundle.updatesB64) updates.push(fromB64(u));
  const doc = openNoteDoc(noteId, updates, LOAD_ORIGIN);
  const captured: Uint8Array[] = [];
  const capture = (u: Uint8Array, o: unknown) => {
    if (o !== LOAD_ORIGIN) captured.push(u);
  };
  doc.on("updateV2", capture);
  doc.transact(() => {
    mutate(doc);
    getMetaMap(doc).set("updatedAt", Date.now());
  }, origin);
  doc.off("updateV2", capture);
  const projection = buildProjection(doc);
  if (captured.length === 0) {
    doc.destroy();
    return { seq: bundle.headSeq, projection };
  }
  const merged = captured.length === 1 ? (captured[0] as Uint8Array) : mergeUpdatesV2(captured);
  const res = await noteAppendUpdate({ noteId, updateV2B64: toB64(merged), origin, projection });
  doc.destroy();
  return { seq: res.seq, projection };
}

export { readMeta };
