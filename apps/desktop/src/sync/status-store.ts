// 四态指示器（specs/03 §2.8 / 06 §4.7）用的状态：sync host 计算并 emit('sync:status')；各窗只读事件。
import { create } from "zustand";
import { emitSyncStatus } from "../ipc/events.js";
import type { SyncState, SyncStatusPayload } from "../ipc/types.js";

export interface NoteSyncEntry {
  state: SyncState;
  detail?: string | undefined;
  at: number;
}

interface StatusStore {
  global: NoteSyncEntry;
  notes: Record<string, NoteSyncEntry>;
  setGlobal(state: SyncState, detail?: string): void;
  setNote(noteId: string, state: SyncState, detail?: string): void;
  clearNote(noteId: string): void;
}

const same = (a: NoteSyncEntry | undefined, state: SyncState, detail?: string) =>
  a !== undefined && a.state === state && a.detail === detail;

export const useSyncStatusStore = create<StatusStore>((set, get) => ({
  global: { state: "local", at: Date.now() },
  notes: {},
  setGlobal(state, detail) {
    if (same(get().global, state, detail)) return;
    const entry = { state, detail, at: Date.now() } satisfies NoteSyncEntry;
    set({ global: entry });
    void emitSyncStatus(toPayload(entry));
  },
  setNote(noteId, state, detail) {
    if (same(get().notes[noteId], state, detail)) return;
    const entry = { state, detail, at: Date.now() } satisfies NoteSyncEntry;
    set((s) => ({ notes: { ...s.notes, [noteId]: entry } }));
    void emitSyncStatus({ ...toPayload(entry), noteId });
  },
  clearNote(noteId) {
    set((s) => {
      const { [noteId]: _removed, ...rest } = s.notes;
      return { notes: rest };
    });
  },
}));

function toPayload(entry: NoteSyncEntry): SyncStatusPayload {
  return entry.detail === undefined
    ? { state: entry.state, at: entry.at }
    : { state: entry.state, at: entry.at, detail: entry.detail };
}

/** 本窗口侧：把事件流折成「这张便笺当前应显示的状态」（便笺级优先，其次全局） */
export function effectiveState(global: SyncStatusPayload | null, note: SyncStatusPayload | null): SyncState {
  if (note?.state === "error") return "error";
  if (!global) return "local";
  if (global.state === "offline" || global.state === "local" || global.state === "error") return global.state;
  if (note) return note.state;
  return global.state;
}
