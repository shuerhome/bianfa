// /forgot-password：响应恒定文案（不泄露邮箱是否存在）；服务端限流 3/h/email
import { Button } from "@bianfa/ui";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../auth-client.js";
import { Field } from "../components/Field.js";
import { Notice } from "../components/Notice.js";
import { Card } from "../components/Shell.js";
import { StateView } from "../components/StateView.js";
import { describeFailure, toFailure } from "../lib/errors.js";
import { isValidEmail, normalizeEmail } from "../lib/validation.js";

export function ForgotPassword() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!isValidEmail(email)) {
      setFieldError(t("validation.email"));
      return;
    }
    setFieldError(null);
    setBusy(true);
    setError(null);
    try {
      // 1.7：/request-password-reset（/forget-password 为旧名）；redirectTo 不传，链接由服务端拼 ${APP_ORIGIN}/reset-password?token=
      const res = await authClient.requestPasswordReset({ email: normalizeEmail(email) });
      if (res.error) {
        const f = toFailure(res.error);
        // 只有限流 / 网络问题才提示；其它情况一律显示恒定成功文案
        if (f.status === 429 || f.code === "network") {
          setError(describeFailure(f));
          return;
        }
      }
      setDone(true);
    } catch (err) {
      setError(describeFailure(toFailure(err)));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Card title={t("forgot.title")}>
        <StateView
          kind="success"
          title={t("forgot.sent")}
          detail={t("forgot.sentDetail")}
          actions={
            <a className="bf-btn bf-btn--secondary bf-btn--lg" href="/login">
              {t("common.backToLogin")}
            </a>
          }
        />
      </Card>
    );
  }

  return (
    <Card title={t("forgot.title")} description={t("forgot.desc")}>
      <form className="web-form" onSubmit={submit} noValidate>
        {error ? <Notice kind="danger">{error}</Notice> : null}
        <Field
          label={t("fields.email")}
          type="email"
          name="email"
          autoComplete="username"
          autoFocus
          value={email}
          error={fieldError}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="submit" variant="primary" size="lg" className="web-btn-block" busy={busy}>
          {t("forgot.submit")}
        </Button>
      </form>
      <div className="web-links">
        <a href="/login">{t("common.backToLogin")}</a>
        <span />
      </div>
    </Card>
  );
}
