// 更新公告条（specs/06 §4.10）：只出现在主窗/设置窗；关闭后本会话不再出现。
import { Button, Icon } from "@bianfa/ui";
import { useTranslation } from "react-i18next";
import { updateInstall } from "../../ipc/commands.js";

export interface UpdateBannerProps {
  version: string;
  onDismiss: () => void;
}

export function UpdateBanner({ version, onDismiss }: UpdateBannerProps) {
  const { t } = useTranslation();
  return (
    <div className="bf-banner bf-banner--accent" role="status">
      <Icon name="download" />
      <span>{t("update.ready", { version })}</span>
      <span className="bf-banner__spacer" />
      <Button size="sm" variant="primary" onClick={() => void updateInstall()}>
        {t("update.restart")}
      </Button>
      <Button size="sm" variant="ghost" onClick={onDismiss}>
        {t("update.later")}
      </Button>
    </div>
  );
}
