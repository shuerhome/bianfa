// 命令面板（specs/06 §4.3）：Ctrl/Cmd+K；空输入 = 最近 5 张 + 动作；前缀 is:/色: 即 chip；⏎ 打开。
import { Icon, type IconName } from "@bianfa/ui";
import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { notesList, notesSearch, settingsWindowOpen, trashEmpty } from "../../ipc/commands.js";
import type { NoteListItem } from "../../ipc/types.js";
import { createNote, openNote } from "../../lib/note-actions.js";
import { parseSearchQuery } from "../../lib/search-query.js";
import { shortcutLabel } from "../../lib/shortcuts.js";
import { relativeTime } from "../../lib/time.js";

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  initialQuery?: string;
  onFilter?: (query: string) => void;
}

interface ActionItem {
  id: string;
  icon: IconName;
  label: string;
  shortcut?: string;
  run: () => void | Promise<void>;
}

export function CommandPalette({ open, onClose, initialQuery = "", onFilter }: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(initialQuery);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => parseSearchQuery(query), [query]);
  const searching = parsed.text.length > 0 || Object.keys(parsed.filters).length > 0;

  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open, initialQuery]);

  const notesQ = useQuery({
    queryKey: ["palette", query],
    queryFn: () =>
      searching
        ? notesSearch({ q: parsed.text, bigramQuery: parsed.bigramQuery, includeTrashed: !!parsed.filters.trashed, limit: 50, filters: parsed.filters })
        : notesList().then((l) => l.filter((n) => n.deletedAt === null).slice(0, 5)),
    enabled: open,
  });

  const actions: ActionItem[] = useMemo(
    () => [
      { id: "new", icon: "plus", label: t("palette.newNote"), shortcut: shortcutLabel("newNote"), run: () => createNote() },
      { id: "settings", icon: "settings", label: t("palette.openSettings"), shortcut: shortcutLabel("settings"), run: () => settingsWindowOpen() },
      { id: "filter", icon: "search", label: t("palette.filterList"), run: () => onFilter?.(query) },
      { id: "trash", icon: "trash-2", label: t("palette.emptyTrash"), run: () => trashEmpty() },
      // TODO(llm): AI 动作（「问 AI」「改写」）在此接入；本期不实现。
    ],
    [t, onFilter, query],
  );

  const notes = notesQ.data ?? [];
  const visibleActions = searching ? actions.filter((a) => a.label.toLowerCase().includes(parsed.text.toLowerCase())) : actions.slice(0, 3);
  const total = notes.length + visibleActions.length;

  useEffect(() => setCursor(0), [query]);

  const runAt = async (i: number) => {
    if (i < notes.length) {
      const n = notes[i];
      if (n) await openNote(n.id);
    } else {
      const a = visibleActions[i - notes.length];
      if (a) await a.run();
    }
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (total === 0 ? 0 : (c + 1) % total));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (total === 0 ? 0 : (c - 1 + total) % total));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (total === 0) {
        void createNote().then(onClose);
      } else void runAt(cursor);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;
  const chips: string[] = [];
  if (parsed.filters.pinned) chips.push("is:pinned");
  if (parsed.filters.trashed) chips.push("is:trashed");
  if (parsed.filters.color) chips.push(`色:${parsed.filters.color}`);

  return (
    <div className="palette-scrim" onPointerDown={onClose} role="presentation">
      <div className="palette" role="dialog" aria-label={t("palette.title")} onPointerDown={(e) => e.stopPropagation()}>
        <div className="palette__input-row">
          <Icon name="search" />
          {chips.map((c) => (
            <span key={c} className="palette__chip">
              {c}
            </span>
          ))}
          <input
            ref={inputRef}
            className="palette__input"
            value={query}
            placeholder={t("palette.placeholder")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label={t("palette.title")}
            aria-activedescendant={total > 0 ? `palette-item-${cursor}` : undefined}
            aria-controls="palette-list"
          />
          <kbd className="bf-kbd">esc</kbd>
        </div>
        <div id="palette-list" className="palette__list" role="listbox" aria-label={t("palette.results")}>
          {notes.length > 0 ? <div className="palette__group">{searching ? t("palette.notes") : t("palette.recent")}</div> : null}
          {notes.map((n: NoteListItem, i) => (
            <PaletteRow key={n.id} id={`palette-item-${i}`} active={i === cursor} onSelect={() => void runAt(i)} color={n.color}>
              <span className="palette__label">{n.title || t("note.untitled")}</span>
              <span className="palette__meta">{relativeTime(n.updatedAt, t)}</span>
            </PaletteRow>
          ))}
          {visibleActions.length > 0 ? <div className="palette__group">{t("palette.actions")}</div> : null}
          {visibleActions.map((a, j) => {
            const i = notes.length + j;
            return (
              <PaletteRow key={a.id} id={`palette-item-${i}`} active={i === cursor} onSelect={() => void runAt(i)}>
                <Icon name={a.icon} />
                <span className="palette__label">{a.label}</span>
                {a.shortcut ? <kbd className="bf-kbd">{a.shortcut}</kbd> : null}
              </PaletteRow>
            );
          })}
          {total === 0 ? <div className="palette__empty">{t("palette.noMatch", { q: parsed.text })}</div> : null}
        </div>
        <div className="palette__footer tabular">
          <span>⏎ {t("palette.open")}</span>
          <span>
            {Math.min(cursor + 1, total)}/{total}
          </span>
        </div>
      </div>
    </div>
  );
}

function PaletteRow({
  id,
  active,
  onSelect,
  color,
  children,
}: {
  id: string;
  active: boolean;
  onSelect: () => void;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: listbox option 由父级 input 的 aria-activedescendant 驱动
    <div
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      className={`palette__row${active ? " palette__row--active" : ""}`}
      data-color={color}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
    >
      {children}
    </div>
  );
}
