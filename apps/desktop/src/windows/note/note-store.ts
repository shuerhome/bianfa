// 便笺窗内 UI 态（Zustand，仅本窗）。
import type { NoteColor, ZMode } from "@bianfa/shared";
import { create } from "zustand";
import type { SyncState } from "../../ipc/types.js";

export type ToolbarMode = "object" | "format";
export type Overlay = "none" | "color" | "menu" | "context";

export interface ShrinkBanner {
  versionId: string | null;
}

interface NoteUiState {
  focused: boolean;
  collapsed: boolean;
  color: NoteColor;
  zMode: ZMode;
  editorMounted: boolean;
  toolbarMode: ToolbarMode;
  toolbarVisible: boolean;
  overlay: Overlay;
  hasSelection: boolean;
  chars: number;
  words: number;
  syncState: SyncState;
  syncDetail: string | undefined;
  offlineBanner: boolean;
  shrinkBanner: ShrinkBanner | null;
  longWarning: boolean;
  savedAck: boolean;
  set: (patch: Partial<NoteUiState>) => void;
}

export const useNoteStore = create<NoteUiState>((set) => ({
  focused: false,
  collapsed: false,
  color: "graphite",
  zMode: 0,
  editorMounted: false,
  toolbarMode: "object",
  toolbarVisible: false,
  overlay: "none",
  hasSelection: false,
  chars: 0,
  words: 0,
  syncState: "local",
  syncDetail: undefined,
  offlineBanner: false,
  shrinkBanner: null,
  longWarning: false,
  savedAck: false,
  set: (patch) => set(patch),
}));
