// 设置窗（specs/06 §4.4）：侧栏 200 + 内容区；全部即时生效。
import { Tabs } from "@bianfa/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { appInfo } from "../../ipc/commands.js";
import { queryKeys } from "../../lib/query.js";
import { useHotkeys } from "../../lib/shortcuts.js";
import { AboutSection } from "./sections/About.js";
import { AccountSection } from "./sections/Account.js";
import { AppearanceSection } from "./sections/Appearance.js";
import { DataSection } from "./sections/Data.js";
import { GeneralSection } from "./sections/General.js";

type SectionKey = "general" | "appearance" | "account" | "data" | "about";
const KEYS: SectionKey[] = ["general", "appearance", "account", "data", "about"];

function normalize(section: string | null): SectionKey {
  if (section === "sync" || section === "login") return "account";
  return KEYS.includes(section as SectionKey) ? (section as SectionKey) : "general";
}

export function SettingsApp({ initialSection }: { initialSection: string | null }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SectionKey>(normalize(initialSection));
  const info = useQuery({ queryKey: queryKeys.appInfo, queryFn: appInfo, retry: false });

  useHotkeys((action) => {
    if (action === "find") {
      document.querySelector<HTMLInputElement>(".settings-search")?.focus();
      return true;
    }
    return false;
  });

  return (
    <div className="settings">
      <header className="settings-topbar">
        <h1 className="settings-topbar__title">{t("app.settings")}</h1>
      </header>
      <div className="settings-body">
        <Tabs<SectionKey>
          value={tab}
          onChange={setTab}
          orientation="vertical"
          label={t("settings.sections")}
          className="settings-sidebar"
          items={KEYS.map((k) => ({ key: k, label: t(`settings.${k}`) }))}
        />
        <main className="settings-content">
          {tab === "general" ? <GeneralSection /> : null}
          {tab === "appearance" ? <AppearanceSection /> : null}
          {tab === "account" ? <AccountSection /> : null}
          {tab === "data" ? <DataSection dataDir={info.data?.dataDir ?? null} /> : null}
          {tab === "about" ? <AboutSection info={info.data ?? null} /> : null}
        </main>
      </div>
    </div>
  );
}
