import { Button, Switch } from "@bianfa/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openExternal, updateCheck, updateInstall } from "../../../ipc/commands.js";
import type { AppInfo } from "../../../ipc/types.js";
import { UpdateBanner } from "../../main/UpdateBanner.js";
import { Ack, useSettings } from "../use-settings.js";

export function AboutSection({ info }: { info: AppInfo | null }) {
  const { t } = useTranslation();
  const { settings, update, ackKey } = useSettings();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ available: boolean; version?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      const r = await updateCheck(true);
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="sec-about">
      <h2 id="sec-about" className="settings-section__title">
        {t("settings.about")}
      </h2>
      <dl className="about-grid tabular">
        <dt>{t("about.version")}</dt>
        <dd>{info?.version ?? "…"}</dd>
        <dt>{t("about.channel")}</dt>
        <dd>{info?.channel ?? settings.channel}</dd>
        <dt>{t("about.webview")}</dt>
        <dd>{info?.webview ?? "…"}</dd>
        <dt>{t("about.installId")}</dt>
        <dd>{info?.installId ?? "…"}</dd>
      </dl>
      {result?.available && result.version ? <UpdateBanner version={result.version} onDismiss={() => setResult(null)} /> : null}
      {result && !result.available ? <p className="settings-hint">{t("about.upToDate")}</p> : null}
      {error ? <p className="settings-warning">{error}</p> : null}
      <div className="settings-inline">
        <Button icon="refresh-cw" busy={checking} onClick={() => void check()}>
          {t("about.checkUpdate")}
        </Button>
        {result?.available ? (
          <Button variant="primary" onClick={() => void updateInstall()}>
            {t("update.restart")}
          </Button>
        ) : null}
      </div>
      <div className="settings-row">
        <Switch
          label={t("about.beta")}
          description={t("about.betaHint")}
          checked={settings.channel === "beta"}
          onChange={(v) => {
            update({ channel: v ? "beta" : "stable" });
            window.setTimeout(() => void check(), 300);
          }}
        />
        <Ack on={ackKey === "channel"} />
      </div>
      <div className="settings-inline">
        <Button variant="ghost" icon="external-link" onClick={() => void openExternal("https://bianfa.app")}>
          {t("about.website")}
        </Button>
      </div>
    </section>
  );
}
