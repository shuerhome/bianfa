// 客户端中文检索（规格 01 C5 / 02 §6.9）：FTS5 unicode61 + 应用层 bigram shingling。
// 索引列 content_bigram = toBigramShingles(content_text)；查询走 toBigramQuery，返回 null 时走 LIKE。
//
// 规则：
//   - CJK 连续字符切二元组（"买牛奶" → "买牛 牛奶"），孤立的单个 CJK 字原样保留；
//   - 非 CJK 按空白/标点切词，原样保留（unicode61 自己做大小写折叠）；
//   - 输出用单个空格分隔。

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;
const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}_]/u;

type Segment = { kind: "cjk"; chars: string[] } | { kind: "word"; text: string };

function segment(text: string): Segment[] {
  const segments: Segment[] = [];
  let cjk: string[] = [];
  let word = "";
  const flushCjk = () => {
    if (cjk.length > 0) segments.push({ kind: "cjk", chars: cjk });
    cjk = [];
  };
  const flushWord = () => {
    if (word.length > 0) segments.push({ kind: "word", text: word });
    word = "";
  };
  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      flushWord();
      cjk.push(ch);
    } else if (WORD_CHAR_RE.test(ch)) {
      flushCjk();
      word += ch;
    } else {
      flushCjk();
      flushWord();
    }
  }
  flushCjk();
  flushWord();
  return segments;
}

function shingles(chars: readonly string[]): string[] {
  if (chars.length < 2) return [...chars];
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i += 1) out.push(`${chars[i]}${chars[i + 1]}`);
  return out;
}

/** 正文 → 二元组索引串（空格分隔） */
export function toBigramShingles(text: string): string {
  const tokens: string[] = [];
  for (const seg of segment(text)) {
    if (seg.kind === "cjk") tokens.push(...shingles(seg.chars));
    else tokens.push(seg.text);
  }
  return tokens.join(" ");
}

const ftsQuote = (token: string): string => `"${token.replace(/"/g, '""')}"`;

/**
 * 查询词 → FTS5 MATCH 表达式；返回 null 表示该查询应走 `content_text LIKE '%x%' ESCAPE '\'`。
 * - 去空白后只有 1 个字符（任何文字）→ null；
 * - CJK 连续段 → 二元组短语（`"买牛 牛奶"`，保证相邻）；孤立单个 CJK 字 → 前缀项 `"字"*`；
 * - 非 CJK 词 → 前缀项 `"word"*`（边输入边搜）；
 * - 多个段之间为 AND。空查询 → null。
 */
export function toBigramQuery(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.length === 0) return null;
  if ([...trimmed].length === 1) return null;
  const parts: string[] = [];
  for (const seg of segment(trimmed)) {
    if (seg.kind === "cjk") {
      if (seg.chars.length >= 2) parts.push(ftsQuote(shingles(seg.chars).join(" ")));
      else parts.push(`${ftsQuote(seg.chars.join(""))}*`);
    } else {
      parts.push(`${ftsQuote(seg.text)}*`);
    }
  }
  return parts.length > 0 ? parts.join(" AND ") : null;
}

/** LIKE 兜底用：转义 `%`、`_`、`\`，配合 `ESCAPE '\'` */
export function escapeLikePattern(needle: string): string {
  return needle.replace(/[\\%_]/g, "\\$&");
}
