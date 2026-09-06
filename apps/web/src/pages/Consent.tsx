// /consent?…（签名后的授权参数）：bianfa-desktop 是 skip_consent 的第一方客户端，正常不会到这里；
// 只有 prompt=consent 或客户端配置漂移时出现。一键「允许」→ POST /oauth2/consent → { redirect: true, url } → 整页跳回桌面端 loopback。
import { Button } from "@bianfa/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { submitConsent } from "../api.js";
import { Notice } from "../components/Notice.js";
import { Card } from "../components/Shell.js";
import { StateView } from "../components/StateView.js";
import { describeFailure } from "../lib/errors.js";
import { leaveTo } from "../lib/external.js";
import { readOAuthContext, redirectTarget } from "../lib/oauth-query.js";
import { useSession } from "../lib/session.js";
import { navigate } from "../router.js";

const SCOPE_KEYS: Record<string, string> = {
  openid: "consent.scopeOpenid",
  profile: "consent.scopeProfile",
  email: "consent.scopeEmail",
  offline_access: "consent.scopeOffline",
};

export function Consent({ search }: { search: string }) {
  const { t } = useTranslation();
  const ctx = readOAuthContext(search);
  const { user, pending } = useSession();
  const [busy, setBusy] = useState<"accept" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!ctx) {
    return (
      <Card title={t("consent.title")}>
        <StateView kind="error" title={t("consent.missing")} detail={t("consent.missingDetail")} />
      </Card>
    );
  }
  if (pending) {
    return (
      <Card title={t("consent.title")}>
        <StateView kind="loading" title={t("common.loading")} />
      </Card>
    );
  }
  if (!user) {
    // 带着同一份签名参数去登录；登录成功后服务端会重新走 authorize（再次判断是否需要同意）
    navigate(`/login${search}`, { replace: true });
    return null;
  }

  async function decide(accept: boolean) {
    setBusy(accept ? "accept" : "deny");
    setError(null);
    const res = await submitConsent(accept);
    if (!res.ok) {
      setBusy(null);
      setError(describeFailure(res.error));
      return;
    }
    const target = redirectTarget(res.data);
    if (target) {
      setDone(true);
      leaveTo(target);
      return;
    }
    setBusy(null);
    setError(t("errors.generic"));
  }

  const clientName = ctx.clientId === "bianfa-desktop" ? t("consent.desktopClient") : ctx.clientId;

  if (done) {
    return (
      <Card title={t("consent.title")}>
        <StateView kind="success" headline={t("consent.returning")} title={t("consent.returningDetail")} />
      </Card>
    );
  }

  return (
    <Card title={t("consent.title")} description={t("consent.desc", { client: clientName })}>
      {error ? <Notice kind="danger">{error}</Notice> : null}
      <dl className="web-kv">
        <dt>{t("consent.account")}</dt>
        <dd>{user.email}</dd>
        <dt>{t("consent.scopes")}</dt>
        <dd>
          <ul className="web-list">
            {ctx.scopes.map((s) => (
              <li key={s}>{SCOPE_KEYS[s] ? t(SCOPE_KEYS[s]) : s}</li>
            ))}
          </ul>
        </dd>
      </dl>
      <div className="web-actions">
        <Button
          variant="primary"
          size="lg"
          className="web-btn-block"
          busy={busy === "accept"}
          disabled={busy !== null}
          onClick={() => void decide(true)}
          autoFocus
        >
          {t("consent.allow", { client: clientName })}
        </Button>
        <Button
          size="lg"
          className="web-btn-block"
          busy={busy === "deny"}
          disabled={busy !== null}
          onClick={() => void decide(false)}
        >
          {t("consent.deny")}
        </Button>
      </div>
    </Card>
  );
}
