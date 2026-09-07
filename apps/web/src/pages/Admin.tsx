// /admin：平台总管理员管理台。
//
// 关于「入口」：站内任何地方都不链接到这里，导航里也不出现 —— 普通用户不会看到它。
// 但请把这理解成**体验**而不是**安全**：URL 是猜得到的，前端代码是公开的，
// 真正把人挡在外面的是服务端 requireSuperAdmin（非管理员 403 insufficient_role，
// PLATFORM_ADMIN_ENABLED=0 时整面 404）。所以进页面第一件事是问服务端一次，
// 按它的答案渲染「你没有权限」或「管理面已关闭」，而不是靠前端自己判断谁能进。
//
// 关于「授予/撤销总管理员」：这里不提供，也不该提供 —— 名单表 platform_admin 开了 RLS，
// api 进程用的角色根本写不进去，唯一入口是 SSH 上跑 infra/vps/platform-admin.sh。
// 界面上加一个按钮只会制造「能从网页上提权」的错觉。
import { useTranslation } from "react-i18next";
import { Notice } from "../components/Notice.js";
import { Card } from "../components/Shell.js";
import { StateView } from "../components/StateView.js";
import { useRequireSession } from "../lib/session.js";
import { navigate } from "../router.js";
import { AuditLog } from "./admin/AuditLog.js";
import { adminUrl, parseAdminRoute } from "./admin/route.js";
import { GateBlocked, useAdminGate } from "./admin/shared.js";
import { UserContent } from "./admin/UserContent.js";
import { UserDetail } from "./admin/UserDetail.js";
import { UserList } from "./admin/UserList.js";

export function Admin({ search }: { search: string }) {
  const { t } = useTranslation();
  const { user, pending } = useRequireSession("/admin");
  const { gate, recheck } = useAdminGate();
  const route = parseAdminRoute(search);

  if (pending || !user) {
    return (
      <Card title={t("admin.title")} wide>
        <StateView kind="loading" title={t("common.loading")} />
      </Card>
    );
  }

  if (gate.kind !== "allowed") {
    return (
      <Card title={t("admin.title")} wide>
        <GateBlocked gate={gate} onRetry={recheck} />
      </Card>
    );
  }

  return (
    <Card title={t("admin.title")} description={t("admin.desc")} wide>
      {/* 常驻：对管理员是提醒，对用户是交代 —— 每一次查看都写进 audit_log，且能在「审计」页看到 */}
      <Notice kind="warning">{t("admin.auditNotice")}</Notice>
      <nav className="admin-tabs" aria-label={t("admin.title")}>
        <button
          type="button"
          className="admin-tab"
          aria-current={route.tab === "users" ? "page" : undefined}
          onClick={() => navigate(adminUrl({}))}
        >
          {t("admin.tabs.users")}
        </button>
        <button
          type="button"
          className="admin-tab"
          aria-current={route.tab === "audit" ? "page" : undefined}
          onClick={() => navigate(adminUrl({ tab: "audit" }))}
        >
          {t("admin.tabs.audit")}
        </button>
      </nav>
      {route.tab === "audit" ? (
        <AuditLog />
      ) : route.userId && route.content ? (
        <UserContent userId={route.userId} workspaceId={route.workspaceId} noteId={route.noteId} />
      ) : route.userId ? (
        <UserDetail userId={route.userId} />
      ) : (
        <UserList />
      )}
    </Card>
  );
}
