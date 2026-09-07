// 邀请（管理员）：POST /v1/orgs/:id/invites → 直接展示 invite_url（复制后任意渠道发给对方）；GET 列表 + 重发 / 撤回。
import { Button, Select, useToast } from "@bianfa/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OrgRole } from "../../../api/me.js";
import {
  type AssignableRole,
  cancelInvite,
  createInvite,
  type Invitation,
  type InviteResult,
  listInvites,
  resendInvite,
} from "../../../api/orgs.js";
import { EmptyState } from "../EmptyState.js";
import { CopyField } from "./CopyField.js";
import { describeTeamError } from "./team-errors.js";
import { teamKeys } from "./team-keys.js";

export interface InvitesTabProps {
  orgId: string;
  myRole: OrgRole;
}

const SKELETON = ["a", "b"];

export function InvitesTab({ orgId, myRole }: InvitesTabProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const client = useQueryClient();
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);

  const invites = useQuery({
    queryKey: teamKeys.invites(orgId),
    queryFn: () => listInvites(orgId),
    retry: false,
  });
  const invalidate = () => client.invalidateQueries({ queryKey: teamKeys.invites(orgId) });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await createInvite(orgId, { email: value, role });
      setResult(r);
      setEmail("");
      await invalidate();
    } catch (err) {
      setError(describeTeamError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const resend = async (inv: Invitation) => {
    try {
      const r = await resendInvite(orgId, inv.id);
      setResult(r);
      toast({ message: t("team.resent", { email: inv.email }), kind: "success" });
      await invalidate();
    } catch (err) {
      toast({ message: describeTeamError(err, t), kind: "danger" });
    }
  };

  const cancel = async (inv: Invitation) => {
    try {
      await cancelInvite(orgId, inv.id);
      if (result?.invitation.id === inv.id) setResult(null);
      toast({ message: t("team.inviteCanceled", { email: inv.email }) });
      await invalidate();
    } catch (err) {
      toast({ message: describeTeamError(err, t), kind: "danger" });
    }
  };

  const roleOptions = [
    { value: "member" as const, label: t("team.role_member") },
    { value: "admin" as const, label: t("team.role_admin"), disabled: myRole !== "owner" },
  ];
  const pending = (invites.data ?? []).filter((i) => i.status === "pending");

  return (
    <div className="team-panel">
      <form className="team-form" onSubmit={(e) => void submit(e)}>
        <div className="team-field team-field--grow">
          <label htmlFor={emailId} className="team-label">
            {t("team.inviteEmail")}
          </label>
          <input
            id={emailId}
            className="bf-input"
            type="email"
            autoComplete="off"
            placeholder={t("team.inviteEmailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <Select
          label={t("team.inviteRole")}
          labelVisible
          value={role}
          options={roleOptions}
          onValueChange={(v) => setRole(v)}
        />
        <Button variant="primary" type="submit" icon="link" busy={busy} disabled={email.trim().length === 0}>
          {t("team.inviteSend")}
        </Button>
      </form>
      {error ? (
        <p className="team-warning" role="alert">
          {error}
        </p>
      ) : null}
      {result ? (
        <section className="team-invite-result" aria-live="polite" aria-label={t("team.inviteLink")}>
          <div className="team-row__name">
            <strong>{t("team.inviteLink")}</strong>
            <span className="team-badge">{result.invitation.email}</span>
            <span className={`team-badge team-badge--${result.invitation.role}`}>
              {t(`team.role_${result.invitation.role}`)}
            </span>
          </div>
          <CopyField value={result.inviteUrl} label={t("team.inviteLink")} />
          <p className="team-hint">{t("team.inviteLinkHint")}</p>
        </section>
      ) : null}

      <div className="team-toolbar">
        <h3 className="team-toolbar__title">{t("team.pendingInvites")}</h3>
      </div>
      {invites.isLoading ? (
        <div className="team-skeleton" aria-busy="true">
          {SKELETON.map((k) => (
            <div key={k} className="bf-skeleton" />
          ))}
        </div>
      ) : invites.isError ? (
        <EmptyState
          level="panel"
          title={t("team.invitesLoadFailed")}
          hint={describeTeamError(invites.error, t)}
          action={{ label: t("common.retry"), onClick: () => void invites.refetch() }}
        />
      ) : pending.length === 0 ? (
        <p className="team-hint">{t("team.invitesEmpty")}</p>
      ) : (
        <ul className="team-list" aria-label={t("team.pendingInvites")}>
          {pending.map((inv) => (
            <li key={inv.id} className="team-row">
              <div className="team-row__text">
                <div className="team-row__name">
                  <span>{inv.email}</span>
                  <span className={`team-badge team-badge--${inv.role}`}>{t(`team.role_${inv.role}`)}</span>
                </div>
                <div className="team-row__meta tabular">
                  {inv.expiresAt !== null
                    ? t("team.expiresAt", { time: new Date(inv.expiresAt).toLocaleString() })
                    : null}
                </div>
              </div>
              <div className="team-row__actions">
                <Button size="sm" variant="ghost" icon="refresh-cw" onClick={() => void resend(inv)}>
                  {t("team.resend")}
                </Button>
                <Button size="sm" variant="danger-secondary" onClick={() => void cancel(inv)}>
                  {t("team.cancelInvite")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
