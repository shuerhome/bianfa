// 卡片（specs/06 §4.2）：左 3px 身份条（--note-dot）、标题 / 摘要 5 行 / 元信息行；四通道状态。
import { NOTE_COLOR_INFO } from "@bianfa/shared";
import { Icon } from "@bianfa/ui";
import type { KeyboardEvent, MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { NoteListItem } from "../../ipc/types.js";
import { relativeTime } from "../../lib/time.js";

export interface NoteCardProps {
  note: NoteListItem;
  selected: boolean;
  view: "grid" | "list";
  onOpen: (note: NoteListItem) => void;
  onSelect: (note: NoteListItem, multi: boolean) => void;
  onContextMenu: (note: NoteListItem, anchor: HTMLElement) => void;
}

export function NoteCard({ note, selected, view, onOpen, onSelect, onContextMenu }: NoteCardProps) {
  const { t, i18n } = useTranslation();
  const info = NOTE_COLOR_INFO[note.color];
  const colorName = i18n.language.startsWith("zh") ? info.zh : info.en;
  const onClick = (e: MouseEvent<HTMLElement>) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) onSelect(note, true);
    else onSelect(note, false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter") onOpen(note);
    if (e.key === " ") {
      e.preventDefault();
      onSelect(note, e.ctrlKey || e.metaKey);
    }
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: gridcell 需要作为容器承载多行文本与语义状态
    <div
      role="gridcell"
      tabIndex={0}
      aria-selected={selected}
      className={`note-card note-card--${view}${selected ? " note-card--selected" : ""}`}
      data-color={note.color}
      onClick={onClick}
      onDoubleClick={() => onOpen(note)}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(note, e.currentTarget);
      }}
    >
      {selected ? <Icon name="check" className="note-card__check" /> : null}
      <div className="note-card__title">{note.title || t("note.untitled")}</div>
      {view === "grid" ? <div className="note-card__excerpt">{note.excerpt}</div> : null}
      <div className="note-card__meta tabular">
        <span className="note-card__dot" aria-label={colorName} title={colorName} />
        {note.pinned || note.zMode === 1 ? <Icon name="pin" label={t("note.pin")} /> : null}
        {note.isOpen ? <span className="note-card__badge">{t("list.openBadge")}</span> : null}
        <span>{relativeTime(note.updatedAt, t)}</span>
      </div>
    </div>
  );
}
