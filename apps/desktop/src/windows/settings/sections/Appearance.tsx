import { Switch } from "@bianfa/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThemeSetting, UiScale } from "../../../ipc/types.js";
import { applyMotion, type MotionSetting } from "../../../lib/theme.js";
import { Segmented } from "../Segmented.js";
import { Ack, useSettings } from "../use-settings.js";

const THEMES: ThemeSetting[] = ["system", "light", "dark"];
const SCALES: UiScale[] = [90, 100, 115, 130];
const MOTIONS: MotionSetting[] = ["system", "full", "reduce"];

export function AppearanceSection() {
  const { t } = useTranslation();
  const { settings, update, ackKey } = useSettings();
  const [motion, setMotion] = useState<MotionSetting>(
    () => (document.documentElement.getAttribute("data-motion") as MotionSetting | null) ?? "system",
  );

  return (
    <section className="settings-section" aria-labelledby="sec-appearance">
      <h2 id="sec-appearance" className="settings-section__title">
        {t("settings.appearance")}
      </h2>
      <div className="settings-row settings-row--stack">
        <span className="settings-label">{t("settings.theme")}</span>
        <div className="settings-inline">
          <Segmented<ThemeSetting>
            label={t("settings.theme")}
            value={settings.theme}
            options={THEMES.map((v) => ({ value: v, label: t(`settings.theme_${v}`) }))}
            onChange={(v) => update({ theme: v })}
          />
          <Ack on={ackKey === "theme"} />
        </div>
      </div>
      <div className="settings-row settings-row--stack">
        <span className="settings-label">{t("settings.uiScale")}</span>
        <div className="settings-inline">
          <Segmented<UiScale>
            label={t("settings.uiScale")}
            value={settings.uiScale}
            options={SCALES.map((v) => ({ value: v, label: `${v}%` }))}
            onChange={(v) => update({ uiScale: v })}
            tabular
          />
          <Ack on={ackKey === "uiScale"} />
        </div>
      </div>
      <div className="settings-row settings-row--stack">
        <span className="settings-label">{t("settings.motion")}</span>
        <Segmented<MotionSetting>
          label={t("settings.motion")}
          value={motion}
          options={MOTIONS.map((v) => ({ value: v, label: t(`settings.motion_${v}`) }))}
          onChange={(v) => {
            setMotion(v);
            applyMotion(v);
          }}
        />
      </div>
      <div className="settings-row">
        <Switch
          label={t("settings.colorPatterns")}
          description={t("settings.colorPatternsHint")}
          checked={settings.colorPatterns}
          onChange={(v) => update({ colorPatterns: v })}
        />
        <Ack on={ackKey === "colorPatterns"} />
      </div>
      <div className="settings-row">
        <Switch
          label={t("settings.reduceTransparency")}
          description={t("settings.reduceTransparencyHint")}
          checked={settings.reduceTransparency}
          onChange={(v) => update({ reduceTransparency: v })}
        />
        <Ack on={ackKey === "reduceTransparency"} />
      </div>
      <div className="settings-preview" data-color="citron" data-focused="true" aria-hidden="true">
        <div className="note-window">
          <div className="note-shell settings-preview__shell">
            <div className="note-titlebar">
              <span className="note-dot" />
            </div>
            <div className="note-body bf-prose settings-preview__body">
              <p className="note-title">{t("settings.previewTitle")}</p>
              <p>{t("settings.previewBody")}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
