// 网页端的 TipTap 扩展表。
//
// 决定 schema 的那一半**必须**从 @bianfa/shared 拿，不能在这里重写一份：
// y-prosemirror 在应用远端更新时会把 schema 不认识的节点**直接删掉**，
// 两端的扩展表一旦漂移，桌面端写的正文在网页端打开一次就会被吃掉一部分，反过来也一样。
// createEditorExtensions 就是那份唯一定义（packages/shared/src/editor/schema.ts）。
//
// 这里只加"协同 + 体验"这一层，都不影响 schema：Collaboration / Placeholder / CharacterCount。
// 图片节点保留 shared 里的定义（正文里存的是 bianfa://att/<id>），但网页端还没有取附件 URL 的
// 通道，所以暂时不接节点视图——正文里的图片会渲染成一个占位，不会丢数据。
import { BODY_FIELD, createEditorExtensions } from "@bianfa/shared";
import Collaboration from "@tiptap/extension-collaboration";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import type * as Y from "yjs";

export interface WebNoteExtensionsOptions {
  doc: Y.Doc;
  undoManager: Y.UndoManager;
  placeholder: string;
}

export function createWebNoteExtensions(options: WebNoteExtensionsOptions) {
  return [
    ...createEditorExtensions({ collaboration: true }),
    Collaboration.configure({
      document: options.doc,
      // field 不能省：扩展的默认值是 'default'，写错了不会报错，只会把正文写进另一个
      // fragment —— 表现是"我这边看着有内容，别的端全是空白"。
      field: BODY_FIELD,
      yUndoOptions: { undoManager: options.undoManager },
    }),
    Placeholder.configure({
      placeholder: options.placeholder,
      showOnlyCurrent: false,
      showOnlyWhenEditable: true,
    }),
    CharacterCount.configure({ limit: null, mode: "textSize" }),
  ];
}
