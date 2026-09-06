// 列表数据：notes_list / notes_search（前缀 → filters，bigram → MATCH，否则 LIKE）；db:changed → invalidate。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { notesList, notesSearch } from "../../ipc/commands.js";
import { useTauriEvent } from "../../ipc/events.js";
import type { NoteListItem } from "../../ipc/types.js";
import { queryKeys } from "../../lib/query.js";
import { parseSearchQuery } from "../../lib/search-query.js";
import type { Filter, Sort } from "./main-store.js";

export function useNotes(filter: Filter, query: string, sort: Sort) {
  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  const searching = parsed.text.length > 0 || Object.keys(parsed.filters).length > 0;
  const trash = filter === "trash" || parsed.filters.trashed === true;

  const q = useQuery({
    queryKey: searching ? queryKeys.search(query, filter) : queryKeys.notes(filter),
    queryFn: async (): Promise<NoteListItem[]> => {
      if (searching) {
        return notesSearch({
          q: parsed.text,
          bigramQuery: parsed.bigramQuery,
          includeTrashed: trash,
          limit: 200,
          filters: { ...parsed.filters, ...(trash ? { trashed: true } : {}) },
        });
      }
      return notesList({ includeTrashed: trash });
    },
    enabled: filter !== "team",
  });

  const items = useMemo(() => {
    const list = (q.data ?? []).filter((n) => {
      const deleted = n.deletedAt !== null;
      if (trash) return deleted;
      if (deleted) return false;
      if (filter === "open") return n.isOpen;
      if (filter === "pinned") return n.pinned || n.zMode === 1;
      return true;
    });
    const cmp = (a: NoteListItem, b: NoteListItem) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      switch (sort) {
        case "created":
          return b.createdAt - a.createdAt;
        case "title":
          return a.title.localeCompare(b.title, "zh-Hans-u-co-pinyin");
        case "color":
          return a.color.localeCompare(b.color);
        default:
          return b.updatedAt - a.updatedAt;
      }
    };
    return [...list].sort(cmp);
  }, [q.data, filter, sort, trash]);

  return { ...q, items, searching, parsed };
}

/** 任何 db:changed 都让列表失效（列表本身很轻） */
export function useDbInvalidation(): void {
  const client = useQueryClient();
  useTauriEvent("db:changed", () => {
    void client.invalidateQueries({ queryKey: ["notes"] });
    void client.invalidateQueries({ queryKey: ["sync"] });
  });
}
