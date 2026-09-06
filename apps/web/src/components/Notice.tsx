// 行内提示条（错误 / 成功 / 提示），复用 @bianfa/ui 的 .bf-banner
import { cx, Icon } from "@bianfa/ui";
import type { ReactNode } from "react";

export function Notice({
  kind,
  children,
  action,
}: {
  kind: "danger" | "warning" | "accent";
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={cx("bf-banner", `bf-banner--${kind}`, "web-notice")}
      role={kind === "danger" ? "alert" : "status"}
    >
      <Icon name={kind === "danger" ? "circle-alert" : kind === "warning" ? "triangle-alert" : "info"} />
      <span className="web-notice__text">{children}</span>
      {action}
    </div>
  );
}
