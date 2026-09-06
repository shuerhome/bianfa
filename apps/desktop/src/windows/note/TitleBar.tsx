// 顶栏（specs/06 §4.1）：色点 · 拖动区 · meta · ⊙置顶 · ⋯更多 · 同步点 · ✕。
// 拖拽 = pointerdown + 3px 阈值 → window_start_drag；双击折叠；平台分叉（mac 左缘关闭点）在 src/platform。
import { IconButton } from "@bianfa/ui";
import { NOTE_COLOR_INFO } from "@bianfa/shared";
import { type PointerEvent as ReactPointerEvent, type RefObject, useRef } from "react";
import { useTranslation } from "react-i18next";
import { windowStartDrag } from "../../ipc/commands.js";
import { isMac } from "../../lib/platform.js";
import { shortcutLabel } from "../../lib/shortcuts.js";
import { clockTime } from "../../lib/time.js";
import { SyncDot } from "./SyncDot.js";
import { useNoteStore } from "./note-store.js";

export interface TitleBarProps {
  title: string;
  updatedAt: number;
  chars: number;
  colorButtonRef: RefObject<HTMLButtonElement | null>;
  moreButtonRef: RefObject<HTMLButtonElement | null>;
  onColorClick: () => void;
  onMoreClick: () => void;
  onTogglePin: () => void;
  onClose: () => void;
  onToggleCollapse: () => void;
  onSyncClick: () => void;
}

const DRAG_THRESHOLD = 3;
const INTERACTIVE = "button,input,[contenteditable],a,select,textarea";

export function TitleBar(p: TitleBarProps) {
  const { t, i18n } = useTranslation();
  const { color, zMode, collapsed, syncState } = useNoteStore();
  const start = useRef<{ x: number; y: number } | null>(null);
  const mac = isMac();
  const zh = i18n.language.startsWith("zh");

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(INTERACTIVE)) return;
    start.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    if (Math.abs(e.clientX - s.x) >= DRAG_THRESHOLD || Math.abs(e.clientY - s.y) >= DRAG_THRESHOLD) {
      start.current = null;
      void windowStartDrag().catch(() => undefined);
    }
  };
  const onPointerUp = () => {
    start.current = null;
  };

  const colorName = zh ? NOTE_COLOR_INFO[color].zh : NOTE_COLOR_INFO[color].en;
  const pinLabel = zMode === 1 ? t("note.unpin") : t("note.pin");

  const colorDot = (
    <button
      ref={p.colorButtonRef}
      type="button"
      className="note-dot"
      aria-label={t("note.colorLabel", { name: colorName })}
      title={t("note.colorLabel", { name: colorName })}
      onClick={p.onColorClick}
    />
  );

  return (
    <div
      className="note-titlebar"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest(INTERACTIVE)) p.onToggleCollapse();
      }}
    >
      {mac ? (
        <button
          type="button"
          className="note-close note-close--mac"
          aria-label={t("note.close")}
          title={`${t("note.close")} ${shortcutLabel("closeNote")}`}
          onClick={p.onClose}
        />
      ) : (
        colorDot
      )}
      <div className="note-titlebar__drag">
        {collapsed ? <span className="note-titlebar__title">{p.title || t("note.untitled")}</span> : null}
      </div>
      <span className="note-meta tabular">
        {clockTime(p.updatedAt)} · {t("note.chars", { count: p.chars })}
      </span>
      <div className="note-titlebar__actions">
        {mac ? colorDot : null}
        <IconButton
          icon="pin"
          label={`${pinLabel} ${shortcutLabel("togglePin")}`}
          pressed={zMode === 1}
          className={zMode === 1 ? "note-pin note-pin--on" : "note-pin"}
          onClick={p.onTogglePin}
        />
        <IconButton ref={p.moreButtonRef} icon="ellipsis" label={t("note.more")} onClick={p.onMoreClick} />
      </div>
      <SyncDot state={syncState} onClick={p.onSyncClick} />
      {mac ? null : (
        <button
          type="button"
          className="note-close note-close--win"
          aria-label={t("note.close")}
          title={`${t("note.close")} ${shortcutLabel("closeNote")}`}
          onClick={p.onClose}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        </button>
      )}
    </div>
  );
}
