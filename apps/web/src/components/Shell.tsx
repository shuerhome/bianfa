// 页面骨架：顶部品牌、居中卡片、页脚语言切换（specs/06 §2–3 token；无外部资源）
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LANGUAGES, type Language, setLanguage } from "../i18n.js";

export function Brand() {
  return (
    <a className="web-brand" href="/" aria-label="bianfa">
      <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <rect width="32" height="32" rx="7" fill="var(--c-accent)" />
        <g fill="var(--c-text-on-accent)">
          <circle cx="11" cy="10" r="2.6" />
          <circle cx="21" cy="10" r="2.6" />
          <circle cx="11" cy="22" r="2.6" />
          <circle cx="21" cy="22" r="2.6" />
        </g>
      </svg>
      <span>bianfa</span>
    </a>
  );
}

export function LanguageToggle() {
  const { i18n, t } = useTranslation();
  const labels: Record<Language, string> = { "zh-Hans": "中文", en: "English" };
  return (
    <fieldset className="web-lang">
      <legend className="bf-sr-only">{t("footer.language")}</legend>
      {LANGUAGES.map((lang) => (
        <button
          key={lang}
          type="button"
          className="web-lang__btn"
          aria-pressed={i18n.language === lang}
          lang={lang}
          onClick={() => setLanguage(lang)}
        >
          {labels[lang]}
        </button>
      ))}
    </fieldset>
  );
}

export function Shell({ children, headerRight }: { children: ReactNode; headerRight?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="web-shell">
      <header className="web-header">
        <Brand />
        <div className="web-header__right">{headerRight}</div>
      </header>
      <main className="web-main">{children}</main>
      <footer className="web-footer">
        <LanguageToggle />
        <span className="web-footer__note">{t("footer.note")}</span>
      </footer>
    </div>
  );
}

export function Card({
  title,
  description,
  children,
  labelledBy,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  labelledBy?: string;
}) {
  const id = labelledBy ?? "web-card-title";
  return (
    <section className="web-card" aria-labelledby={id}>
      <h1 id={id} className="web-title">
        {title}
      </h1>
      {description ? <p className="web-desc">{description}</p> : null}
      {children}
    </section>
  );
}
