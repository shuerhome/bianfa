// 搜索前缀语法（specs/02 §6.9、06 §4.3）：`is:pinned` `is:trashed` `色:柠檬` / `color:citron` → filters；余下走 bigram。
import { noteColorByName, toBigramQuery } from "@bianfa/shared";
import type { SearchFilters } from "../ipc/types.js";

export interface ParsedQuery {
  /** 去掉前缀后的正文查询 */
  text: string;
  filters: SearchFilters;
  /** FTS5 MATCH 表达式；null → LIKE 路径 */
  bigramQuery: string | null;
}

export function parseSearchQuery(raw: string): ParsedQuery {
  const filters: SearchFilters = {};
  const rest: string[] = [];
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(is|色|color|颜色)[:：](.+)$/u.exec(token);
    if (!m || !m[1] || !m[2]) {
      rest.push(token);
      continue;
    }
    const [, prefix, value] = m;
    if (prefix === "is") {
      if (value === "pinned") filters.pinned = true;
      else if (value === "trashed") filters.trashed = true;
      else rest.push(token);
      continue;
    }
    const color = noteColorByName(value);
    if (color) filters.color = color;
    else rest.push(token);
  }
  const text = rest.join(" ");
  return { text, filters, bigramQuery: toBigramQuery(text) };
}
