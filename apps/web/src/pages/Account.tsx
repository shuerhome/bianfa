// /account：最小账号页（邮箱、姓名、邮箱验证状态、退出登录、下载桌面端）。设备列表在 /v1（仅 Bearer），不在 Web 面。
import { Button } from "@bianfa/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchWebConfig, resendVerification } from "../api.js";
import { authClient } from "../auth-client.js";
import { Notice } from "../components/Notice.js";
import { Card } from "../components/Shell.js";
import { StateView } from "../components/StateView.js";
import { describeFailure, toFailure } from "../lib/errors.js";
import { useRequireSession } from "../lib/session.js";
import { navigate } from "../router.js";

export function Account() {
  const { t } = useTranslation();
  const { user, pending } = useRequireSession("/account");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"signout" | "resend" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchWebConfig().then((c) => {
      if (alive) setDownloadUrl(c.download_url);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (pending || !user) {
    return (
      <Card title={t("account.title")}>
        <StateView kind="loading" title={t("common.loading")} />
      </Card>
    );
  }

  async function signOut() {
    setBusy("signout");
    setError(null);
    try {
      const res = await authClient.signOut();
      if (res.error) {
        setError(describeFailure(toFailure(res.error)));
        setBusy(null);
        return;
      }
      navigate("/login", { replace: true });
    } catch (err) {
      setError(describeFailure(toFailure(err)));
      setBusy(null);
    }
  }

  async function resend() {
    if (!user) return;
    setBusy("resend");
    const res = await resendVerification(user.email);
    setBusy(null);
    if (!res.ok) setError(describeFailure(res.error));
    else setResent(true);
  }

  return (
    <Card title={t("account.title")} description={t("account.desc")}>
      {error ? <Notice kind="danger">{error}</Notice> : null}
      {!user.emailVerified ? (
        <Notice
          kind="warning"
          action={
            resent ? null : (
              <Button size="sm" variant="ghost" onClick={() => void resend()} busy={busy === "resend"}>
                {t("login.resend")}
              </Button>
            )
          }
        >
          {resent ? t("login.resent") : t("account.unverified")}
        </Notice>
      ) : null}
      <dl className="web-kv">
        <dt>{t("fields.email")}</dt>
        <dd>{user.email}</dd>
        <dt>{t("fields.name")}</dt>
        <dd>{user.name}</dd>
      </dl>
      <div className="web-actions">
        {downloadUrl ? (
          <a className="bf-btn bf-btn--primary bf-btn--lg web-btn-block" href={downloadUrl}>
            {t("account.download")}
          </a>
        ) : (
          <p className="web-hint">{t("account.desktopHint")}</p>
        )}
        <Button size="lg" className="web-btn-block" busy={busy === "signout"} onClick={() => void signOut()}>
          {t("account.signOut")}
        </Button>
      </div>
    </Card>
  );
}
