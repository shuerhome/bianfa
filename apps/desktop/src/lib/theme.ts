// 主题 / 便笺色 / 缩放 / 动效档位应用到 <html>（specs/06 §8、§2 缩放、§5 reduced-motion）。
import type { NoteColor } from "@bianfa/shared";
import { isNoteColor } from "@bianfa/shared";
import type { ContentDensity, ThemeSetting, UiScale } from "../ipc/types.js";

const SWITCH_ATTR = "data-theme-switching";
let switchTimer: number | null = null;

/** 用户三档：跟随系统 → 无属性；浅色/深色 → data-theme */
export function applyThemeSetting(setting: ThemeSetting, root: HTMLElement = document.documentElement): void {
  if (setting === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", setting);
}

/** Rust theme-changed：同一 rAF 改属性 + 200ms 禁 transition */
export function onSystemThemeChanged(
  setting: ThemeSetting,
  root: HTMLElement = document.documentElement,
): void {
  root.setAttribute(SWITCH_ATTR, "");
  const apply = () => applyThemeSetting(setting, root);
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(apply);
  else apply();
  if (switchTimer !== null) window.clearTimeout(switchTimer);
  switchTimer = window.setTimeout(() => root.removeAttribute(SWITCH_ATTR), 200);
}

/** 便笺色写在容器上（L3 --note-* 由 tokens.css 的 [data-color] 派生）；未知色按 graphite */
export function applyNoteColor(el: HTMLElement, color: string): NoteColor {
  const safe: NoteColor = isNoteColor(color) ? color : "graphite";
  el.setAttribute("data-color", safe);
  return safe;
}

export function applyUiScale(scale: UiScale, root: HTMLElement = document.documentElement): void {
  root.style.setProperty("--ui-scale", String(scale / 100));
}

/**
 * 正文紧凑度：只在根元素上打一个 data-density，具体的行距/段距由 prose.css 里的
 * --prose-lh / --prose-gap 决定。放在 documentElement 上是为了让便笺窗口、列表预览、
 * 设置页的预览块自动一致——它们都在各自的 document 里，但都走同一套 .bf-prose。
 */
export function applyContentDensity(
  density: ContentDensity,
  root: HTMLElement = document.documentElement,
): void {
  root.setAttribute("data-density", density);
}

export type MotionSetting = "system" | "full" | "reduce";
export function applyMotion(motion: MotionSetting, root: HTMLElement = document.documentElement): void {
  if (motion === "system") root.removeAttribute("data-motion");
  else root.setAttribute("data-motion", motion);
}

export function applyReduceTransparency(on: boolean, root: HTMLElement = document.documentElement): void {
  if (on) root.setAttribute("data-reduce-transparency", "1");
  else root.removeAttribute("data-reduce-transparency");
}

export function applyColorPatterns(on: boolean, root: HTMLElement = document.documentElement): void {
  if (on) root.setAttribute("data-color-patterns", "1");
  else root.removeAttribute("data-color-patterns");
}

/** 用户是否偏好减少动效（系统或设置） */
export function motionOK(root: HTMLElement = document.documentElement): boolean {
  const setting = root.getAttribute("data-motion");
  if (setting === "reduce") return false;
  if (setting === "full") return true;
  return typeof matchMedia === "function" ? !matchMedia("(prefers-reduced-motion: reduce)").matches : true;
}
