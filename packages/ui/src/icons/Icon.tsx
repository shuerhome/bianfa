import type { SVGAttributes } from "react";
import { ICON_PATHS, type IconName } from "./sprite.generated.js";

export type { IconName };
export { ICON_NAMES, ICON_PATHS } from "./sprite.generated.js";

const SPRITE_ID = "bf-icon-sprite";

/** 一次性把全部 <symbol> 注入文档；<Icon> 用 <use href="#i-name">。多次调用无副作用。 */
export function ensureIconSprite(doc: Document = document): void {
  if (doc.getElementById(SPRITE_ID)) return;
  const symbols = Object.entries(ICON_PATHS)
    .map(([name, inner]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${inner}</symbol>`)
    .join("");
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("id", SPRITE_ID);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
  svg.innerHTML = symbols;
  doc.body.prepend(svg);
}

export interface IconProps extends Omit<SVGAttributes<SVGSVGElement>, "name" | "children"> {
  name: IconName;
  /** 有 label 时图标自带可读名，否则 aria-hidden */
  label?: string;
  size?: number;
}

/** Lucide 图标：16px、stroke 1.5、currentColor。首次渲染前需调用 ensureIconSprite()。 */
export function Icon({ name, label, size = 16, className, ...rest }: IconProps) {
  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `bf-icon ${className}` : "bf-icon"}
      focusable="false"
      {...a11y}
      {...rest}
    >
      {label ? <title>{label}</title> : null}
      <use href={`#i-${name}`} />
    </svg>
  );
}
