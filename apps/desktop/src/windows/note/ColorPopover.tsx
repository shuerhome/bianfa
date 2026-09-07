// 颜色 popover（specs/06 §4.1）：一条横向色块带（两行五列，28×28）+ 选中打勾，
// 下方一行常驻说明显示「中文名 · 快捷键」——色块带保持干净，同时不违反 WCAG 1.4.1（不只靠颜色传达信息）。
// 每格仍是真正的 <input type="radio">：方向键切换、读屏原生；aria-label 保留「名称 + 快捷键」。
import { NOTE_COLOR_INFO, NOTE_COLORS, type NoteColor } from "@bianfa/shared";
import { Popover } from "@bianfa/ui";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
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
  const name = useId();
  const [preview, setPreview] = useState<NoteColor | null>(null);
  const selectedRef = useRef<HTMLInputElement>(null);

  // 打开时把焦点放在当前色上（Popover 自带的 autoFocus 只会抓第一格；
  // React 不会把 autoFocus 渲染成属性，所以自己来），方向键才从当前色开始走。
  useEffect(() => {
    if (open) selectedRef.current?.focus({ preventScroll: true });
  }, [open]);

  const shown = preview ?? value;
  const shownName = zh ? NOTE_COLOR_INFO[shown].zh : NOTE_COLOR_INFO[shown].en;

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      placement="bottom"
      label={t("note.colorPicker")}
      className="color-popover"
      autoFocus={false}
    >
      <fieldset
        className="color-band"
        aria-label={t("note.colorPicker")}
        onPointerLeave={() => setPreview(null)}
      >
        {NOTE_COLORS.map((color) => {
          const info = NOTE_COLOR_INFO[color];
          const selected = color === value;
          const key = shortcutLabel(`color:${color}`);
          return (
            <label
              key={color}
              className={selected ? "color-swatch color-swatch--selected" : "color-swatch"}
              data-color={color}
              onPointerEnter={() => setPreview(color)}
            >
              <input
                ref={selected ? selectedRef : undefined}
                type="radio"
                name={name}
                className="bf-sr-only"
                checked={selected}
                aria-label={t("color.caption", { name: zh ? info.zh : info.en, key })}
                onFocus={() => setPreview(color)}
                onBlur={() => setPreview(null)}
                onChange={() => {
                  onChange(color);
                  onClose();
                }}
              />
              {selected ? (
                <svg
                  className="color-swatch__check"
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  aria-hidden="true"
                >
                  <path
                    d="M2.5 7.5l3 3 6-6.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : null}
            </label>
          );
        })}
      </fieldset>
      <p className="color-caption" aria-hidden="true">
        {shownName} · <span className="color-caption__key">{shortcutLabel(`color:${shown}`)}</span>
        {shown === value ? ` · ${t("color.current")}` : ""}
      </p>
    </Popover>
  );
}
