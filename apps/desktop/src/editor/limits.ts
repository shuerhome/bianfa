// 长度限制（specs/02 §4）：>2 万字符顶部提示；>20 万字符拒绝粘贴。
export const WARN_CHARS = 20_000;
export const MAX_PASTE_CHARS = 200_000;

/** 中文按字、英文按词的粗略计数（工具栏「42 字 · 18 词」） */
export function countText(text: string): { chars: number; words: number } {
  const trimmed = text.replace(/\s+/g, "");
  const chars = Array.from(trimmed).length;
  const words = text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  return { chars, words };
}
