import { describe, expect, it } from "vitest";
import { escapeBlockSyntaxLine } from "./editor/block-escape.js";
import { inlineLinesToPmJson, markdownToPmJson, pmJsonToMarkdown } from "./markdown.js";
import { EMPTY_PM_DOC, type PMJson, projectPmJson } from "./projector.js";

const roundTrip = (md: string): string => pmJsonToMarkdown(markdownToPmJson(md));

describe("markdown", () => {
  it("round-trips the export subset including Chinese and emoji", () => {
    const md = [
      "# 标题 🎉",
      "",
      "周三 14:00 **产品评审** *斜体* <u>下划线</u> ~~删除~~ `code`",
      "",
      "- 一",
      "- 二",
      "",
      "1. x",
      "2. y",
      "",
      "- [ ] 待办 🎉",
      "- [x] 完成",
      "  - [ ] 子项",
      "",
      "> 引用",
      "",
      "```js",
      "const a = 1;",
      "```",
      "",
      "---",
      "",
      "line1  ",
      "line2",
      "",
      "[链接](https://example.com)",
      "",
      "![图](bianfa://att/att-1)",
      "",
      "结尾",
    ].join("\n");
    const json = markdownToPmJson(md);
    expect(pmJsonToMarkdown(json)).toBe(md);
    expect(roundTrip(pmJsonToMarkdown(json))).toBe(md);
    expect(json.content?.map((n) => n.type)).toEqual([
      "heading",
      "paragraph",
      "bulletList",
      "orderedList",
      "taskList",
      "blockquote",
      "codeBlock",
      "horizontalRule",
      "paragraph",
      "paragraph",
      "image",
      "paragraph",
    ]);
    expect(json.content?.[1]?.content?.map((n) => n.marks?.[0]?.type)).toEqual([
      undefined,
      "bold",
      undefined,
      "italic",
      undefined,
      "underline",
      undefined,
      "strike",
      undefined,
      "code",
    ]);
    expect(json.content?.[10]).toEqual({
      type: "image",
      attrs: { attachmentId: "att-1", w: null, h: null, blurhash: null, alt: "图" },
    });
    expect(projectPmJson(json).contentText).toContain("[ ] 待办 🎉\n[x] 完成\n[ ] 子项");
  });

  it("uses attachmentPath for image export and resolveImage for import", () => {
    const json: PMJson = {
      type: "doc",
      content: [
        { type: "image", attrs: { attachmentId: "att-1", w: 1, h: 1, blurhash: "x", alt: "封面 [1]" } },
        { type: "paragraph", content: [{ type: "text", text: "后文" }] },
      ],
    };
    expect(pmJsonToMarkdown(json)).toBe("![封面 \\[1\\]](bianfa://att/att-1)\n\n后文");
    expect(pmJsonToMarkdown(json, { attachmentPath: (id) => `attachments/${id}.webp` })).toBe(
      "![封面 \\[1\\]](attachments/att-1.webp)\n\n后文",
    );
    const imported = markdownToPmJson("![封面](attachments/deadbeef.webp)", {
      resolveImage: (src) => /^attachments\/([0-9a-f]+)\./.exec(src)?.[1] ?? null,
    });
    expect(imported.content?.[0]).toEqual({
      type: "image",
      attrs: { attachmentId: "deadbeef", w: null, h: null, blurhash: null, alt: "封面" },
    });
    // unknown image sources degrade to literal text instead of dangling attachments
    const literal = markdownToPmJson("看 ![x](https://foo/x.png) 这个");
    expect(literal.content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "看 ![x](https://foo/x.png) 这个" }] },
    ]);
    // an inline image between text is lifted to a block
    const lifted = markdownToPmJson("前 ![图](bianfa://att/a) 后");
    expect(lifted.content?.map((n) => n.type)).toEqual(["paragraph", "image", "paragraph"]);
    expect(lifted.content?.[2]?.content?.[0]?.text).toBe("后");
  });

  it("escapes paragraphs that would otherwise turn into block syntax", () => {
    const paragraphs: PMJson = {
      type: "doc",
      content: ["- 不是列表", "1. 不是序号", "# 不是标题", "> 不是引用", "---", "#tag *强调* -1 度"].map(
        (text) => ({
          type: "paragraph",
          content: [{ type: "text", text }],
        }),
      ),
    };
    const md = pmJsonToMarkdown(paragraphs);
    // Tiptap 自己会把行内 `*` 转义、`>` 编码成实体；行首块级语法由我们的 Paragraph 覆盖转义
    expect(md).toBe(
      [
        "\\- 不是列表",
        "1\\. 不是序号",
        "\\# 不是标题",
        "&gt; 不是引用",
        "\\---",
        "#tag \\*强调\\* -1 度",
      ].join("\n\n"),
    );
    const back = markdownToPmJson(md);
    expect(back.content?.map((n) => n.type)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
    expect(projectPmJson(back).contentText).toBe(
      "- 不是列表\n1. 不是序号\n# 不是标题\n> 不是引用\n---\n#tag *强调* -1 度",
    );
    expect(escapeBlockSyntaxLine("*斜体* 开头")).toBe("*斜体* 开头");
    expect(escapeBlockSyntaxLine("* 列表")).toBe("\\* 列表");
    expect(escapeBlockSyntaxLine("```")).toBe("\\```");
    expect(escapeBlockSyntaxLine("===")).toBe("\\===");
    expect(escapeBlockSyntaxLine("2) x")).toBe("2\\) x");
    expect(escapeBlockSyntaxLine("2)x")).toBe("2)x");
  });

  it("keeps empty paragraphs and handles empty documents", () => {
    expect(pmJsonToMarkdown(EMPTY_PM_DOC)).toBe("");
    expect(markdownToPmJson("")).toEqual({ type: "doc", content: [] });
    expect(markdownToPmJson("   \n\n")).toEqual({ type: "doc", content: [] });
    const withGap: PMJson = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "a" }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "b" }] },
      ],
    };
    const md = pmJsonToMarkdown(withGap);
    expect(markdownToPmJson(md).content?.map((n) => n.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
  });

  it("inlineLinesToPmJson makes one paragraph per line and never creates blocks", () => {
    const json = inlineLinesToPmJson(
      "周三 14:00 **产品评审**\n\n- 买菜\n1. 序号\n# 标题\n    缩进 <u>u</u>\r\n~~已买~~牛奶",
    );
    expect(json.content?.map((n) => n.type)).toEqual(Array(7).fill("paragraph"));
    expect(projectPmJson(json).contentText).toBe(
      "周三 14:00 产品评审\n\n- 买菜\n1. 序号\n# 标题\n缩进 u\n已买牛奶",
    );
    expect(json.content?.[0]?.content?.[1]).toEqual({
      type: "text",
      text: "产品评审",
      marks: [{ type: "bold" }],
    });
    expect(json.content?.[5]?.content?.[1]).toEqual({
      type: "text",
      text: "u",
      marks: [{ type: "underline" }],
    });
    expect(json.content?.[6]?.content?.[0]).toEqual({
      type: "text",
      text: "已买",
      marks: [{ type: "strike" }],
    });
  });
});
