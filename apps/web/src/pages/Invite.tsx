// /invite/:token：匿名预览（org / 邀请人 / 角色）→ 未登录去登录或注册（带 next）→ 已登录 接受 / 拒绝。
// 接受走 /api/auth/organization/accept-invitation（cookie），token 作为 invitationId 由服务端 before-hook 换成邀请。
import { Button } from "@bianfa/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { acceptInvite, fetchInvitePreview, type InvitePreview, rejectInvite } from "../api.js";
import { authClient } from "../auth-client.js";
import { Notice } from "../components/Notice.js";
import { Card } from "../components/Shell.js";
import { StateView } from "../components/StateView.js";
import { describeFailure } from "../lib/errors.js";
import { loginPath, useSession } from "../lib/session.js";
import { navigate } from "../router.js";

type Preview =
  | { kind: "loading" }
  | { kind: "ok"; invitation: InvitePreview }
  | { kind: "invalid" }
  | { kind: "error"; message: string };
type Outcome = { kind: "none" } | { kind: "accepted"; org: string } | { kind: "rejected" };

export function Invite({ token }: { token: string }) {
  const { t } = useTranslation();
  const { user, pending, refetch } = useSession();
  const [preview, setPreview] = useState<Preview>({ kind: "loading" });
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });
  const [busy, setBusy] = useState<"accept" | "reject" | "switch" | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const inviteUrl = `/invite/${token}`;

  useEffect(() => {
    let alive = true;
    void fetchInvitePreview(token).then((res) => {
      if (!alive) return;
      if (res.ok) setPreview({ kind: "ok", invitation: res.data });
      else if (res.error.status === 404) setPreview({ kind: "invalid" });
      else setPreview({ kind: "error", message: describeFailure(res.error) });
    });
    return () => {
      alive = false;
    };
  }, [token]);

  async function accept() {
    setBusy("accept");
    setError(null);
    const res = await acceptInvite(token);
    setBusy(null);
    if (!res.ok) {
      if (res.error.code === "not_found") setPreview({ kind: "invalid" });
      else setError({ code: res.error.code, message: describeFailure(res.error) });
      return;
    }
    setOutcome({ kind: "accepted", org: res.data.organization?.name ?? "" });
  }

  async function reject() {
    setBusy("reject");
    setError(null);
    const res = await rejectInvite(token);
    setBusy(null);
    if (!res.ok) {
      if (res.error.code === "not_found") setPreview({ kind: "invalid" });
      else setError({ code: res.error.code, message: describeFailure(res.error) });
      return;
    }
    setOutcome({ kind: "rejected" });
  }

  async function switchAccount() {
    setBusy("switch");
    await authClient.signOut();
    await refetch();
    navigate(loginPath(inviteUrl));
  }

  const title = t("invite.title");

  if (preview.kind === "loading" || pending) {
    return (
      <Card title={title}>
        <StateView kind="loading" title={t("common.loading")} />
      </Card>
    );
  }
  if (preview.kind === "invalid") {
    return (
      <Card title={title}>
        <StateView kind="error" headline={t("invite.invalid")} title={t("invite.invalidDetail")} />
      </Card>
    );
  }
  if (preview.kind === "error") {
    return (
      <Card title={title}>
        <StateView
          kind="error"
          title={preview.message}
          actions={
            <Button variant="primary" size="lg" onClick={() => window.location.reload()}>
              {t("common.retry")}
            </Button>
          }
        />
      </Card>
    );
  }
  if (outcome.kind === "accepted") {
    return (
      <Card title={title}>
        <StateView
          kind="success"
          headline={t("invite.accepted", { org: outcome.org })}
          title={t("invite.acceptedDetail")}
          actions={
            <Button variant="primary" size="lg" onClick={() => navigate("/account")}>
              {t("verify.goAccount")}
            </Button>
          }
        />
      </Card>
    );
  }
  if (outcome.kind === "rejected") {
    return (
      <Card title={title}>
        <StateView kind="info" headline={t("invite.rejected")} title={t("invite.rejectedDetail")} />
      </Card>
    );
  }

  const inv = preview.invitation;
  const role = t(inv.role === "admin" ? "invite.roleAdmin" : "invite.roleMember");
  const summary = (
    <dl className="web-kv">
      <dt>{t("invite.org")}</dt>
      <dd>{inv.org_name}</dd>
      <dt>{t("invite.inviter")}</dt>
      <dd>{inv.inviter_name}</dd>
      <dt>{t("invite.role")}</dt>
      <dd>{role}</dd>
    </dl>
  );

  if (!user) {
    return (
      <Card title={title} description={t("invite.desc", { inviter: inv.inviter_name, org: inv.org_name })}>
        {summary}
        <p className="web-hint">{t("invite.loginHint")}</p>
        <div className="web-actions">
          <Button
            variant="primary"
            size="lg"
            className="web-btn-block"
            onClick={() => navigate(loginPath(inviteUrl))}
          >
            {t("invite.loginToAccept")}
          </Button>
          <Button
            size="lg"
            className="web-btn-block"
            onClick={() => navigate(`/signup?next=${encodeURIComponent(inviteUrl)}`)}
          >
            {t("invite.signupToAccept")}
          </Button>
        </div>
      </Card>
    );
  }

  const mismatch = error?.code === "invitation_email_mismatch";
  return (
    <Card title={title} description={t("invite.desc", { inviter: inv.inviter_name, org: inv.org_name })}>
      {error ? (
        <Notice
          kind="danger"
          action={
            mismatch ? (
              <Button size="sm" variant="ghost" onClick={() => void switchAccount()} busy={busy === "switch"}>
                {t("invite.switchAccount")}
              </Button>
            ) : null
          }
        >
          {error.message}
        </Notice>
      ) : null}
      {summary}
      <p className="web-hint">{t("invite.asAccount", { email: user.email })}</p>
      <div className="web-actions">
        <Button
          variant="primary"
          size="lg"
          className="web-btn-block"
          busy={busy === "accept"}
          disabled={busy !== null}
          onClick={() => void accept()}
          autoFocus
        >
          {t("invite.accept")}
        </Button>
        <Button
          size="lg"
          className="web-btn-block"
          busy={busy === "reject"}
          disabled={busy !== null}
          onClick={() => void reject()}
        >
          {t("invite.reject")}
        </Button>
      </div>
    </Card>
  );
}
