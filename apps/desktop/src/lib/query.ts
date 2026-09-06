// TanStack Query：每窗一份缓存（specs/05 §1.2）；跨窗失效只靠 db:changed 事件触发 invalidate。
import { QueryClient } from "@tanstack/react-query";
import { isIpcError } from "../ipc/errors.js";

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: (count, error) => {
          // 非 Tauri 环境 / 找不到 command 重试没意义
          if (isIpcError(error) && (error.code === "no_tauri" || error.code === "command_not_found"))
            return false;
          return count < 1;
        },
      },
      mutations: { retry: 0 },
    },
  });
}

export const queryKeys = {
  notes: (filter: string) => ["notes", filter] as const,
  search: (q: string, filter: string) => ["notes", "search", filter, q] as const,
  note: (id: string) => ["note", id] as const,
  settings: ["settings"] as const,
  appInfo: ["appInfo"] as const,
  auth: ["auth"] as const,
  importScan: ["import", "scan"] as const,
  syncErrors: ["sync", "errors"] as const,
  pendingSync: ["sync", "pending"] as const,
  teamNotes: (orgId: string) => ["team", orgId, "notes"] as const,
};
