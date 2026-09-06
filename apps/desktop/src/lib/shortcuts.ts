// 应用内快捷键终表（specs/05 §8，18-裁决7）。全局热键 Ctrl+Alt+N/⌥⌘N 在 Rust 侧，这里不注册。
// 原则：handler 首行 IME 守卫；单一 capture-phase 监听承载 preventDefault；编辑类用 key、导航类用 code。

import { NOTE_COLORS, type NoteColor } from "@bianfa/shared";
import { useEffect, useRef } from "react";
import { isMac, keyCombo } from "./platform.js";

export type ShortcutAction =
  | "newNote"
  | "closeNote"
  | "deleteNote"
  | "togglePin"
  | "uiScaleUp"
  | "uiScaleDown"
  | "uiScaleReset"
  | "commandPalette"
  | "find"
  | "formatFocus"
  | "strike"
  | "link"
  | "taskList"
  | "save"
  | "undo"
  | "redo"
  | "openList"
  | "settings"
  | "cycleNotes"
  | "help"
  | `color:${NoteColor}`;

export interface ShortcutEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

const isDigitCode = (code: string): number | null => {
  const m = /^Digit(\d)$/.exec(code);
  return m?.[1] ? Number(m[1]) : null;
};

/** 把键盘事件映射为动作；不匹配 → null。mac 用 ⌘（metaKey），Windows 用 Ctrl。 */
export function matchShortcut(e: ShortcutEvent, mac: boolean = isMac()): ShortcutAction | null {
  if (e.isComposing || e.keyCode === 229) return null;
  const mod = mac ? e.metaKey : e.ctrlKey;
  const otherMod = mac ? e.ctrlKey : e.metaKey;
  if (otherMod) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (mod && !e.altKey) {
    const digit = isDigitCode(e.code);
    if (digit !== null) {
      if (e.shiftKey && digit === 0) return "color:graphite";
      if (!e.shiftKey && digit === 0) return "uiScaleReset";
      if (!e.shiftKey && digit >= 1 && digit <= 9) {
        const color = NOTE_COLORS[digit];
        return color ? `color:${color}` : null;
      }
      return null;
    }
    if (e.shiftKey) {
      if (key === "k") return "link";
      if (key === "l") return "taskList";
      if (key === "z") return "redo";
      if (key === "o") return "openList";
      if (key === "x" && mac) return "strike";
      if (e.key === "Delete" || e.key === "Backspace") return "deleteNote";
      return null;
    }
    switch (key) {
      case "n":
        return "newNote";
      case "w":
        return "closeNote";
      case "p":
        return "togglePin";
      case "k":
        return "commandPalette";
      case "f":
        return "find";
      case "e":
        return "formatFocus";
      case "s":
        return "save";
      case "z":
        return "undo";
      case "y":
        return mac ? null : "redo";
      case "t":
        return mac ? null : "strike";
      case ",":
        return "settings";
      case "=":
      case "+":
        return "uiScaleUp";
      case "-":
        return "uiScaleDown";
      default:
        return null;
    }
  }
  if (!mod && !e.altKey && !e.shiftKey && e.key === "F1") return "help";
  if (mac ? e.ctrlKey && !e.metaKey : e.ctrlKey) {
    if (e.key === "Tab") return "cycleNotes";
  }
  return null;
}

/** 显示用键位文字（颜色 popover / 菜单 / 设置） */
export function shortcutLabel(action: ShortcutAction): string {
  if (action.startsWith("color:")) {
    const color = action.slice(6) as NoteColor;
    const idx = NOTE_COLORS.indexOf(color);
    if (idx === 0) return keyCombo({ mod: true, shift: true, key: "0" });
    return keyCombo({ mod: true, key: String(idx) });
  }
  switch (action) {
    case "newNote":
      return keyCombo({ mod: true, key: "N" });
    case "closeNote":
      return keyCombo({ mod: true, key: "W" });
    case "deleteNote":
      return keyCombo({ mod: true, shift: true, key: isMac() ? "⌫" : "Delete" });
    case "togglePin":
      return keyCombo({ mod: true, key: "P" });
    case "uiScaleUp":
      return keyCombo({ mod: true, key: "=" });
    case "uiScaleDown":
      return keyCombo({ mod: true, key: "-" });
    case "uiScaleReset":
      return keyCombo({ mod: true, key: "0" });
    case "commandPalette":
      return keyCombo({ mod: true, key: "K" });
    case "find":
      return keyCombo({ mod: true, key: "F" });
    case "formatFocus":
      return keyCombo({ mod: true, key: "E" });
    case "strike":
      return isMac() ? keyCombo({ mod: true, shift: true, key: "X" }) : keyCombo({ mod: true, key: "T" });
    case "link":
      return keyCombo({ mod: true, shift: true, key: "K" });
    case "taskList":
      return keyCombo({ mod: true, shift: true, key: "L" });
    case "save":
      return keyCombo({ mod: true, key: "S" });
    case "undo":
      return keyCombo({ mod: true, key: "Z" });
    case "redo":
      return isMac() ? keyCombo({ mod: true, shift: true, key: "Z" }) : keyCombo({ mod: true, key: "Y" });
    case "openList":
      return keyCombo({ mod: true, shift: true, key: "O" });
    case "settings":
      return keyCombo({ mod: true, key: "," });
    case "cycleNotes":
      return isMac() ? "⌃Tab" : "Ctrl+Tab";
    case "help":
      return "F1";
    default:
      return "";
  }
}

/** 全局热键的展示（Rust 注册；这里只显示） */
export const globalNewNoteLabel = (): string => (isMac() ? "⌥⌘N" : "Ctrl+Alt+N");

/** 返回 true 表示已处理（preventDefault + stopPropagation） */
export type ShortcutHandler = (action: ShortcutAction, event: KeyboardEvent) => boolean | undefined;

/** capture 阶段单一监听；mac 上顺带拦 ⌘P/⌘R/⌘0/⌘±/⌘[/⌘]（浏览器加速键） */
export function useHotkeys(handler: ShortcutHandler, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const action = matchShortcut(e);
      if (action) {
        const handled = ref.current(action, e);
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }
      if (isMac() && e.metaKey && !e.ctrlKey && ["r", "[", "]"].includes(e.key.toLowerCase()))
        e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}
