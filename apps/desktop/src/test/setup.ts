// 测试环境：mock @tauri-apps/api（invoke / event），并把 window.__TAURI_INTERNALS__ 置上让 isTauri() 为 true。
import { vi } from "vitest";

type Handler = (args: Record<string, unknown>) => unknown;
const handlers = new Map<string, Handler>();

export const invokeMock = vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
  const h = handlers.get(cmd);
  if (!h) throw { code: "command_not_found", message: `mock: ${cmd} 未注册` };
  return h(args);
});

export function mockCommand(cmd: string, handler: Handler): void {
  handlers.set(cmd, handler);
}

export function resetCommands(): void {
  handlers.clear();
  invokeMock.mockClear();
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args ?? {}),
  isTauri: () => true,
  convertFileSrc: (p: string) => p,
}));

const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>();
export function emitTestEvent(name: string, payload: unknown): void {
  for (const l of listeners.get(name) ?? []) l({ payload });
}

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (e: { payload: unknown }) => void) => {
    const set = listeners.get(name) ?? new Set();
    set.add(handler);
    listeners.set(name, set);
    return () => set.delete(handler);
  },
  once: async () => () => {},
  emit: async () => {},
  emitTo: async () => {},
}));

Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
if (!("ResizeObserver" in window)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, "ResizeObserver", { value: RO, configurable: true });
}
