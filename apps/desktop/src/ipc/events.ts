// Rust → 所有窗口的事件（specs/07 §3）。跨窗口通信只走这里，禁止 BroadcastChannel / localStorage。
import { isTauri } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect } from "react";
import type {
  AuthStatus,
  DbChangedPayload,
  LoginProgressPayload,
  NoteFocusRequestPayload,
  Notice,
  SyncStatusPayload,
  ThemeChangedPayload,
  UpdateAvailablePayload,
} from "./types.js";

export interface EventMap {
  "db:changed": DbChangedPayload;
  "theme-changed": ThemeChangedPayload;
  "auth:changed": AuthStatus;
  "auth:login-progress": LoginProgressPayload;
  "update:available": UpdateAvailablePayload;
  notice: Notice;
  "hotkey:new-note": Record<string, never>;
  "note:focus-request": NoteFocusRequestPayload;
  "sync:status": SyncStatusPayload;
}

export type EventName = keyof EventMap;

const noop: UnlistenFn = () => {};

/** 订阅一个事件；非 Tauri 环境返回 noop（纯浏览器预览不炸） */
export function onEvent<K extends EventName>(name: K, handler: (payload: EventMap[K]) => void): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(noop);
  return listen<EventMap[K]>(name, (e) => handler(e.payload));
}

export const onDbChanged = (h: (p: DbChangedPayload) => void) => onEvent("db:changed", h);
export const onThemeChanged = (h: (p: ThemeChangedPayload) => void) => onEvent("theme-changed", h);
export const onAuthChanged = (h: (p: AuthStatus) => void) => onEvent("auth:changed", h);
export const onLoginProgress = (h: (p: LoginProgressPayload) => void) => onEvent("auth:login-progress", h);
export const onUpdateAvailable = (h: (p: UpdateAvailablePayload) => void) => onEvent("update:available", h);
export const onNotice = (h: (p: Notice) => void) => onEvent("notice", h);
export const onHotkeyNewNote = (h: () => void) => onEvent("hotkey:new-note", () => h());
export const onNoteFocusRequest = (h: (p: NoteFocusRequestPayload) => void) => onEvent("note:focus-request", h);
export const onSyncStatus = (h: (p: SyncStatusPayload) => void) => onEvent("sync:status", h);

/** sync host → 其它窗口（Rust 只转发） */
export function emitSyncStatus(payload: SyncStatusPayload): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  return emit("sync:status", payload);
}

/**
 * React hook：组件生命周期内订阅。handler 变化不重订（用 ref），避免每次渲染 unlisten/listen。
 */
export function useTauriEvent<K extends EventName>(name: K, handler: (payload: EventMap[K]) => void): void {
  const ref = { current: handler };
  ref.current = handler;
  useEffect(() => {
    let unlisten: UnlistenFn = noop;
    let disposed = false;
    onEvent(name, (p) => ref.current(p)).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten();
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: handler 经 ref 读取，只按事件名重订
  }, [name]);
}
