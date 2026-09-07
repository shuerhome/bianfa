// 颜色 popover（specs/06 §4.1）：两条色块带（浅色档 / 浓色档，各 2×5 的 28×28 色块）+ 选中打勾，
// 下方一行常驻说明显示「中文名 · 快捷键」——色块带保持干净，同时不违反 WCAG 1.4.1（不只靠颜色传达信息）。
// 每格仍是真正的 <input type="radio">：20 格共用一个 name，方向键能一路走完两档，读屏原生；
// aria-label 保留「名称 + 快捷键」。浓色档的墨灰没有快捷键，说明行只显示名字。
import { NOTE_COLOR_INFO, NOTE_COLOR_TIERS, type NoteColor, noteColorsByTier } from "@bianfa/shared";
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
  const shownInfo = NOTE_COLOR_INFO[shown];
  const shownName = zh ? shownInfo.zh : shownInfo.en;
  const shownKey = shortcutLabel(`color:${shown}`);

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
        className="color-picker"
        aria-label={t("note.colorPicker")}
        onPointerLeave={() => setPreview(null)}
      >
        {NOTE_COLOR_TIERS.map((tier) => (
          // 档位小标题只是视觉分组：每格 radio 的 aria-label 本来就带完整名称，
          // 再让读屏念一遍「浅色 / 浓色」是重复噪音，所以 aria-hidden。
          <div className="color-tier" key={tier}>
            <p className="color-tier__label" aria-hidden="true">
              {t(`color.tier.${tier}`)}
            </p>
            <div className="color-band">
              {noteColorsByTier(tier).map((color) => {
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
                      aria-label={
                        key
                          ? t("color.caption", { name: zh ? info.zh : info.en, key })
                          : zh
                            ? info.zh
                            : info.en
                      }
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
            </div>
          </div>
        ))}
      </fieldset>
      <p className="color-caption" aria-hidden="true">
        {shownName}
        {shownKey ? (
          <>
            {" · "}
            <span className="color-caption__key">{shownKey}</span>
          </>
        ) : null}
        {shown === value ? ` · ${t("color.current")}` : ""}
      </p>
    </Popover>
  );
}
