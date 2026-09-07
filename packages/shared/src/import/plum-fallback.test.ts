import { describe, expect, it } from "vitest";
import { plainLinesToPmJson } from "../markdown.js";
import { projectNoteDoc } from "../projector.js";
import { type PlumExportNote, plumNoteToNoteDoc } from "./plum.js";

function note(markdown: string): PlumExportNote {
  return {
    external_id: "ext-1",
    text: markdown,
    markdown,
    theme: "Yellow",
    created_at: "2024-01-02T03:04:05Z",
    updated_at: "2024-01-02T03:04:05Z",
    is_open: false,
    window: null,
    import_degraded: false,
    has_ink: false,
    content_source: "Text",
    attachments: [],
  } as unknown as PlumExportNote;
}

const CTRL = String.fromCharCode(1, 2, 7, 27);
const NASTY = [
  "只有一行",
  "\r\n\r\n多空行\r\n\r\n",
  "<u>下划线</u> 与 <script>alert(1)</script> 与 </div>",
  "| a | b |\n|---|---|\n| 1 | 2 |",
  "```\n未闭合代码块",
  "[链接](javascript:alert(1)) 与 ![图](x) 与 <img src=x>",
  `  控制字符${CTRL} 与 \t 制表`,
  "#".repeat(500),
  "- ".repeat(300),
  `${"1. ".repeat(100)}嵌套`,
  "👨‍👩‍👧‍👦 家庭 🇨🇳 旗 ﷽ 长字",
  "a".repeat(50_000),
  "* * *\n---\n___",
  "> 引用\n>> 嵌套引用",
  "\\id=abc123 原版便笺的内部标记 \\b粗体\\b0",
];

// biome-ignore lint/suspicious/noControlCharactersInRegex: 测试里明确剔除控制字符
const STRIP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

describe("plum 导入的容错", () => {
  it("plainLinesToPmJson 永不抛错且逐行保留文字", () => {
    for (const s of NASTY) {
      const pm = plainLinesToPmJson(s);
      expect(pm.type).toBe("doc");
      const text = (pm.content ?? [])
        .map((p) => (p.content ?? []).map((t) => (t as { text?: string }).text ?? "").join(""))
        .join("\n");
      const expected = s.replace(/\r\n?/g, "\n").replace(STRIP, "");
      expect(text).toBe(expected);
    }
  });

  it("plumNoteToNoteDoc 对全部刁钻输入都能得到可投影的 Doc（必要时退化为纯段落）", () => {
    for (const s of NASTY) {
      const r = plumNoteToNoteDoc(note(s), "0192b2c0-0000-7000-8000-000000000001");
      const proj = projectNoteDoc(r.doc);
      expect(typeof proj.contentText).toBe("string");
      if (r.bodyFallback) expect(r.init.ext.import.degraded).toBe(true);
      r.doc.destroy();
    }
  });
});
