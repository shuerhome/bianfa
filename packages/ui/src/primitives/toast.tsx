import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Icon } from "../icons/Icon.js";
import { cx } from "../utils/cx.js";
import { Button } from "./button.js";

export interface ToastOptions {
  message: string;
  kind?: "info" | "success" | "warning" | "danger";
  /** 带撤销时默认 8s，否则 4s */
  action?: { label: string; onClick: () => void };
  durationMs?: number;
}

interface ToastEntry extends ToastOptions {
  id: number;
}

interface ToastApi {
  toast: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const MAX_VISIBLE = 3;

/** 同屏 ≤3、默认 4s、带撤销 8s；入场 translateY(8px)→0（CSS）；容器 .bottom-dock 由调用方摆放 */
export function ToastProvider({ children, closeLabel = "关闭" }: { children: ReactNode; closeLabel?: string }) {
  const [items, setItems] = useState<ToastEntry[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t !== undefined) window.clearTimeout(t);
    timers.current.delete(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const toast = useCallback(
    (options: ToastOptions) => {
      seq.current += 1;
      const id = seq.current;
      const duration = options.durationMs ?? (options.action ? 8000 : 4000);
      setItems((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), { ...options, id }]);
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), duration),
      );
      return id;
    },
    [dismiss],
  );

  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="bf-toast-viewport" aria-live="polite" aria-relevant="additions">
        {items.map((t) => (
          <output key={t.id} className={cx("bf-toast", `bf-toast--${t.kind ?? "info"}`)} aria-atomic="true">
            <Icon
              name={
                t.kind === "success"
                  ? "check"
                  : t.kind === "warning"
                    ? "triangle-alert"
                    : t.kind === "danger"
                      ? "circle-alert"
                      : "info"
              }
            />
            <span className="bf-toast__msg">{t.message}</span>
            {t.action ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </Button>
            ) : null}
            <button type="button" className="bf-toast__close" aria-label={closeLabel} onClick={() => dismiss(t.id)}>
              <Icon name="x" />
            </button>
          </output>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast 必须在 <ToastProvider> 内使用");
  return ctx;
}
