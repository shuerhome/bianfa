// 团队页（主窗「团队」分区，取代只读团队墙）：组织切换（GET /v1/orgs）+ 新建组织；标签 成员 / 邀请 / 团队工作区 / 共享给我。
// 全部数据来自服务端（api/*），未登录 / 无组织 / 加载失败 各有空状态。
import { Button, Select, type TabItem, TabPanel, Tabs, useToast } from "@bianfa/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { listOrgs } from "../../../api/me.js";
import { createOrg } from "../../../api/orgs.js";
import { settingsWindowOpen } from "../../../ipc/commands.js";
import type { AuthStatus } from "../../../ipc/types.js";
import "../../../styles/team.css";
import { EmptyState } from "../EmptyState.js";
import { InvitesTab } from "./InvitesTab.js";
import { MembersTab } from "./MembersTab.js";
import { NameDialog } from "./NameDialog.js";
import { SharedTab } from "./SharedTab.js";
import { describeTeamError } from "./team-errors.js";
import { teamKeys } from "./team-keys.js";
import { WorkspacesTab } from "./WorkspacesTab.js";

export type TeamTab = "members" | "invites" | "workspaces" | "shared";

const SKELETON = ["a", "b", "c"];

export function TeamPanel({ auth }: { auth: AuthStatus | null }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const client = useQueryClient();
  const loggedIn = Boolean(auth?.loggedIn);
  const [selectedOrg, setSelectedOrg] = useState<string | null>(null);
  const [tab, setTab] = useState<TeamTab>("workspaces");
  const [createOpen, setCreateOpen] = useState(false);

  const orgs = useQuery({
    queryKey: teamKeys.orgs,
    queryFn: listOrgs,
    enabled: loggedIn,
    retry: false,
  });

  const visible = (orgs.data ?? []).filter((o) => o.status !== "removed");
  const current =
    visible.find((o) => o.id === selectedOrg) ??
    visible.find((o) => o.id === auth?.activeOrganizationId) ??
    visible[0] ??
    null;
  const isAdmin = current?.role === "owner" || current?.role === "admin";
  const activeTab: TeamTab = tab === "invites" && !isAdmin ? "members" : tab;

  const submitCreate = async (name: string) => {
    const r = await createOrg({ name });
    toast({ message: t("team.orgCreated", { name: r.org.name }), kind: "success" });
    setSelectedOrg(r.org.id);
    setCreateOpen(false);
    await client.invalidateQueries({ queryKey: teamKeys.orgs });
  };

  const createDialog = (
    <NameDialog
      open={createOpen}
      title={t("team.createOrgTitle")}
      description={t("team.createOrgDesc")}
      label={t("team.orgName")}
      placeholder={t("team.orgNamePlaceholder")}
      submitLabel={t("team.create")}
      onSubmit={submitCreate}
      onClose={() => setCreateOpen(false)}
    />
  );

  if (!loggedIn) {
    return (
      <EmptyState
        title={t("team.loginFirst")}
        hint={t("team.loginHint")}
        action={{ label: t("app.settings"), onClick: () => void settingsWindowOpen("account") }}
      />
    );
  }
  if (orgs.isLoading) {
    return (
      <div className="team-skeleton" aria-busy="true">
        {SKELETON.map((k) => (
          <div key={k} className="bf-skeleton" />
        ))}
      </div>
    );
  }
  if (orgs.isError) {
    return (
      <EmptyState
        title={t("team.loadFailed")}
        hint={describeTeamError(orgs.error, t)}
        action={{ label: t("common.retry"), onClick: () => void orgs.refetch() }}
      />
    );
  }
  if (!current) {
    return (
      <>
        <EmptyState
          title={t("team.noOrg")}
          hint={t("team.noOrgHint")}
          action={{ label: t("team.createOrg"), onClick: () => setCreateOpen(true) }}
        />
        {createDialog}
      </>
    );
  }

  const tabItems: TabItem<TeamTab>[] = [
    { key: "members", label: t("team.tab_members") },
    ...(isAdmin ? [{ key: "invites" as const, label: t("team.tab_invites") }] : []),
    { key: "workspaces", label: t("team.tab_workspaces") },
    { key: "shared", label: t("team.tab_shared") },
  ];

  return (
    <div className="team">
      <div className="team-head">
        <Select
          className="team-head__org"
          label={t("team.orgSwitcher")}
          value={current.id}
          options={visible.map((o) => ({ value: o.id, label: o.name }))}
          onValueChange={(v) => setSelectedOrg(v)}
        />
        <span className={`team-badge team-badge--${current.role}`}>{t(`team.role_${current.role}`)}</span>
        {current.status === "suspended" ? (
          <span className="team-badge team-badge--warning">{t("team.status_suspended")}</span>
        ) : null}
        <div className="team-head__actions">
          <Button
            size="sm"
            variant="ghost"
            icon="refresh-cw"
            onClick={() => void client.invalidateQueries({ queryKey: ["team"] })}
          >
            {t("team.refresh")}
          </Button>
          <Button size="sm" icon="plus" onClick={() => setCreateOpen(true)}>
            {t("team.createOrg")}
          </Button>
        </div>
      </div>
      <Tabs
        className="team-tabs"
        label={t("team.title")}
        value={activeTab}
        onChange={setTab}
        items={tabItems}
      />
      <TabPanel tabKey="members" active={activeTab === "members"}>
        <MembersTab orgId={current.id} myRole={current.role} myUserId={auth?.user?.id ?? null} />
      </TabPanel>
      {isAdmin ? (
        <TabPanel tabKey="invites" active={activeTab === "invites"}>
          <InvitesTab orgId={current.id} myRole={current.role} />
        </TabPanel>
      ) : null}
      <TabPanel tabKey="workspaces" active={activeTab === "workspaces"}>
        <WorkspacesTab orgId={current.id} myRole={current.role} />
      </TabPanel>
      <TabPanel tabKey="shared" active={activeTab === "shared"}>
        <SharedTab />
      </TabPanel>
      {createDialog}
    </div>
  );
}
