// 底部操作工具栏（specs/06 §4.1）：object 模式 ◉换色 ⇧置顶 ⋯更多 + 字数；format 模式 ⟨返回 B I U S ☐ ≔ 🔗；
// ≥23.75rem 宽转常驻并并入 Markdown 组（容器查询由 CSS 完成，这里只渲染两组按钮做 crossfade）。

import { IconButton } from "@bianfa/ui";
import type { Editor } from "@tiptap/core";
import { type RefObject, useRef } from "react";
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
  const run = (fn: (e: Editor) => boolean) => () => {
    if (editor) fn(editor);
  };
  const active = (name: string, attrs?: Record<string, unknown>) => editor?.isActive(name, attrs) ?? false;

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
          onClick={run((e) => e.chain().focus().toggleTaskList().run())}
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
          onClick={run((e) => e.chain().focus().toggleBold().run())}
        />
        <IconButton
          icon="italic"
          label={`${t("format.italic")} ${keyCombo({ mod: true, key: "I" })}`}
          pressed={active("italic")}
          onClick={run((e) => e.chain().focus().toggleItalic().run())}
        />
        <IconButton
          icon="underline"
          label={`${t("format.underline")} ${keyCombo({ mod: true, key: "U" })}`}
          pressed={active("underline")}
          onClick={run((e) => e.chain().focus().toggleUnderline().run())}
        />
        <IconButton
          icon="strikethrough"
          label={`${t("format.strike")} ${shortcutLabel("strike")}`}
          pressed={active("strike")}
          onClick={run((e) => e.chain().focus().toggleStrike().run())}
        />
        <IconButton
          icon="list"
          label={t("format.bulletList")}
          pressed={active("bulletList")}
          onClick={run((e) => e.chain().focus().toggleBulletList().run())}
        />
        <IconButton
          icon="list-todo"
          label={`${t("format.taskList")} ${shortcutLabel("taskList")}`}
          pressed={active("taskList")}
          onClick={run((e) => e.chain().focus().toggleTaskList().run())}
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
            onClick={run((e) => e.chain().focus().toggleHeading({ level: 2 }).run())}
          />
          <IconButton
            icon="code"
            label={t("format.codeBlock")}
            pressed={active("codeBlock")}
            onClick={run((e) => e.chain().focus().toggleCodeBlock().run())}
          />
          <IconButton
            icon="quote"
            label={t("format.blockquote")}
            pressed={active("blockquote")}
            onClick={run((e) => e.chain().focus().toggleBlockquote().run())}
          />
        </span>
      </div>
      <span className="note-toolbar__count tabular" aria-live="off">
        {words > 0 ? t("note.charsWords", { chars, words }) : t("note.chars", { count: chars })}
      </span>
    </div>
  );
}
