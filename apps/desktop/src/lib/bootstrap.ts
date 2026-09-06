// 三个 UI 入口共用的启动序列：settings → i18n / 主题 / 缩放 / data-os；theme-changed 订阅；图标 sprite。
import { ensureIconSprite } from "@bianfa/ui";
import { appInfo, settingsGet } from "../ipc/commands.js";
import { onThemeChanged } from "../ipc/events.js";
import type { Settings } from "../ipc/types.js";
import { initI18n } from "./i18n.js";
import { setOs } from "./platform.js";
import {
  applyColorPatterns,
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
  return { settings };
}
