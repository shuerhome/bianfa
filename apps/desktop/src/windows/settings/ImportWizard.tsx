// 导入向导（specs/06 §4.9、05 §7.4、02 §7）：import_scan → import_preview → JS 构造 Y.Doc → import_commit。
import { encodeStateV2, type PlumExportNote, plumNoteToNoteDoc, plumTimeToMs } from "@bianfa/shared";
import { Button, Dialog } from "@bianfa/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { buildProjection } from "../../editor/projection.js";
import { importCommit, importPreview, importScan, pickFile } from "../../ipc/commands.js";
import type { ImportCommitItem, ImportCommitResult, ImportSource } from "../../ipc/types.js";
import { toB64 } from "../../lib/base64.js";
import { uuidv7 } from "../../lib/uuid.js";

type Step =
  | { kind: "sources"; sources: ImportSource[]; loading: boolean }
  | { kind: "preview"; path: string; notes: PlumExportNote[]; selected: Set<string>; archivedTo: string }
  | { kind: "committing"; done: number; total: number }
  | { kind: "result"; result: ImportCommitResult; degraded: number; ink: number }
  | { kind: "error"; message: string };

/** 一条 plum 便笺 → import_commit 项（纯函数，可测） */
export function buildCommitItem(note: PlumExportNote): ImportCommitItem {
  const noteId = uuidv7();
  const { doc, init } = plumNoteToNoteDoc(note, noteId);
  const projection = buildProjection(doc);
  const w = note.window;
  const item: ImportCommitItem = {
    externalId: note.external_id,
    noteId,
    updateV2B64: toB64(encodeStateV2(doc)),
    projection,
    isOpen: init.isOpen,
    window:
      w && w.x !== undefined && w.y !== undefined && w.w !== undefined && w.h !== undefined
        ? { x: w.x, y: w.y, w: w.w, h: w.h, displayId: w.display_id ?? "" }
        : null,
    sourceUpdatedAt: plumTimeToMs(note.updated_at),
    degraded: note.import_degraded,
  };
  doc.destroy();
  return item;
}

export function ImportWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>({ kind: "sources", sources: [], loading: true });

  useEffect(() => {
    if (!open) return;
    setStep({ kind: "sources", sources: [], loading: true });
    importScan()
      .then((r) => setStep({ kind: "sources", sources: r.sources, loading: false }))
      .catch((e: Error) => setStep({ kind: "error", message: e.message }));
  }, [open]);

  const preview = async (path: string) => {
    setStep({ kind: "sources", sources: [], loading: true });
    try {
      const r = await importPreview(path);
      setStep({
        kind: "preview",
        path,
        notes: r.notes,
        selected: new Set(r.notes.map((n) => n.external_id)),
        archivedTo: r.archivedTo,
      });
    } catch (e) {
      setStep({ kind: "error", message: (e as Error).message });
    }
  };

  const choose = async () => {
    const r = await pickFile({
      title: t("import.pickTitle"),
      filters: [{ name: "Sticky Notes", extensions: ["sqlite", "snt"] }],
    });
    if (r.path) await preview(r.path);
  };

  const commit = async () => {
    if (step.kind !== "preview") return;
    const chosen = step.notes.filter((n) => step.selected.has(n.external_id));
    setStep({ kind: "committing", done: 0, total: chosen.length });
    const items: ImportCommitItem[] = [];
    for (const [i, n] of chosen.entries()) {
      items.push(buildCommitItem(n));
      if (i % 20 === 0) {
        setStep({ kind: "committing", done: i, total: chosen.length });
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    try {
      const result = await importCommit(step.path, items);
      setStep({
        kind: "result",
        result,
        degraded: chosen.filter((n) => n.import_degraded).length,
        ink: chosen.filter((n) => n.has_ink).length,
      });
    } catch (e) {
      setStep({ kind: "error", message: (e as Error).message });
    }
  };

  const toggle = (id: string) => {
    if (step.kind !== "preview") return;
    const next = new Set(step.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setStep({ ...step, selected: next });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("import.title")}
      closeLabel={t("common.close")}
      width={520}
    >
      {step.kind === "sources" ? (
        <div className="import-sources">
          {step.loading ? (
            <div aria-busy="true" className="bf-skeleton" />
          ) : (
            <>
              {step.sources.length === 0 ? <p className="settings-hint">{t("import.noneFound")}</p> : null}
              {step.sources.map((src) => (
                <button
                  key={src.path}
                  type="button"
                  className="import-source"
                  onClick={() => void preview(src.path)}
                >
                  <span className="import-source__title">
                    {src.kind === "plum" ? t("import.sourcePlum") : t("import.sourceSnt")}
                  </span>
                  <span className="import-source__meta">{t("import.foundCount", { count: src.count })}</span>
                  {src.stickyNotesRunning ? (
                    <span className="settings-warning">{t("import.stickyRunning")}</span>
                  ) : null}
                  <span className="import-source__path">{src.path}</span>
                </button>
              ))}
              <Button icon="folder-open" onClick={() => void choose()}>
                {t("import.chooseFile")}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {step.kind === "preview" ? (
        <div className="import-preview">
          <p className="settings-hint">
            {t("import.previewCount", { count: step.selected.size, total: step.notes.length })}
          </p>
          <ul className="import-list">
            {step.notes.map((n) => (
              <li key={n.external_id} className="import-row" data-color={n.color}>
                <input
                  id={`imp-${n.external_id}`}
                  type="checkbox"
                  checked={step.selected.has(n.external_id)}
                  onChange={() => toggle(n.external_id)}
                />
                <label htmlFor={`imp-${n.external_id}`} className="import-row__title">
                  {n.title || t("note.untitled")}
                </label>
                {n.is_open ? <span className="note-card__badge">{t("list.openBadge")}</span> : null}
                {n.import_degraded ? <span className="import-row__flag">{t("import.degraded")}</span> : null}
              </li>
            ))}
          </ul>
          <p className="settings-hint">{t("import.archiveNote", { path: step.archivedTo })}</p>
          <div className="bf-dialog__footer">
            <Button variant="ghost" onClick={onClose}>
              {t("import.later")}
            </Button>
            <Button variant="primary" onClick={() => void commit()} disabled={step.selected.size === 0}>
              {t("import.import")}
            </Button>
          </div>
        </div>
      ) : null}
      {step.kind === "committing" ? (
        <div aria-busy="true" className="import-progress">
          <div
            className="import-progress__bar"
            style={{ transform: `scaleX(${step.total ? step.done / step.total : 0})` }}
          />
          <p className="settings-hint">
            {step.done}/{step.total}
          </p>
        </div>
      ) : null}
      {step.kind === "result" ? (
        <div className="import-result">
          <p>
            {t("import.result", {
              imported: step.result.imported,
              updated: step.result.updated,
              skipped: step.result.skipped,
            })}
          </p>
          <p className="settings-hint">
            {t("import.resultDetail", { degraded: step.degraded, ink: step.ink })}
          </p>
          <div className="bf-dialog__footer">
            <Button variant="primary" onClick={onClose}>
              {t("common.done")}
            </Button>
          </div>
        </div>
      ) : null}
      {step.kind === "error" ? (
        <div className="import-result">
          <p className="settings-warning">{t("import.failed")}</p>
          <p className="settings-hint">{step.message}</p>
          <p className="settings-hint">{t("import.failedHint")}</p>
          <div className="bf-dialog__footer">
            <Button onClick={onClose}>{t("common.close")}</Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
