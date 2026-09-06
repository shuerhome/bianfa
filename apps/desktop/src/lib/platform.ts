// 平台分叉只在这里与 src/platform/（specs/06 §0）：键位符号、data-os。
import type { Os } from "../ipc/types.js";

let currentOs: Os = detectOs();

function detectOs(): Os {
  if (typeof navigator === "undefined") return "windows";
  const ua = `${navigator.platform} ${navigator.userAgent}`;
  if (/Mac|iPhone|iPad/i.test(ua)) return "macos";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "windows";
}

export function setOs(os: Os): void {
  currentOs = os;
  document.documentElement.dataset.os = os;
}

export function getOs(): Os {
  return currentOs;
}

export const isMac = (): boolean => currentOs === "macos";

/** 显示用修饰键：⌘ / Ctrl */
export const modLabel = (): string => (isMac() ? "⌘" : "Ctrl");
export const shiftLabel = (): string => (isMac() ? "⇧" : "Shift");
export const altLabel = (): string => (isMac() ? "⌥" : "Alt");

/** 组合键文字：mac 用符号无分隔，Windows 用 + */
export function keyCombo(parts: { mod?: boolean; shift?: boolean; alt?: boolean; key: string }): string {
  if (isMac()) {
    return `${parts.alt ? "⌥" : ""}${parts.shift ? "⇧" : ""}${parts.mod ? "⌘" : ""}${parts.key}`;
  }
  const seq = [];
  if (parts.mod) seq.push("Ctrl");
  if (parts.alt) seq.push("Alt");
  if (parts.shift) seq.push("Shift");
  seq.push(parts.key);
  return seq.join("+");
}
