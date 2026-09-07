import { create } from "zustand";

export type Filter = "all" | "open" | "pinned" | "todos" | "trash" | "team";
export type View = "grid" | "list";
export type Sort = "updated" | "created" | "title" | "color";

interface MainUiState {
  filter: Filter;
  view: View;
  sort: Sort;
  query: string;
  selected: Set<string>;
  paletteOpen: boolean;
  updateBanner: { version: string; notes?: string | undefined } | null;
  set: (patch: Partial<MainUiState>) => void;
  toggleSelected: (id: string, multi: boolean) => void;
}

export const useMainStore = create<MainUiState>((set, get) => ({
  filter: "all",
  view: "grid",
  sort: "updated",
  query: "",
  selected: new Set(),
  paletteOpen: false,
  updateBanner: null,
  set: (patch) => set(patch),
  toggleSelected: (id, multi) => {
    const next = new Set(multi ? get().selected : []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selected: next });
  },
}));
