import { type ReactNode, type RefObject, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { type Placement, useAnchored } from "../hooks/use-anchored.js";
import { cx } from "../utils/cx.js";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  placement?: Placement;
  gap?: number;
  /** 传给 role；颜色选择器等用 dialog，菜单用 menu */
  role?: "dialog" | "menu" | "listbox";
  label?: string;
  className?: string;
  /** portal 目标；默认 #float-root（便笺窗）或 body */
  container?: HTMLElement | null;
  /** 打开时是否把焦点移入（默认 true） */
  autoFocus?: boolean;
  children: ReactNode;
}

function portalTarget(container?: HTMLElement | null): HTMLElement {
  return container ?? document.getElementById("float-root") ?? document.body;
}

/**
 * 无头 Popover：fixed 定位、Esc/外点关闭、焦点进出还原。z-index 由 CSS 类决定（--z-menu）。
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  placement = "bottom",
  gap = 8,
  role = "dialog",
  label,
  className,
  container,
  autoFocus = true,
  children,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const style = useAnchored(anchorRef, ref, open, placement, gap);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    if (autoFocus) {
      const first = ref.current?.querySelector<HTMLElement>(
        '[autofocus],button:not([disabled]),[href],input:not([disabled]),[tabindex]:not([tabindex="-1"])',
      );
      (first ?? ref.current)?.focus({ preventScroll: true });
    }
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus({ preventScroll: true });
    };
  }, [open, onClose, anchorRef, autoFocus]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      id={id}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className={cx("bf-popover", className)}
      style={style}
    >
      {children}
    </div>,
    portalTarget(container),
  );
}
