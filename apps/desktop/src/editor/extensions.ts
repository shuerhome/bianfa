// 便笺编辑器扩展集：@bianfa/shared schema v1（协同模式）+ Collaboration(field 'body') + Placeholder + 字数 +
// 删除线键位覆盖（Win Ctrl+T / mac ⌘⇧X）+ 粘贴上限 + 远端高亮 + image 节点视图。
import { BODY_FIELD, createEditorExtensions, createImageExtension } from "@bianfa/shared";
import { Extension } from "@tiptap/core";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import { Plugin } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";
import type * as Y from "yjs";
import { isMac } from "../lib/platform.js";
import { ImageView } from "./ImageView.js";
import { MAX_PASTE_CHARS } from "./limits.js";
import { RemoteHighlight } from "./remote-highlight.js";

export interface NoteExtensionsOptions {
  doc: Y.Doc;
  undoManager: Y.UndoManager;
  placeholder: string;
  /** 粘贴超过 20 万字符被拒绝时回调 */
  onPasteRejected: () => void;
}

const StrikeShortcut = Extension.create({
  name: "bfStrikeShortcut",
  addKeyboardShortcuts() {
    const combo = isMac() ? "Mod-Shift-x" : "Mod-t";
    return { [combo]: () => this.editor.commands.toggleStrike() };
  },
});

const PasteLimit = (onRejected: () => void) =>
  Extension.create({
    name: "bfPasteLimit",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          props: {
            handlePaste(_view, event) {
              const text = event.clipboardData?.getData("text/plain") ?? "";
              if (text.length > MAX_PASTE_CHARS) {
                onRejected();
                return true;
              }
              return false;
            },
          },
        }),
      ];
    },
  });

export function createNoteExtensions(options: NoteExtensionsOptions) {
  const base = createEditorExtensions({ collaboration: true }).filter((ext) => ext.name !== "image");
  const ImageWithView = createImageExtension().extend({
    addNodeView() {
      return ReactNodeViewRenderer(ImageView);
    },
  });
  return [
    ...base,
    ImageWithView,
    Collaboration.configure({
      document: options.doc,
      field: BODY_FIELD,
      yUndoOptions: { undoManager: options.undoManager },
    }),
    Placeholder.configure({
      placeholder: options.placeholder,
      showOnlyCurrent: false,
      showOnlyWhenEditable: true,
    }),
    CharacterCount.configure({ limit: null, mode: "textSize" }),
    StrikeShortcut,
    PasteLimit(options.onPasteRejected),
    RemoteHighlight,
  ];
}
