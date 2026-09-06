import { Button, useToast } from "@bianfa/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { authLogout, openDataDir, trashEmpty } from "../../../ipc/commands.js";
import { type ExportFormat, exportNotes } from "../../../lib/export.js";
import { ImportWizard } from "../ImportWizard.js";

export function DataSection({ dataDir }: { dataDir: string | null }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [wizard, setWizard] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [confirmText, setConfirmText] = useState("");

  const doExport = async (format: ExportFormat) => {
    setBusy(format);
    try {
      const n = await exportNotes(format, t("export.pickDir"));
      if (n !== null) toast({ message: t("export.done", { count: n }), kind: "success" });
    } catch (e) {
      toast({ message: `${t("export.failed")}: ${(e as Error).message}`, kind: "danger" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="sec-data">
      <h2 id="sec-data" className="settings-section__title">
        {t("settings.data")}
      </h2>
      <h3 className="settings-subtitle">{t("export.title")}</h3>
      <div className="settings-inline">
        <Button icon="file-down" busy={busy === "md"} onClick={() => void doExport("md")}>
          {t("export.markdown")}
        </Button>
        <Button icon="file-text" busy={busy === "txt"} onClick={() => void doExport("txt")}>
          {t("export.txt")}
        </Button>
        <Button icon="database" busy={busy === "json"} onClick={() => void doExport("json")}>
          {t("export.json")}
        </Button>
      </div>
      <h3 className="settings-subtitle">{t("import.title")}</h3>
      <div className="settings-inline">
        <Button icon="file-up" onClick={() => setWizard(true)}>
          {t("import.windowsStickyNotes")}
        </Button>
      </div>
      <p className="settings-hint">{t("import.oneNoteHint")}</p>
      <h3 className="settings-subtitle">{t("settings.localData")}</h3>
      <p className="settings-hint tabular">{dataDir ?? "…"}</p>
      <Button icon="folder-open" onClick={() => void openDataDir()}>
        {t("settings.showInFileManager")}
      </Button>
      <div className="danger-zone">
        <h3 className="danger-zone__title">{t("settings.dangerZone")}</h3>
        <div className="settings-inline">
          <Button
            variant="danger-secondary"
            onClick={() => {
              if (window.confirm(t("trash.confirmEmpty")))
                void trashEmpty().then((r) => toast({ message: t("trash.emptied", { count: r.purged }) }));
            }}
          >
            {t("trash.empty")}
          </Button>
        </div>
        <label htmlFor="wipe-confirm" className="settings-label">
          {t("settings.wipeConfirmLabel")}
        </label>
        <div className="settings-inline">
          <input
            id="wipe-confirm"
            className="bf-input"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={t("settings.wipeWord")}
          />
          <Button
            variant="danger"
            disabled={confirmText !== t("settings.wipeWord")}
            onClick={() => void authLogout(true)}
          >
            {t("settings.wipe")}
          </Button>
        </div>
      </div>
      <ImportWizard open={wizard} onClose={() => setWizard(false)} />
    </section>
  );
}
