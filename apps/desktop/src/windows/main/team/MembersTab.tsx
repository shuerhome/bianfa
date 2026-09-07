// 成员：GET /v1/orgs/:id/members；管理员改角色（PATCH）/ 移除（DELETE，二次确认）；所有者转让（POST /transfer）。
import { Button, Select, useToast } from "@bianfa/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { OrgRole } from "../../../api/me.js";
import {
  type AssignableRole,
  listMembers,
  type Member,
  removeMember,
  transferOrg,
  updateMemberRole,
} from "../../../api/orgs.js";
import { EmptyState } from "../EmptyState.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { describeTeamError } from "./team-errors.js";
import { teamKeys } from "./team-keys.js";

export interface MembersTabProps {
  orgId: string;
  myRole: OrgRole;
  myUserId: string | null;
}

const SKELETON = ["a", "b", "c"];

export function memberLabel(m: Member): string {
  return m.name || m.email;
}

export function MembersTab({ orgId, myRole, myUserId }: MembersTabProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const client = useQueryClient();
  const [confirm, setConfirm] = useState<{ kind: "remove" | "transfer"; member: Member } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const members = useQuery({
    queryKey: teamKeys.members(orgId),
    queryFn: () => listMembers(orgId),
    retry: false,
  });
  const canManage = myRole === "owner" || myRole === "admin";
  const invalidate = () => client.invalidateQueries({ queryKey: teamKeys.members(orgId) });

  const changeRole = async (m: Member, role: AssignableRole) => {
    if (role === m.role) return;
    try {
      await updateMemberRole(orgId, m.userId, role);
      toast({
        message: t("team.roleChanged", { name: memberLabel(m), role: t(`team.role_${role}`) }),
        kind: "success",
      });
      await invalidate();
    } catch (err) {
      toast({ message: describeTeamError(err, t), kind: "danger" });
      await invalidate();
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    setConfirmBusy(true);
    setConfirmError(null);
    const name = memberLabel(confirm.member);
    try {
      if (confirm.kind === "remove") {
        await removeMember(orgId, confirm.member.userId);
        toast({ message: t("team.removed", { name }) });
      } else {
        await transferOrg(orgId, confirm.member.userId);
        toast({ message: t("team.transferred", { name }), kind: "success" });
        await client.invalidateQueries({ queryKey: teamKeys.orgs });
      }
      await invalidate();
      setConfirm(null);
    } catch (err) {
      setConfirmError(describeTeamError(err, t));
    } finally {
      setConfirmBusy(false);
    }
  };

  if (members.isLoading) {
    return (
      <div className="team-skeleton" aria-busy="true">
        {SKELETON.map((k) => (
          <div key={k} className="bf-skeleton" />
        ))}
      </div>
    );
  }
  if (members.isError) {
    return (
      <EmptyState
        level="panel"
        title={t("team.membersLoadFailed")}
        hint={describeTeamError(members.error, t)}
        action={{ label: t("common.retry"), onClick: () => void members.refetch() }}
      />
    );
  }
  const list = members.data ?? [];
  const roleOptions = [
    { value: "admin" as const, label: t("team.role_admin") },
    { value: "member" as const, label: t("team.role_member") },
  ];

  return (
    <div className="team-panel">
      <ul className="team-list" aria-label={t("team.members")}>
        {list.map((m) => {
          const isMe = m.userId === myUserId;
          const name = memberLabel(m);
          const editable = canManage && !isMe && m.role !== "owner";
          return (
            <li key={m.userId} className={`team-row${m.status === "suspended" ? " team-row--muted" : ""}`}>
              <div className="team-row__avatar" aria-hidden="true">
                {name.slice(0, 1)}
              </div>
              <div className="team-row__text">
                <div className="team-row__name">
                  <span>{name}</span>
                  {isMe ? <span className="team-badge">{t("team.you")}</span> : null}
                  <span className={`team-badge team-badge--${m.role}`}>{t(`team.role_${m.role}`)}</span>
                  {m.status === "suspended" ? (
                    <span className="team-badge team-badge--warning">{t("team.status_suspended")}</span>
                  ) : null}
                </div>
                <div className="team-row__meta">{m.email}</div>
              </div>
              <div className="team-row__actions">
                {editable ? (
                  <Select
                    label={`${t("team.changeRole")} · ${name}`}
                    value={m.role as AssignableRole}
                    options={roleOptions}
                    onValueChange={(v) => void changeRole(m, v)}
                  />
                ) : null}
                {myRole === "owner" && !isMe ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirm({ kind: "transfer", member: m })}
                  >
                    {t("team.transfer")}
                  </Button>
                ) : null}
                {editable ? (
                  <Button
                    size="sm"
                    variant="danger-secondary"
                    onClick={() => setConfirm({ kind: "remove", member: m })}
                  >
                    {t("team.remove")}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {list.length <= 1 ? <p className="team-hint">{t("team.membersEmpty")}</p> : null}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === "transfer" ? t("team.transferTitle") : t("team.removeTitle")}
        description={
          confirm
            ? t(confirm.kind === "transfer" ? "team.transferConfirm" : "team.removeConfirm", {
                name: memberLabel(confirm.member),
              })
            : ""
        }
        confirmLabel={confirm?.kind === "transfer" ? t("team.transfer") : t("team.remove")}
        danger={confirm?.kind === "remove"}
        busy={confirmBusy}
        error={confirmError}
        onConfirm={() => void runConfirm()}
        onClose={() => {
          if (!confirmBusy) {
            setConfirm(null);
            setConfirmError(null);
          }
        }}
      />
    </div>
  );
}
