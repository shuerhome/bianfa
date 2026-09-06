import { Switch } from "@bianfa/ui";
import { useTranslation } from "react-i18next";
import type { ThemeSetting, UiScale } from "../../../ipc/types.js";
import { applyMotion, type MotionSetting } from "../../../lib/theme.js";
import { Ack, useSettings } from "../use-settings.js";

const THEMES: ThemeSetting[] = ["system", "light", "dark"];
const SCALES: UiScale[] = [90, 100, 115, 130];
const MOTIONS: MotionSetting[] = ["system", "full", "reduce"];

export function AppearanceSection() {
  const { t } = useTranslation();
  const { settings, update, ackKey } = useSettings();
  const motion = (document.documentElement.getAttribute("data-motion") as MotionSetting | null) ?? "system";

  return (
    <section className="settings-section" aria-labelledby="sec-appearance">
      <h2 id="sec-appearance" className="settings-section__title">
        {t("settings.appearance")}
      </h2>
      <div className="settings-row settings-row--stack">
        <span className="settings-label">{t("settings.theme")}</span>
        <div className="segmented" role="radiogroup" aria-label={t("settings.theme")}>
          {THEMES.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={settings.theme === v}
              className="segmented__item"
              onClick={() => update({ theme: v })}
            >
              {t(`settings.theme_${v}`)}
            </button>
          ))}
          <Ack on={ackKey === "theme"} />
        </div>
      </div>
      <div className="settings-row settings-row--stack">
        <span className="settings-label">{t("settings.uiScale")}</span>
        <div className="segmented" role="radiogroup" aria-label={t("settings.uiScale")}>
          {SCALES.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={settings.uiScale === v}
              className="segmented__item tabular"
              onClick={() => update({ uiScale: v })}
            >
              {v}%
            </button>
          ))}
          <Ack on={ackKey === "uiScale"} />
        </div>
      </div>
      <div className="settings-row settings-row--stack">
        <span className="settings-label">{t("settings.motion")}</span>
        <div className="segmented" role="radiogroup" aria-label={t("settings.motion")}>
          {MOTIONS.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={motion === v}
              className="segmented__item"
              onClick={() => applyMotion(v)}
            >
              {t(`settings.motion_${v}`)}
            </button>
          ))}
        </div>
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
