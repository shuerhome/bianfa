import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createNoteDoc, encodeStateV2, getBody, Origins, openNoteDoc, readMeta } from "./doc.js";
import {
  ensureTaskItemIds,
  excerptFromText,
  type PMJson,
  projectNoteDoc,
  projectPmJson,
  prosemirrorJsonToNoteDoc,
  setBodyFromPmJson,
  titleFromText,
} from "./projector.js";

const p = (text: string): PMJson => ({ type: "paragraph", content: [{ type: "text", text }] });

const richDoc: PMJson = {
  type: "doc",
  content: [
    p("周三 14:00 产品评审"),
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "议题" }] },
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false, id: "aaaaaaaaaa" },
          content: [p("确认 OKLCH 色板 🎉")],
        },
        {
          type: "taskItem",
          attrs: { checked: true, id: "bbbbbbbbbb" },
          content: [
            p("补 macOS 验证"),
            {
              type: "taskList",
              content: [
                { type: "taskItem", attrs: { checked: false, id: "cccccccccc" }, content: [p("子项")] },
              ],
            },
          ],
        },
      ],
    },
    { type: "image", attrs: { attachmentId: "att-1", w: 100, h: 50, blurhash: null, alt: "截图" } },
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [p("一")] },
        { type: "listItem", content: [p("二")] },
      ],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "line1" }, { type: "hardBreak" }, { type: "text", text: "line2" }],
    },
    { type: "image", attrs: { attachmentId: "att-1", w: null, h: null, blurhash: null, alt: null } },
    { type: "image", attrs: { attachmentId: "att-2", w: null, h: null, blurhash: null, alt: null } },
    { type: "codeBlock", attrs: { language: null }, content: [{ type: "text", text: "a\nb" }] },
    { type: "blockquote", content: [p("引用")] },
    { type: "horizontalRule" },
  ],
};

