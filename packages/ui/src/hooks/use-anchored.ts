import { type RefObject, useLayoutEffect, useState } from "react";

export type Placement = "top" | "bottom" | "left" | "right";

export interface AnchoredStyle {
  position: "fixed";
  top: number;
  left: number;
  maxHeight: number;
  visibility: "visible" | "hidden";
}

const EDGE = 6;

/**
 * 单路径浮层定位（specs/06 §0）：strategy fixed + 翻转 + 边距 6px 内推 + 尺寸 max(160, 可用-12)。
 * 不依赖 Floating UI；resize/scroll 时重算。
 */
export function useAnchored(
  anchor: RefObject<HTMLElement | null>,
  floating: RefObject<HTMLElement | null>,
  open: boolean,
  placement: Placement = "bottom",
  gap = 8,
): AnchoredStyle {
  const [style, setStyle] = useState<AnchoredStyle>({
    position: "fixed",
    top: 0,
    left: 0,
    maxHeight: 0,
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    if (!open) return;
    const compute = () => {
      const a = anchor.current?.getBoundingClientRect();
      const f = floating.current;
      if (!a || !f) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const fw = f.offsetWidth;
      const fh = f.offsetHeight;
      let side = placement;
      const spaceBelow = vh - a.bottom - gap;
      const spaceAbove = a.top - gap;
      if (side === "bottom" && spaceBelow < fh && spaceAbove > spaceBelow) side = "top";
      else if (side === "top" && spaceAbove < fh && spaceBelow > spaceAbove) side = "bottom";
      let top = 0;
      let left = 0;
      if (side === "bottom") {
        top = a.bottom + gap;
        left = a.left;
      } else if (side === "top") {
        top = a.top - gap - fh;
        left = a.left;
      } else if (side === "right") {
        top = a.top;
        left = a.right + gap;
      } else {
        top = a.top;
        left = a.left - gap - fw;
      }
      left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - fw - EDGE));
      top = Math.min(Math.max(EDGE, top), Math.max(EDGE, vh - fh - EDGE));
      const avail = side === "top" ? a.top - gap - EDGE : vh - top - EDGE;
      setStyle({
        position: "fixed",
        top,
        left,
        maxHeight: Math.max(160, avail - 12),
        visibility: "visible",
      });
    };
    compute();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(compute);
    if (ro && floating.current) ro.observe(floating.current);
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open, placement, gap, anchor, floating]);

  return style;
}
