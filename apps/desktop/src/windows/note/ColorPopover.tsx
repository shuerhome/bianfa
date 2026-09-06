// 颜色 popover（specs/06 §4.1）：两列五行，20px 色点 + 名称（常驻文字，WCAG 1.4.1）+ 右对齐快捷键。
import { NOTE_COLOR_INFO, NOTE_COLORS, type NoteColor } from "@bianfa/shared";
import { Popover } from "@bianfa/ui";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { shortcutLabel } from "../../lib/shortcuts.js";

export interface ColorPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  value: NoteColor;
  onChange: (color: NoteColor) => void;
}

export function ColorPopover({ open, onClose, anchorRef, value, onChange }: ColorPopoverProps) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} placement="bottom" label={t("note.colorPicker")}>
      <div className="color-grid" role="radiogroup" aria-label={t("note.colorPicker")}>
        {NOTE_COLORS.map((color) => {
          const info = NOTE_COLOR_INFO[color];
          const selected = color === value;
          return (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={selected}
              className={selected ? "color-item color-item--selected" : "color-item"}
              data-color={color}
              onClick={() => {
                onChange(color);
                onClose();
              }}
            >
              <span className="color-item__dot" aria-hidden="true" />
              <span className="color-item__name">{zh ? info.zh : info.en}</span>
              <kbd className="color-item__kbd">{shortcutLabel(`color:${color}`)}</kbd>
            </button>
          );
        })}
      </div>
    </Popover>
  );
}
