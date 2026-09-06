import { type KeyboardEvent, type ReactNode, type RefObject, useCallback, useRef } from "react";
import { Icon, type IconName } from "../icons/Icon.js";
import { cx } from "../utils/cx.js";
import { Popover } from "./popover.js";

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  placement?: "top" | "bottom" | "left" | "right";
  className?: string;
  container?: HTMLElement | null;
  children: ReactNode;
}

const ITEM_SELECTOR = '[role="menuitem"]:not([aria-disabled="true"])';

/** 更多菜单（specs/06 §4.1）：↑↓ Home End + 首字母跳转；Esc 关闭并还原焦点 */
export function Menu({ open, onClose, anchorRef, label, placement = "bottom", className, container, children }: MenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);
      if (items.length === 0) return;
      const idx = items.findIndex((el) => el === document.activeElement);
      const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusAt(idx + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusAt(idx - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        focusAt(0);
      } else if (e.key === "End") {
        e.preventDefault();
        focusAt(items.length - 1);
      } else if (e.key === "Tab") {
        onClose();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ch = e.key.toLowerCase();
        const order = [...items.slice(idx + 1), ...items.slice(0, idx + 1)];
        const hit = order.find((el) => (el.textContent ?? "").trim().toLowerCase().startsWith(ch));
        hit?.focus();
      }
    },
    [onClose],
  );

  return (
    <Popover
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      placement={placement}
      role="menu"
      label={label}
      className={cx("bf-menu", className)}
      container={container ?? null}
    >
      <div ref={listRef} onKeyDown={onKeyDown} className="bf-menu__list">
        {children}
      </div>
    </Popover>
  );
}

export interface MenuItemProps {
  icon?: IconName;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  onSelect: () => void;
  children: ReactNode;
}

export function MenuItem({ icon, shortcut, danger, disabled, checked, onSelect, children }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cx("bf-menu__item", danger && "bf-menu__item--danger")}
      aria-disabled={disabled || undefined}
      aria-checked={checked === undefined ? undefined : checked}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect();
      }}
    >
      {icon ? <Icon name={icon} /> : <span className="bf-menu__icon-slot" aria-hidden="true" />}
      <span className="bf-menu__label">{children}</span>
      {shortcut ? <kbd className="bf-menu__kbd">{shortcut}</kbd> : null}
      {checked ? <Icon name="check" /> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="bf-menu__sep" />;
}
