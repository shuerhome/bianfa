// 三个 UI 入口共用的启动序列：settings → i18n / 主题 / 缩放 / data-os；theme-changed 订阅；图标 sprite。
import { ensureIconSprite } from "@bianfa/ui";
import { appInfo, settingsGet } from "../ipc/commands.js";
import { onDbChanged, onThemeChanged } from "../ipc/events.js";
import type { Settings } from "../ipc/types.js";
import { initI18n } from "./i18n.js";
import { setOs } from "./platform.js";
import {
  applyColorPatterns,
  applyContentDensity,
  applyReduceTransparency,
  applyThemeSetting,
  applyUiScale,
  onSystemThemeChanged,
} from "./theme.js";

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  uiScale: 100,
  language: "system",
  autostart: false,
  channel: "stable",
  hotkeyNewNote: "",
  desktopPinReadonly: false,
  colorPatterns: false,
  reduceTransparency: false,
  contentDensity: "compact",
  apiBaseUrl: "",
  syncWsUrl: "",
};

export interface BootResult {
  settings: Settings;
}

export function applySettingsToDocument(settings: Settings): void {
  applyThemeSetting(settings.theme);
  applyUiScale(settings.uiScale);
  applyColorPatterns(settings.colorPatterns);
  applyReduceTransparency(settings.reduceTransparency);
  applyContentDensity(settings.contentDensity);
}

export async function boot(): Promise<BootResult> {
  const [settings, info] = await Promise.all([
    settingsGet().catch(() => DEFAULT_SETTINGS),
    appInfo().catch(() => null),
  ]);
  if (info) setOs(info.os);
  else setOs(document.documentElement.dataset.os as never);
  applySettingsToDocument(settings);
  ensureIconSprite();
  await initI18n(settings.language);
  void onThemeChanged(() => onSystemThemeChanged(settings.theme));
  // 外观类设置改了要立刻在**所有**窗口生效。settings_set 提交后会 emit
  // db:changed(tables=["settings"])，但在此之前没有任何窗口监听它 —— 于是改了缩放、
  // 紧凑度这些，已经打开的便笺要等下次打开才变。对紧凑度尤其致命：那是一个必须边调边看的
  // 设置，看不到效果就等于坏的。
  void onDbChanged((p) => {
    if (!p.tables.includes("settings")) return;
    void settingsGet()
      .then(applySettingsToDocument)
      .catch(() => undefined);
  });
  return { settings };
}
