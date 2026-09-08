// 加粗这条链，用**应用里真正的那套扩展**（createNoteExtensions，协同模式）验一遍。
//
// 为什么单独一个文件、而不是并进 note-toolbar.test.tsx：那边验的是工具栏按钮怎么调命令，
// 用的是 createEditorExtensions({collaboration:false})；这边验的是「便笺窗口实际加载的
// 那一套扩展里，加粗到底还在不在」——两者的扩展集不同，前者绿不代表后者绿。
//
// 这三条是在排查「点加粗 / Ctrl+B / 输入 **x** 全都看不出变化」时写的，用来把
// 「扩展或命令坏了」和「渲染出来不粗」这两种可能分开。三条全绿 = 标记确实进了 DOM，
// 那么现象只能出在 CSS/字体那一侧（见 prose.css 里 strong 的字重规则与
// base.css 的 `* { font-synthesis-weight: none }`）。

import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createNoteExtensions } from "../editor/extensions.js";

function realEditor() {
  const doc = new Y.Doc();
  const undoManager = new Y.UndoManager(doc.getXmlFragment("body"), {});
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new Editor({
    element: host,
    extensions: createNoteExtensions({
      doc,
      undoManager,
      placeholder: "写点什么",
      onPasteRejected: () => undefined,
    }),
  });
}

describe("真实扩展集下的加粗", () => {
  it("schema 里有 bold 标记", () => {
    const e = realEditor();
    expect(Object.keys(e.schema.marks)).toContain("bold");
    e.destroy();
  });

  it("toggleBold 产出 <strong>", () => {
    const e = realEditor();
    e.commands.insertContent("你好世界");
    e.commands.setTextSelection({ from: 1, to: 5 });
    e.commands.toggleBold();
    expect(e.getHTML()).toContain("<strong>");
    e.destroy();
  });

  it("markdown 输入规则：**x** 会变成 <strong>", () => {
    const e = realEditor();
    e.commands.insertContent("**粗**");
    // 输入规则只在「逐字输入」时触发，insertContent 不走 handleTextInput。
    // 这里手工触发最后一个字符的输入，等价于用户敲下那个 *。
    const { view } = e;
    const to = view.state.selection.from;
    e.commands.setTextSelection({ from: to - 1, to });
    e.commands.deleteSelection();
    const pos = view.state.selection.from;
    // prosemirror-view 1.42 的 handleTextInput 第 5 个参数是「默认行为」的兜底事务构造器；
    // 输入规则用不到它，但签名要求给。
    const deflt = () => view.state.tr.insertText("*", pos, pos);
    view.someProp("handleTextInput", (f) => f(view, pos, pos, "*", deflt));
    expect(e.getHTML()).toContain("<strong>");
    e.destroy();
  });
});
