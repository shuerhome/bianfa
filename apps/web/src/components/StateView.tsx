// 加载 / 成功 / 失败 / 空态（specs/06 §4.11：主文案 --fs-sm --c-text-2，次行 --fs-2xs --c-text-3，间距 --sp-3，按钮 --sp-6 / 32px primary）
import { cx, Icon } from "@bianfa/ui";
import type { ReactNode } from "react";

export type StateKind = "loading" | "success" | "error" | "info";

export function StateView({
  kind,
  title,
  detail,
  actions,
  headline,
}: {
  kind: StateKind;
  /** 列表级大标题（--fs-2xl --c-text-1）；成功 / 失败页用 */
  headline?: string;
  title: string;
  detail?: string | undefined;
  actions?: ReactNode;
}) {
  return (
    <div className={cx("web-state", `web-state--${kind}`)} role={kind === "loading" ? "status" : undefined}>
      {kind === "loading" ? (
        <span className="bf-spinner web-state__spinner" aria-hidden="true" />
      ) : (
        <span className="web-state__icon" aria-hidden="true">
          <Icon name={kind === "success" ? "check" : kind === "error" ? "circle-alert" : "info"} size={22} />
        </span>
      )}
      {headline ? <p className="web-state__headline">{headline}</p> : null}
      <p className="web-state__title">{title}</p>
      {detail ? <p className="web-state__detail">{detail}</p> : null}
      {actions ? <div className="web-state__actions">{actions}</div> : null}
    </div>
  );
}