describe("projector", () => {
  it("flattens text with task prefixes, image as empty line and \\n between blocks", () => {
    const body = projectPmJson(richDoc);
    expect(body.contentText).toBe(
      [
        "周三 14:00 产品评审",
        "议题",
        "[ ] 确认 OKLCH 色板 🎉",
        "[x] 补 macOS 验证",
        "[ ] 子项",
        "",
        "一",
        "二",
        "line1\nline2",
        "",
        "",
        "a\nb",
        "引用",
        "",
      ].join("\n"),
    );
    expect(body.checklistItems).toEqual([
      { blockId: "aaaaaaaaaa", text: "确认 OKLCH 色板 🎉", checked: false, ordinal: 0 },
      { blockId: "bbbbbbbbbb", text: "补 macOS 验证", checked: true, ordinal: 1 },
      { blockId: "cccccccccc", text: "子项", checked: false, ordinal: 2 },
    ]);
    expect(body.attachmentIds).toEqual(["att-1", "att-2"]);
  });

  it("titleFromText takes the first line up to 120 code points; excerpt takes the rest", () => {
    expect(titleFromText("周三 14:00 产品评审\n确认")).toBe("周三 14:00 产品评审");
    expect(titleFromText("")).toBe("");
    expect(titleFromText("\n第二行")).toBe("");
    const emoji = "🎉".repeat(130);
    expect(Array.from(titleFromText(emoji))).toHaveLength(120);
    expect(excerptFromText("标题\n第二行  \n\n第三行")).toBe("第二行 第三行");
    expect(excerptFromText("只有标题")).toBe("");
  });

  it("projectNoteDoc reads body + meta from a Y.Doc and survives an updateV2 round trip", () => {
    const doc = prosemirrorJsonToNoteDoc(
      richDoc,
      { noteId: "note-1", meta: { color: "amber", zMode: 1, createdAt: 5, updatedAt: 6 } },
      Origins.import,
    );
    expect(doc.guid).toBe("note-1");
    const projection = projectNoteDoc(doc);
    expect(projection.meta).toEqual({
      color: "amber",
      zMode: 1,
      createdAt: 5,
      updatedAt: 6,
      deletedAt: null,
      schemaVersion: 1,
    });
    expect(projection.contentText.startsWith("周三 14:00 产品评审\n议题\n[ ] 确认")).toBe(true);
    expect(projection.attachmentIds).toEqual(["att-1", "att-2"]);
    expect(projection.checklistItems.map((c) => c.blockId)).toEqual([
      "aaaaaaaaaa",
      "bbbbbbbbbb",
      "cccccccccc",
    ]);
    expect(projection.content.type).toBe("doc");
    expect(projection.content.content?.[0]).toEqual(p("周三 14:00 产品评审"));
    expect(projection.content.content?.[3]).toEqual({
      type: "image",
      attrs: { attachmentId: "att-1", w: 100, h: 50, blurhash: null, alt: "截图" },
    });

    const replica = openNoteDoc("note-1", [encodeStateV2(doc)]);
    expect(projectNoteDoc(replica)).toEqual(projection);
  });

  it("projects an empty doc to the DB default shape", () => {
    const doc = createNoteDoc("note-2", { now: 1 });
    const projection = projectNoteDoc(doc);
    expect(projection.content).toEqual({ type: "doc", content: [] });
    expect(projection.contentText).toBe("");
    expect(projection.checklistItems).toEqual([]);
    expect(projection.attachmentIds).toEqual([]);
    expect(projection.meta.createdAt).toBe(1);
    const bare = new Y.Doc({ guid: "note-3" });
    expect(projectNoteDoc(bare).contentText).toBe("");
    expect(readMeta(bare).color).toBe("graphite");
  });

  it("fills missing taskItem ids with nanoid(10) and keeps existing ones", () => {
    const json: PMJson = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: false }, content: [p("a")] },
            { type: "taskItem", attrs: { checked: true, id: "keepme1234" }, content: [p("b")] },
          ],
        },
      ],
    };
    const withIds = ensureTaskItemIds(json);
    const items = withIds.content?.[0]?.content ?? [];
    expect(items[0]?.attrs?.id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(items[1]?.attrs?.id).toBe("keepme1234");
    expect(json.content?.[0]?.content?.[0]?.attrs?.id).toBeUndefined();

    const doc = prosemirrorJsonToNoteDoc(json, { noteId: "note-4" });
    const ids = projectNoteDoc(doc).checklistItems.map((c) => c.blockId);
    expect(ids[1]).toBe("keepme1234");
    expect(ids[0]).toMatch(/^[A-Za-z0-9_-]{10}$/);
  });

  it("skips duplicate or missing task ids in checklist projection", () => {
    const doc = createNoteDoc("note-5");
    const fragment = getBody(doc);
    doc.transact(() => {
      const list = new Y.XmlElement("taskList");
      const mk = (id: string | null, text: string) => {
        const item = new Y.XmlElement("taskItem");
        item.setAttribute("checked", false as never);
        if (id) item.setAttribute("id", id);
        const para = new Y.XmlElement("paragraph");
        para.insert(0, [new Y.XmlText(text)]);
        item.insert(0, [para]);
        return item;
      };
      list.insert(0, [mk("dup", "a"), mk("dup", "b"), mk(null, "c")]);
      fragment.insert(0, [list]);
    }, Origins.local);
    const projection = projectNoteDoc(doc);
    expect(projection.contentText).toBe("[ ] a\n[ ] b\n[ ] c");
    expect(projection.checklistItems).toEqual([{ blockId: "dup", text: "a", checked: false, ordinal: 0 }]);
  });

  it("setBodyFromPmJson replaces the body in one transaction and rejects invalid JSON", () => {
    const doc = prosemirronJsonDoc();
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tr) => origins.push(tr.origin));
    setBodyFromPmJson(doc, { type: "doc", content: [p("新正文")] }, Origins.import);
    expect(origins).toEqual([Origins.import]);
    expect(projectNoteDoc(doc).contentText).toBe("新正文");
    expect(() =>
      setBodyFromPmJson(doc, { type: "doc", content: [{ type: "listItem", content: [p("x")] }] }),
    ).toThrow();
    expect(() => setBodyFromPmJson(doc, { type: "doc", content: [{ type: "mention" }] })).toThrow();
    expect(projectNoteDoc(doc).contentText).toBe("新正文");
  });
});

function prosemirronJsonDoc(): Y.Doc {
  return prosemirrorJsonToNoteDoc({ type: "doc", content: [p("旧正文"), p("第二段")] }, { noteId: "note-6" });
}
