// /verify-email?token=（注册验证）与 /change-email?token=（换邮箱确认）：同一个 GET /verify-email 端点。
// 成功：autoSignInAfterVerification 已种 cookie → 可直接进账号；若注册时处于桌面端登录流程，提供「继续登录桌面端」。
import { Button } from "@bianfa/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { verifyEmailToken } from "../api.js";
import { Card } from "../components/Shell.js";
import { StateView } from "../components/StateView.js";
import { describeFailure } from "../lib/errors.js";
import { authorizeUrl, takeStashedAuthorize } from "../lib/oauth-query.js";
import { navigate, queryOf } from "../router.js";

type State =
  | { kind: "loading" }
  | { kind: "ok"; resume: string | null }
  | { kind: "expired" }
  | { kind: "invalid"; message: string };

export function VerifyEmail({ search, kind }: { search: string; kind: "verify" | "change" }) {
  const { t } = useTranslation();
  const token = queryOf(search).get("token");
  const [state, setState] = useState<State>(token ? { kind: "loading" } : { kind: "invalid", message: "" });

  useEffect(() => {
    if (!token) return;
    let alive = true;
    void verifyEmailToken(token).then((res) => {
      if (!alive) return;
      if (res.ok) {
        setState({ kind: "ok", resume: kind === "verify" ? takeStashedAuthorize() : null });
        return;
      }
      if (res.error.code === "TOKEN_EXPIRED") setState({ kind: "expired" });
      else setState({ kind: "invalid", message: describeFailure(res.error) });
    });
    return () => {
      alive = false;
    };
  }, [token, kind]);

  const title = kind === "change" ? t("verify.changeTitle") : t("verify.title");

  if (state.kind === "loading") {
    return (
      <Card title={title}>
        <StateView kind="loading" title={t("verify.verifying")} />
      </Card>
    );
  }
  if (state.kind === "ok") {
    return (
      <Card title={title}>
        <StateView
          kind="success"
          headline={kind === "change" ? t("verify.changeDone") : t("verify.done")}
          title={kind === "change" ? t("verify.changeDoneDetail") : t("verify.doneDetail")}
          actions={
            <>
              {state.resume ? (
                <a className="bf-btn bf-btn--primary bf-btn--lg" href={authorizeUrl(state.resume)}>
                  {t("verify.resumeDesktop")}
                </a>
              ) : null}
              <Button
                variant={state.resume ? "secondary" : "primary"}
                size="lg"
                onClick={() => navigate("/account")}
              >
                {t("verify.goAccount")}
              </Button>
            </>
          }
        />
      </Card>
    );
  }
  if (state.kind === "expired") {
    return (
      <Card title={title}>
        <StateView
          kind="error"
          headline={t("verify.expired")}
          title={t("verify.expiredDetail")}
          actions={
            <a className="bf-btn bf-btn--primary bf-btn--lg" href="/login">
              {t("common.backToLogin")}
            </a>
          }
        />
      </Card>
    );
  }
  return (
    <Card title={title}>
      <StateView
        kind="error"
        headline={t("verify.invalid")}
        title={state.message || t("verify.invalidDetail")}
        actions={
          <a className="bf-btn bf-btn--secondary bf-btn--lg" href="/login">
            {t("common.backToLogin")}
          </a>
        }
      />
    </Card>
  );
}
