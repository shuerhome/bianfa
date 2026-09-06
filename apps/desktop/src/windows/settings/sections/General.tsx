import { Select, Switch } from "@bianfa/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { autostartSet, hotkeySet } from "../../../ipc/commands.js";
import type { LanguageSetting } from "../../../ipc/types.js";
import { globalNewNoteLabel } from "../../../lib/shortcuts.js";
import { Ack, useSettings } from "../use-settings.js";

export function GeneralSection() {
  const { t } = useTranslation();
  const { settings, update, ackKey } = useSettings();
  const [hotkeyError, setHotkeyError] = useState<string | null>(null);
  const [hotkeyDraft, setHotkeyDraft] = useState<string | null>(null);

  const saveHotkey = async () => {
    const value = (hotkeyDraft ?? settings.hotkeyNewNote).trim();
    if (!value) return;
    const res = await hotkeySet(value).catch((e: Error) => ({ ok: false, error: e.message }));
    if (res.ok) {
      setHotkeyError(null);
      update({ hotkeyNewNote: value });
    } else setHotkeyError(res.error ?? t("settings.hotkeyTaken", { owner: t("common.unknown") }));
  };

  return (
    <section className="settings-section" aria-labelledby="sec-general">
      <h2 id="sec-general" className="settings-section__title">
        {t("settings.general")}
      </h2>
      <div className="settings-row">
        <Select<LanguageSetting>
          label={t("settings.language")}
          labelVisible
          value={settings.language}
          options={[
            { value: "system", label: t("settings.languageSystem") },
            { value: "zh-Hans", label: "简体中文" },
            { value: "en", label: "English" },
          ]}
          onValueChange={(v) => update({ language: v })}
        />
        <Ack on={ackKey === "language"} />
      </div>
      <div className="settings-row">
        <Switch
          label={t("settings.autostart")}
          description={t("settings.autostartHint")}
          checked={settings.autostart}
          onChange={(v) => {
            void autostartSet(v).catch(() => undefined);
            update({ autostart: v });
          }}
        />
        <Ack on={ackKey === "autostart"} />
      </div>
      <div className={`settings-row settings-row--stack${hotkeyError ? " settings-row--warning" : ""}`}>
        <label htmlFor="hotkey-input" className="settings-label">
          {t("settings.hotkeyNewNote")}
        </label>
        <div className="settings-inline">
          <input
            id="hotkey-input"
            className="bf-input"
            value={hotkeyDraft ?? settings.hotkeyNewNote}
            placeholder={globalNewNoteLabel()}
            onChange={(e) => setHotkeyDraft(e.target.value)}
            onBlur={() => void saveHotkey()}
            onKeyDown={(e) => e.key === "Enter" && void saveHotkey()}
          />
          <Ack on={ackKey === "hotkeyNewNote"} />
        </div>
        {hotkeyError ? <p className="settings-warning">{hotkeyError}</p> : null}
        <p className="settings-hint">{t("settings.hotkeyHint")}</p>
      </div>
    </section>
  );
}
