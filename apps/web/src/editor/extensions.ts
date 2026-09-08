// 网页端的 TipTap 扩展表。
//
// 决定 schema 的那一半**必须**从 @bianfa/shared 拿，不能在这里重写一份：
// y-prosemirror 在应用远端更新时会把 schema 不认识的节点**直接删掉**，
// 两端的扩展表一旦漂移，桌面端写的正文在网页端打开一次就会被吃掉一部分，反过来也一样。
// createEditorExtensions 就是那份唯一定义（packages/shared/src/editor/schema.ts）。
//
// 这里只加"协同 + 体验"这一层，都不影响 schema：Collaboration / Placeholder / CharacterCount。
// 图片节点保留 shared 里的定义（正文里存的是 bianfa://att/<id>）。网页端还没有取附件 URL 的
// 通道，也没接节点视图，所以浏览器拿到的就是一个解析不了的 <img src="bianfa://…">。
// 数据不会丢（节点与属性照常存在 CRDT 里，桌面端仍然正常显示），但显示上是个占位——
// 占位样式在 styles/web.css 的 .bf-prose img[src^="bianfa://"]，不写的话是个几乎看不见的碎图标。
import { BODY_FIELD, createEditorExtensions } from "@bianfa/shared";
import { Extension } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import { CharacterCount, Placeholder } from "@tiptap/extensions";
import { Plugin } from "@tiptap/pm/state";
import type * as Y from "yjs";

/** 与桌面端 apps/desktop/src/editor/limits.ts 同一个值 */
const MAX_PASTE_CHARS = 200_000;

/**
 * 粘贴上限。不是体验优化，是保命的：一次超大粘贴会变成一条超过服务端 MAX_MESSAGE_BYTES
 * 的 WebSocket 帧，服务端直接关掉这条连接，而浏览器这边看到的只是"同步停了"。
 * 桌面端早就有这道闸（PasteLimit），网页端漏了它就等于把同一个坑重挖一遍。
 */
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

export interface WebNoteExtensionsOptions {
  doc: Y.Doc;
  undoManager: Y.UndoManager;
  placeholder: string;
  /** 粘贴被拒时提示用户；不给就静默丢弃那次粘贴 */
  onPasteRejected?: () => void;
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
    PasteLimit(options.onPasteRejected ?? (() => undefined)),
  ];
}
