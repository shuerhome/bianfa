// 便笺工具栏的格式按钮（specs/06 §4.1）。
//
// 钉的是两件线上真出过问题的事：
//   ① 按钮不能吃掉编辑器的焦点 —— 普通 <button> 在 mousedown 时会把焦点从
//      contenteditable 挪走，DOM 选区随之清空，等 click 里再 .focus() 已经晚了，
//      命令作用在一个塌缩的选区上。表现就是「选中一段字点加粗，什么都没发生」。
//   ② 按钮状态要跟着编辑器变 —— pressed 原来是在 render 里直接读 editor.isActive()，
//      而这个组件只在 note-store 变化时重渲染，于是 B / I / U 永远不亮。
//
// 说清楚这个用例**验不到**的部分：jsdom 不实现「mousedown 默认把焦点移到按钮」这个
// 浏览器行为，所以它无法复现 ① 的故障本身，只能钉住修复的那个性质
// （mousedown 被 preventDefault）。真正的验证只能在打包后的应用里做。

import { createEditorExtensions } from "@bianfa/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import zh from "../i18n/zh-Hans.json";
import { useNoteStore } from "../windows/note/note-store.js";
import { Toolbar } from "../windows/note/Toolbar.js";

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: "zh-Hans",
    resources: { "zh-Hans": { translation: zh } },
    interpolation: { escapeValue: false },
  });
});

let editor: Editor | null = null;
afterEach(() => {
  // 这个项目没开 testing-library 的自动 cleanup：不手动清，上一个用例渲染的按钮会留在
  // document 里，下一个用例按名字找就会撞上「找到多个」。
  cleanup();
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

function mountEditor(html: string): Editor {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new Editor({
    element: host,
    extensions: createEditorExtensions({ collaboration: false }),
    content: html,
  });
}

function renderToolbar(ed: Editor) {
  useNoteStore.getState().set({ toolbarMode: "format", toolbarVisible: true });
  return render(
    <Toolbar
      editor={ed}
      colorButtonRef={{ current: null }}
      onColorClick={() => undefined}
      onTogglePin={() => undefined}
      onMoreClick={() => undefined}
      onInsertLink={() => undefined}
    />,
  );
}

/** 格式那一排里真正的加粗按钮（收起那排还有一个同样是 B 图标的「格式」入口） */
const boldButton = () => screen.getByRole("button", { name: /粗体/ });

describe("便笺工具栏的格式按钮", () => {
  it("选中文字点加粗，正文真的变粗", () => {
    editor = mountEditor("<p>你好世界</p>");
    editor.commands.setTextSelection({ from: 1, to: 5 });
    renderToolbar(editor);

    expect(editor.isActive("bold")).toBe(false);
    fireEvent.click(boldButton());
    expect(editor.getHTML()).toContain("<strong>");
    expect(editor.isActive("bold")).toBe(true);
  });

  it("mousedown 被吃掉：焦点不离开编辑器，选区才不会在点按钮时丢掉", () => {
    editor = mountEditor("<p>你好世界</p>");
    editor.commands.setTextSelection({ from: 1, to: 5 });
    renderToolbar(editor);

    // cancelable 的 mousedown 必须被 preventDefault —— 这正是「选中一段字点加粗
    // 却没反应」的根因。jsdom 不会真的挪焦点，所以这里只能钉住这个性质本身。
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    boldButton().dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("按钮的按下态跟着编辑器走（原来它从来不刷新）", () => {
    editor = mountEditor("<p>你好世界</p>");
    editor.commands.setTextSelection({ from: 1, to: 5 });
    renderToolbar(editor);

    expect(boldButton().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(boldButton());
    // 组件必须因为编辑器的 transaction 重渲染，否则这里永远是 false
    expect(boldButton().getAttribute("aria-pressed")).toBe("true");
  });
});
