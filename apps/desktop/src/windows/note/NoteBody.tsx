// 正文两级：未聚焦 = StaticBody(bodyHtml)；聚焦 = lazy <NoteEditor>（specs/05 §9.2）。
import type { Editor } from "@tiptap/core";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { StaticBody } from "../../editor/static-render.js";
import type { NoteSession } from "../../lib/doc-store.js";

const NoteEditor = lazy(() => import("../../editor/NoteEditor.js"));

export interface NoteBodyProps {
  session: NoteSession;
  bodyHtml: string;
  mountEditor: boolean;
  editable: boolean;
  onEditorReady: (editor: Editor) => void;
  onPasteRejected: () => void;
  onAttachmentFailures: (failures: string[]) => void;
  onSelectionChange: (has: boolean) => void;
}

export function NoteBody(p: NoteBodyProps) {
  const { t } = useTranslation();
  if (!p.mountEditor) {
    return (
      <div className="note-body bf-prose" data-static>
        {p.bodyHtml.trim() ? (
          <StaticBody html={p.bodyHtml} />
        ) : (
          <p className="note-placeholder" aria-hidden="true">
            {t("note.placeholder")}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="note-body bf-prose">
      <Suspense fallback={<StaticBody html={p.bodyHtml} />}>
        <NoteEditor
          session={p.session}
          placeholder={t("note.placeholder")}
          editable={p.editable}
          onReady={p.onEditorReady}
          onPasteRejected={p.onPasteRejected}
          onAttachmentFailures={p.onAttachmentFailures}
          onSelectionChange={p.onSelectionChange}
        />
      </Suspense>
    </div>
  );
}
