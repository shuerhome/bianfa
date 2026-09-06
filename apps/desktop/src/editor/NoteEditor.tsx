// 两级编辑器的「上级」：聚焦后动态 import 挂载（specs/05 §9.2）。IME：compositionstart/end 挂起远端应用与落盘检查点。
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useRef } from "react";
import type { NoteSession } from "../lib/doc-store.js";
import { filesFromDataTransfer, importImageFiles, pickImageFiles } from "./attachments.js";
import { createNoteExtensions } from "./extensions.js";

export interface NoteEditorProps {
  session: NoteSession;
  placeholder: string;
  editable?: boolean;
  autoFocus?: boolean;
  onReady?: (editor: Editor) => void;
  onPasteRejected: () => void;
  onAttachmentFailures: (failures: string[]) => void;
  onSelectionChange?: (hasSelection: boolean) => void;
}

export default function NoteEditor({
  session,
  placeholder,
  editable = true,
  autoFocus = true,
  onReady,
  onPasteRejected,
  onAttachmentFailures,
  onSelectionChange,
}: NoteEditorProps) {
  const failuresRef = useRef(onAttachmentFailures);
  failuresRef.current = onAttachmentFailures;
  const selectionRef = useRef(onSelectionChange);
  selectionRef.current = onSelectionChange;

  const editor = useEditor(
    {
      extensions: createNoteExtensions({
        doc: session.doc,
        undoManager: session.undoManager,
        placeholder,
        onPasteRejected,
      }),
      editable,
      autofocus: autoFocus ? "end" : false,
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      editorProps: {
        attributes: { class: "note-editor", role: "textbox", "aria-multiline": "true" },
        handlePaste: (_view, event) => {
          const files = filesFromDataTransfer(event.clipboardData);
          const { ok, failures } = pickImageFiles(files);
          if (ok.length === 0 && failures.length === 0) return false;
          event.preventDefault();
          if (failures.length > 0) failuresRef.current(failures);
          return true;
        },
        handleDrop: (_view, event) => {
          const files = filesFromDataTransfer(event.dataTransfer);
          const { ok, failures } = pickImageFiles(files);
          if (ok.length === 0 && failures.length === 0) return false;
          event.preventDefault();
          if (failures.length > 0) failuresRef.current(failures);
          return true;
        },
      },
      onSelectionUpdate: ({ editor: ed }) => {
        selectionRef.current?.(!ed.state.selection.empty);
      },
    },
    [session],
  );

  // 图片粘贴/拖入需要 editor 实例，handlePaste 里拿不到 React 闭包 → 在 DOM 层再监听一次做实际导入
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onFiles = (dt: DataTransfer | null) => {
      const { ok } = pickImageFiles(filesFromDataTransfer(dt));
      if (ok.length === 0) return;
      void importImageFiles(editor, session.noteId, ok).then((r) => {
        if (r.failures.length > 0) failuresRef.current(r.failures);
      });
    };
    const onPaste = (e: ClipboardEvent) => onFiles(e.clipboardData);
    const onDrop = (e: DragEvent) => onFiles(e.dataTransfer);
    const onCompStart = () => session.setComposing(true);
    const onCompEnd = () => session.setComposing(false);
    dom.addEventListener("paste", onPaste);
    dom.addEventListener("drop", onDrop);
    dom.addEventListener("compositionstart", onCompStart);
    dom.addEventListener("compositionend", onCompEnd);
    onReady?.(editor);
    return () => {
      dom.removeEventListener("paste", onPaste);
      dom.removeEventListener("drop", onDrop);
      dom.removeEventListener("compositionstart", onCompStart);
      dom.removeEventListener("compositionend", onCompEnd);
      session.setComposing(false);
    };
  }, [editor, session, onReady]);

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  return <EditorContent editor={editor} className="note-editor-host" />;
}
