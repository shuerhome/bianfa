import { type ReactNode, useEffect, useId, useRef } from "react";
import { IconButton } from "./button.js";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** 宽度：默认 480（导入向导）；冲突比较 560 */
  width?: number;
  /** 初始焦点落哪：默认第一个 [data-autofocus] 或第一个可聚焦元素（删除确认应把它放在「取消」上） */
  children: ReactNode;
  footer?: ReactNode;
  /** 关闭按钮的可读名（i18n 由调用方传） */
  closeLabel?: string;
  className?: string;
}

/**
 * 原生 <dialog> + showModal()：焦点陷阱、Esc、inert 背景由浏览器提供；scrim 用 ::backdrop 走 --c-scrim。
 * 关闭后焦点还原到打开前元素。
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  width = 480,
  children,
  footer,
  closeLabel = "关闭",
  className,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      const previouslyFocused = document.activeElement as HTMLElement | null;
      el.showModal();
      const target =
        el.querySelector<HTMLElement>("[data-autofocus]") ??
        el.querySelector<HTMLElement>('button:not([disabled]),[href],input:not([disabled]),[tabindex="0"]');
      target?.focus({ preventScroll: true });
      return () => {
        if (el.open) el.close();
        if (previouslyFocused && document.contains(previouslyFocused))
          previouslyFocused.focus({ preventScroll: true });
      };
    }
    if (!open && el.open) el.close();
    return undefined;
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={className ? `bf-dialog ${className}` : "bf-dialog"}
      style={{ width, maxWidth: "calc(100vw - 32px)" }}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <div className="bf-dialog__panel">
        <header className="bf-dialog__header">
          <h2 id={titleId} className="bf-dialog__title">
            {title}
          </h2>
          <IconButton icon="x" label={closeLabel} size="sm" onClick={onClose} />
        </header>
        {description ? (
          <p id={descId} className="bf-dialog__desc">
            {description}
          </p>
        ) : null}
        <div className="bf-dialog__body">{children}</div>
        {footer ? <footer className="bf-dialog__footer">{footer}</footer> : null}
      </div>
    </dialog>
  );
}
