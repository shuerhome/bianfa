import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { Icon, type IconName } from "../icons/Icon.js";
import { cx } from "../utils/cx.js";

export interface TabItem<K extends string> {
  key: K;
  label: string;
  icon?: IconName;
}

export interface TabsProps<K extends string> {
  value: K;
  onChange: (key: K) => void;
  items: readonly TabItem<K>[];
  label: string;
  orientation?: "horizontal" | "vertical";
  className?: string;
}

/** WAI-ARIA tabs：roving tabindex，方向键切换（自动激活）。indicator 平移由 CSS 完成。 */
export function Tabs<K extends string>({
  value,
  onChange,
  items,
  label,
  orientation = "horizontal",
  className,
}: TabsProps<K>) {
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const idx = items.findIndex((t) => t.key === value);
    const prev = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
    const next = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
    let target = -1;
    if (e.key === next) target = (idx + 1) % items.length;
    else if (e.key === prev) target = (idx - 1 + items.length) % items.length;
    else if (e.key === "Home") target = 0;
    else if (e.key === "End") target = items.length - 1;
    if (target < 0) return;
    e.preventDefault();
    const item = items[target];
    if (!item) return;
    onChange(item.key);
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus();
  };
  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={label}
      aria-orientation={orientation}
      className={cx("bf-tabs", `bf-tabs--${orientation}`, className)}
      onKeyDown={onKeyDown}
    >
      {items.map((t) => {
        const selected = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`${id}-tab-${t.key}`}
            aria-selected={selected}
            aria-controls={`${id}-panel-${t.key}`}
            tabIndex={selected ? 0 : -1}
            className={cx("bf-tab", selected && "bf-tab--selected")}
            onClick={() => onChange(t.key)}
          >
            {t.icon ? <Icon name={t.icon} /> : null}
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  /** 与 Tabs 的 items.key 一致 */
  tabKey: string;
  active: boolean;
  children: ReactNode;
  className?: string;
}

export function TabPanel({ tabKey, active, children, className }: TabPanelProps) {
  return (
    <div role="tabpanel" aria-label={tabKey} hidden={!active} className={cx("bf-tabpanel", className)}>
      {active ? children : null}
    </div>
  );
}
