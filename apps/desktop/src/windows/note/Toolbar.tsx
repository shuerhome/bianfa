// 底部操作工具栏（specs/06 §4.1）：object 模式 ◉换色 ⇧置顶 ⋯更多 + 字数；format 模式 ⟨返回 B I U S ☐ ≔ 🔗；
// ≥23.75rem 宽转常驻并并入 Markdown 组（容器查询由 CSS 完成，这里只渲染两组按钮做 crossfade）。

import { IconButton } from "@bianfa/ui";
import type { Editor } from "@tiptap/core";
import { type MouseEvent, type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { keyCombo } from "../../lib/platform.js";
import { shortcutLabel } from "../../lib/shortcuts.js";
import { useNoteStore } from "./note-store.js";

export interface ToolbarProps {
  editor: Editor | null;
  colorButtonRef: RefObject<HTMLButtonElement | null>;
  onColorClick: () => void;
  onTogglePin: () => void;
  onMoreClick: (anchor: HTMLElement) => void;
  onInsertLink: () => void;
}

export function Toolbar({
  editor,
  colorButtonRef,
  onColorClick,
  onTogglePin,
  onMoreClick,
  onInsertLink,
}: ToolbarProps) {
  const { t } = useTranslation();
  const { toolbarMode, toolbarVisible, chars, words, zMode, set } = useNoteStore();
  const moreRef = useRef<HTMLButtonElement>(null);
  // 编辑器状态的快照。工具栏原来是在 render 里直接读 editor.isActive(...)，而这个组件
  // 只在 note-store 变化时才重渲染 —— 编辑器里的选区和标记怎么变，按钮都不会重新求值。
  // 结果是 B / I / U 永远不亮：光标处于加粗状态也看不出来，点一下（尤其是没选中文字、
  // 只是设了 storedMark 的时候）界面上更是一点反应都没有。
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const onChange = () => setTick((n) => n + 1);
    // selectionUpdate 覆盖「移动光标」，transaction 覆盖「切换标记」——后者在光标不动时
    // 不会触发 selectionUpdate（storedMarks 的变化只体现在 transaction 上）。
    editor.on("selectionUpdate", onChange);
    editor.on("transaction", onChange);
    return () => {
      editor.off("selectionUpdate", onChange);
      editor.off("transaction", onChange);
    };
  }, [editor]);

  /**
   * 工具栏按钮必须吃掉 mousedown 的默认行为。
   *
   * 不吃的话，按下的瞬间浏览器会把焦点从 contenteditable 挪到按钮上，编辑器随之失焦、
   * DOM 选区被清掉；等 click 事件里再 .focus() 已经晚了，命令作用在一个已经塌缩的
   * 选区上——表现就是「选中一段文字点加粗，什么都没发生」。
   * preventDefault 让焦点压根不离开编辑器，选区原封不动。
   */
  const cmd = (fn: (e: Editor) => boolean) => ({
    onMouseDown: (ev: MouseEvent) => ev.preventDefault(),
    onClick: () => {
      if (editor) fn(editor);
    },
  });
  // tick 本身没有意义，它的作用只是让上面的订阅能把这次渲染顶出来；
  // 真正读的是 editor 的当前状态。写进依赖里是为了让人一眼看出两者的关系。
  const active = (name: string, attrs?: Record<string, unknown>) =>
    tick >= 0 && editor ? editor.isActive(name, attrs) : false;

  return (
    <div
      className={`note-toolbar${toolbarVisible ? " note-toolbar--visible" : ""}`}
      data-mode={toolbarMode}
      role="toolbar"
      aria-label={t("note.toolbar")}
    >
      <div className="note-toolbar__group note-toolbar__group--object" aria-hidden={toolbarMode !== "object"}>
        <IconButton
          ref={colorButtonRef}
          icon="palette"
          label={t("note.changeColor")}
          onClick={onColorClick}
        />
        <IconButton icon="pin" label={t("note.pin")} pressed={zMode === 1} onClick={onTogglePin} />
        <IconButton
          icon="list-checks"
          label={`${t("format.taskList")} ${shortcutLabel("taskList")}`}
          pressed={active("taskList")}
          {...cmd((e) => e.chain().focus().toggleTaskList().run())}
        />
        <IconButton
          icon="bold"
          label={`${t("format.moreFormats")} ${shortcutLabel("formatFocus")}`}
          onClick={() => set({ toolbarMode: "format" })}
        />
        <IconButton
          ref={moreRef}
          icon="ellipsis"
          label={t("note.more")}
          onClick={() => moreRef.current && onMoreClick(moreRef.current)}
        />
      </div>
      <div className="note-toolbar__group note-toolbar__group--format" aria-hidden={toolbarMode !== "format"}>
        <IconButton
          icon="arrow-left"
          label={t("common.back")}
          onClick={() => set({ toolbarMode: "object" })}
        />
        <IconButton
          icon="bold"
          label={`${t("format.bold")} ${keyCombo({ mod: true, key: "B" })}`}
          pressed={active("bold")}
          {...cmd((e) => e.chain().focus().toggleBold().run())}
        />
        <IconButton
          icon="italic"
          label={`${t("format.italic")} ${keyCombo({ mod: true, key: "I" })}`}
          pressed={active("italic")}
          {...cmd((e) => e.chain().focus().toggleItalic().run())}
        />
        <IconButton
          icon="underline"
          label={`${t("format.underline")} ${keyCombo({ mod: true, key: "U" })}`}
          pressed={active("underline")}
          {...cmd((e) => e.chain().focus().toggleUnderline().run())}
        />
        <IconButton
          icon="strikethrough"
          label={`${t("format.strike")} ${shortcutLabel("strike")}`}
          pressed={active("strike")}
          {...cmd((e) => e.chain().focus().toggleStrike().run())}
        />
        <IconButton
          icon="list"
          label={t("format.bulletList")}
          pressed={active("bulletList")}
          {...cmd((e) => e.chain().focus().toggleBulletList().run())}
        />
        <IconButton
          icon="list-todo"
          label={`${t("format.taskList")} ${shortcutLabel("taskList")}`}
          pressed={active("taskList")}
          {...cmd((e) => e.chain().focus().toggleTaskList().run())}
        />
        <IconButton
          icon="link"
          label={`${t("format.link")} ${shortcutLabel("link")}`}
          pressed={active("link")}
          onClick={onInsertLink}
        />
        <span className="note-toolbar__md">
          <IconButton
            icon="heading"
            label={t("format.heading")}
            pressed={active("heading", { level: 2 })}
            {...cmd((e) => e.chain().focus().toggleHeading({ level: 2 }).run())}
          />
          <IconButton
            icon="code"
            label={t("format.codeBlock")}
            pressed={active("codeBlock")}
            {...cmd((e) => e.chain().focus().toggleCodeBlock().run())}
          />
          <IconButton
            icon="quote"
            label={t("format.blockquote")}
            pressed={active("blockquote")}
            {...cmd((e) => e.chain().focus().toggleBlockquote().run())}
          />
        </span>
      </div>
      <span className="note-toolbar__count tabular" aria-live="off">
        {words > 0 ? t("note.charsWords", { chars, words }) : t("note.chars", { count: chars })}
      </span>
    </div>
  );
}
