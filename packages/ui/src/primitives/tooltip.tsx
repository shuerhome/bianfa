import { cloneElement, type ReactElement, type Ref, useCallback, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Placement, useAnchored } from "../hooks/use-anchored.js";

export interface TooltipProps {
  content: string;
  placement?: Placement;
  /** 触发器必须能接收 ref 与 aria-describedby（按钮/图标按钮） */
  children: ReactElement<{
    ref?: Ref<HTMLElement>;
    "aria-describedby"?: string;
    onPointerEnter?: (e: unknown) => void;
    onPointerLeave?: (e: unknown) => void;
    onFocus?: (e: unknown) => void;
    onBlur?: (e: unknown) => void;
  }>;
  /** 进 500ms / 出 100ms（--delay-tooltip-*） */
  delayIn?: number;
  delayOut?: number;
}

/** 悬停 + 焦点触发、延迟显示；role=tooltip 由 aria-describedby 关联；hover-only UI 同时绑焦点 */
export function Tooltip({ content, placement = "top", children, delayIn = 500, delayOut = 100 }: TooltipProps) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);
  const id = useId();
  const style = useAnchored(anchorRef, tipRef, open, placement, 6);

  const schedule = useCallback((next: boolean, delay: number) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(next), delay);
  }, []);

  const child = cloneElement(children, {
    ref: (el: HTMLElement | null) => {
      anchorRef.current = el;
    },
    "aria-describedby": open ? id : undefined,
    onPointerEnter: (e: unknown) => {
      children.props.onPointerEnter?.(e);
      schedule(true, delayIn);
    },
    onPointerLeave: (e: unknown) => {
      children.props.onPointerLeave?.(e);
      schedule(false, delayOut);
    },
    onFocus: (e: unknown) => {
      children.props.onFocus?.(e);
      schedule(true, 0);
    },
    onBlur: (e: unknown) => {
      children.props.onBlur?.(e);
      schedule(false, 0);
    },
  });

  return (
    <>
      {child}
      {open
        ? createPortal(
            <div ref={tipRef} id={id} role="tooltip" className="bf-tooltip" style={style}>
              {content}
            </div>,
            document.getElementById("float-root") ?? document.body,
          )
        : null}
    </>
  );
}
