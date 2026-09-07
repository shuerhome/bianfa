// 侧栏「待办」角标：todos_counts.open；key 在 ["notes", …] 下，db:changed → useDbInvalidation 失效后自动刷新。
import { useTranslation } from "react-i18next";
import { useTodoCounts } from "./todos-data.js";

export function TodosBadge() {
  const { t } = useTranslation();
  const counts = useTodoCounts();
  const open = counts.data?.open ?? 0;
  if (open <= 0) return null;
  return (
    <span className="todos-badge tabular">
      <span aria-hidden="true">{open > 999 ? "999+" : open}</span>
      <span className="bf-sr-only">{t("todos.badge", { count: open })}</span>
    </span>
  );
}
