// 网页端与桌面端的 schema 必须一模一样。
//
// 不一样的后果不是"显示得不好看"，而是**掉数据**：y-prosemirror 在应用远端更新时会把
// schema 里不存在的节点直接删掉。桌面端写的清单在网页端打开一次，清单就没了；反过来也一样。
// 所以决定 schema 的那一半只能来自 @bianfa/shared 的 createEditorExtensions —— 这个测试
// 就是拦住"哪天有人图省事在网页端自己列一份扩展"的那道门。
import { createEditorExtensions, getSchemaV1 } from "@bianfa/shared";
import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createWebNoteExtensions } from "../editor/extensions.js";

function webSchema() {
  const doc = new Y.Doc();
  const extensions = createWebNoteExtensions({
    doc,
    undoManager: new Y.UndoManager(doc.getXmlFragment("body")),
    placeholder: "",
  });
  const schema = getSchema(extensions);
  doc.destroy();
  return schema;
}

describe("网页端编辑器 schema", () => {
  it("节点集合与 shared 的 v1 完全一致", () => {
    const web = Object.keys(webSchema().nodes).sort();
    const shared = Object.keys(getSchemaV1().nodes).sort();
    expect(web).toEqual(shared);
  });

  it("标记集合与 shared 的 v1 完全一致", () => {
    const web = Object.keys(webSchema().marks).sort();
    const shared = Object.keys(getSchemaV1().marks).sort();
    expect(web).toEqual(shared);
  });

  it("taskItem 带 id 属性（服务端的清单投影按这个 id 建行）", () => {
    expect(webSchema().nodes.taskItem?.spec.attrs?.id).toBeDefined();
  });

  it("Collaboration 绑的是 body 这个 fragment，不是默认的 default", () => {
    const doc = new Y.Doc();
    const collab = createWebNoteExtensions({
      doc,
      undoManager: new Y.UndoManager(doc.getXmlFragment("body")),
      placeholder: "",
    }).find((e) => e.name === "collaboration");
    expect((collab?.options as { field?: string } | undefined)?.field).toBe("body");
    doc.destroy();
  });

  it("协同模式下 StarterKit 的撤销重做必须关掉（否则和 Y.UndoManager 打架）", () => {
    const base = createEditorExtensions({ collaboration: true }).find((e) => e.name === "starterKit");
    expect((base?.options as { undoRedo?: unknown } | undefined)?.undoRedo).toBe(false);
  });
});
