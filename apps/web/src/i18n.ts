// i18next + react-i18next；两个语言包体积很小，静态打包、同步初始化（无需等待）。
// 语言：localStorage("bianfa.lang") > navigator.languages（zh* → zh-Hans，其余 en）> zh-Hans。页脚可切换。
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./i18n/en.json";
import zh from "./i18n/zh-Hans.json";

export type Language = "zh-Hans" | "en";
export const LANGUAGES: readonly Language[] = ["zh-Hans", "en"];
const STORAGE_KEY = "bianfa.lang";

export function resolveLanguage(
  stored: string | null | undefined,
  navigatorLanguages: readonly string[],
): Language {
  if (stored === "zh-Hans" || stored === "en") return stored;
  for (const l of navigatorLanguages) {
    const lower = l.toLowerCase();
    if (lower.startsWith("zh")) return "zh-Hans";
    if (lower.startsWith("en")) return "en";
  }
  return "zh-Hans";
}

function storedLanguage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function initI18n(lang?: Language): Language {
  const resolved =
    lang ?? resolveLanguage(storedLanguage(), typeof navigator !== "undefined" ? navigator.languages : []);
  if (!i18next.isInitialized) {
    void i18next.use(initReactI18next).init({
      lng: resolved,
      fallbackLng: "zh-Hans",
      supportedLngs: [...LANGUAGES],
      resources: { "zh-Hans": { translation: zh }, en: { translation: en } },
      interpolation: { escapeValue: false },
      returnNull: false,
      initAsync: false,
    });
  } else if (i18next.language !== resolved) {
    void i18next.changeLanguage(resolved);
  }
  if (typeof document !== "undefined") document.documentElement.lang = resolved;
  return resolved;
}

export function setLanguage(lang: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
  void i18next.changeLanguage(lang);
  if (typeof document !== "undefined") document.documentElement.lang = lang;
}

export { i18next };
