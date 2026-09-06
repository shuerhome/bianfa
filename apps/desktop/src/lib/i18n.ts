// i18next + react-i18next；语言包经 import() 动态加载（specs/05 §1.2）。M1：zh-Hans + en。
import i18next, { type i18n as I18n } from "i18next";
import { initReactI18next } from "react-i18next";
import type { LanguageSetting } from "../ipc/types.js";

export type Language = "zh-Hans" | "en";
export const LANGUAGES: readonly Language[] = ["zh-Hans", "en"];

const bundles = import.meta.glob<{ default: Record<string, unknown> }>("../i18n/*.json");

export function resolveLanguage(setting: LanguageSetting, navigatorLanguages?: readonly string[]): Language {
  if (setting === "zh-Hans" || setting === "en") return setting;
  const langs = navigatorLanguages ?? (typeof navigator !== "undefined" ? navigator.languages : []);
  for (const l of langs) {
    const lower = l.toLowerCase();
    if (lower.startsWith("zh")) return "zh-Hans";
    if (lower.startsWith("en")) return "en";
  }
  return "zh-Hans";
}

async function loadBundle(lang: Language): Promise<Record<string, unknown>> {
  const loader = bundles[`../i18n/${lang}.json`];
  if (!loader) throw new Error(`缺少语言包 ${lang}`);
  return (await loader()).default;
}

let initialized = false;

export async function initI18n(setting: LanguageSetting): Promise<I18n> {
  const lang = resolveLanguage(setting);
  const bundle = await loadBundle(lang);
  if (!initialized) {
    await i18next.use(initReactI18next).init({
      lng: lang,
      fallbackLng: "zh-Hans",
      supportedLngs: [...LANGUAGES],
      resources: { [lang]: { translation: bundle } },
      interpolation: { escapeValue: false },
      returnNull: false,
    });
    initialized = true;
  } else {
    i18next.addResourceBundle(lang, "translation", bundle, true, true);
    await i18next.changeLanguage(lang);
  }
  document.documentElement.lang = lang;
  return i18next;
}

export async function changeLanguage(setting: LanguageSetting): Promise<void> {
  const lang = resolveLanguage(setting);
  if (!i18next.hasResourceBundle(lang, "translation")) {
    i18next.addResourceBundle(lang, "translation", await loadBundle(lang), true, true);
  }
  await i18next.changeLanguage(lang);
  document.documentElement.lang = lang;
}

export { i18next };
