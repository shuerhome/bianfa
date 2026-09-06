// 极小的 pathname 路由（无 hash、无外部依赖）：matchRoute 纯函数 + useLocation（popstate / navigate 订阅）。
// 路由清单必须与 apps/server/src/http/web-static.ts 的 WEB_PAGE_PATHS 一致（服务端只对这些路径回 index.html）。
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "login" }
  | { name: "signup" }
  | { name: "forgot-password" }
  | { name: "reset-password" }
  | { name: "verify-email"; kind: "verify" | "change" }
  | { name: "consent" }
  | { name: "device" }
  | { name: "invite"; token: string }
  | { name: "account" }
  | { name: "not-found" };

export function matchRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, "") || "/";
  switch (path) {
    case "/":
      return { name: "home" };
    case "/login":
      return { name: "login" };
    case "/signup":
      return { name: "signup" };
    case "/forgot-password":
      return { name: "forgot-password" };
    case "/reset-password":
      return { name: "reset-password" };
    case "/verify-email":
      return { name: "verify-email", kind: "verify" };
    case "/change-email":
      return { name: "verify-email", kind: "change" };
    case "/consent":
      return { name: "consent" };
    case "/device":
      return { name: "device" };
    case "/account":
      return { name: "account" };
    default: {
      const m = /^\/invite\/([A-Za-z0-9_-]{1,128})$/.exec(path);
      if (m?.[1]) return { name: "invite", token: m[1] };
      return { name: "not-found" };
    }
  }
}

export interface Location {
  pathname: string;
  search: string;
}

const listeners = new Set<() => void>();
let cached: Location = readLocation();

function readLocation(): Location {
  if (typeof window === "undefined") return { pathname: "/", search: "" };
  return { pathname: window.location.pathname, search: window.location.search };
}

function refresh(): void {
  const next = readLocation();
  if (next.pathname !== cached.pathname || next.search !== cached.search) cached = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") window.addEventListener("popstate", refresh);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined")
      window.removeEventListener("popstate", refresh);
  };
}

function snapshot(): Location {
  const now = readLocation();
  if (now.pathname !== cached.pathname || now.search !== cached.search) cached = now;
  return cached;
}

export function useLocation(): Location {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 站内跳转（pushState）；replace 用于登录后回跳等不该留在历史里的步骤 */
export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  refresh();
}

/**
 * `next` 参数只接受站内绝对路径：以单个 "/" 开头、不含协议 / 反斜杠 / 控制字符。
 * 其余一律丢弃（开放重定向防线）。
 */
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要拒绝控制字符
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  if (raw.length > 2048) return null;
  return raw;
}

export function queryOf(search: string): URLSearchParams {
  return new URLSearchParams(search);
}
