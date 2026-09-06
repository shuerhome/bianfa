// 设置读写：即时生效、无保存按钮；行右侧 ✓ 三段动效（specs/06 §4.4）。
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { settingsGet, settingsSet } from "../../ipc/commands.js";
import type { Settings } from "../../ipc/types.js";
import { applySettingsToDocument, DEFAULT_SETTINGS } from "../../lib/bootstrap.js";
import { changeLanguage } from "../../lib/i18n.js";
import { queryKeys } from "../../lib/query.js";

export function useSettings() {
  const client = useQueryClient();
  const q = useQuery({
    queryKey: queryKeys.settings,
    queryFn: settingsGet,
    placeholderData: DEFAULT_SETTINGS,
  });
  const [ackKey, setAckKey] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (patch: Partial<Settings>) => settingsSet(patch),
    onSuccess: async (next, patch) => {
      client.setQueryData(queryKeys.settings, next);
      applySettingsToDocument(next);
      if (patch.language !== undefined) await changeLanguage(next.language);
      const key = Object.keys(patch)[0] ?? null;
      setAckKey(key);
      window.setTimeout(() => setAckKey((k) => (k === key ? null : k)), 600);
    },
  });
  const update = useCallback((patch: Partial<Settings>) => mutation.mutate(patch), [mutation]);
  return { settings: q.data ?? DEFAULT_SETTINGS, update, ackKey, isError: q.isError };
}

export function Ack({ on }: { on: boolean }) {
  return (
    <span className="ack" data-on={on || undefined} aria-hidden="true">
      ✓
    </span>
  );
}
