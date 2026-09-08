import { Switch } from "@bianfa/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CONTENT_DENSITIES,
  type ContentDensity,
  NOTE_FONT_SIZES,
  type NoteFontSize,
  type ThemeSetting,
  type UiScale,
} from "../../../ipc/types.js";
import {
  applyContentDensity,
  applyMotion,
  applyNoteFontSize,
  type MotionSetting,
} from "../../../lib/theme.js";
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
        <span className="settings-label">{t("settings.density")}</span>
        <div className="settings-inline">
          <Segmented<ContentDensity>
            label={t("settings.density")}
            value={settings.contentDensity}
            options={CONTENT_DENSITIES.map((v) => ({ value: v, label: t(`settings.density_${v}`) }))}
            onChange={(v) => {
              // 先落到本窗口，让下面那块预览立刻跟着变（不等 IPC 往返）；
              // 其它窗口靠 settings_set 提交后 emit 的 db:changed(settings) 各自重新应用（见 lib/bootstrap.ts）
              applyContentDensity(v);
              update({ contentDensity: v });
            }}
          />
          <Ack on={ackKey === "contentDensity"} />
        </div>
        <p className="settings-hint">{t("settings.densityHint")}</p>
      </div>
      <div className="settings-row settings-row--stack">
        <span className="settings-label">{t("settings.noteFontSize")}</span>
        <div className="settings-inline">
          <Segmented<NoteFontSize>
            label={t("settings.noteFontSize")}
            value={settings.noteFontSize}
            options={NOTE_FONT_SIZES.map((v) => ({
              value: v,
              label: t(`settings.noteFontSize_${v}`),
            }))}
            onChange={(v) => {
              applyNoteFontSize(v);
              update({ noteFontSize: v });
            }}
          />
          <Ack on={ackKey === "noteFontSize"} />
        </div>
        <p className="settings-hint">{t("settings.noteFontSizeHint")}</p>
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
              {/* 两段正文而不是一段：紧凑度改的就是段间距，只有一条间距的话几乎看不出来 */}
              <p>{t("settings.previewBody")}</p>
              <p>{t("settings.previewBody2")}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
