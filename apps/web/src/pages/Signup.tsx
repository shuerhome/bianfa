// /signup：注册后不自动登录（requireEmailVerification）；提示查收验证邮件，可重发。
import { Button } from "@bianfa/ui";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { resendVerification } from "../api.js";
import { authClient } from "../auth-client.js";
import { Field } from "../components/Field.js";
import { Notice } from "../components/Notice.js";
import { Card } from "../components/Shell.js";
import { StateView } from "../components/StateView.js";
import { describeFailure, toFailure } from "../lib/errors.js";
import { readOAuthContext, stashAuthorize } from "../lib/oauth-query.js";
import { isValidEmail, normalizeEmail, PASSWORD_MIN, passwordProblem } from "../lib/validation.js";
import { queryOf } from "../router.js";

export function Signup({ search }: { search: string }) {
  const { t } = useTranslation();
  const params = queryOf(search);
  const oauth = readOAuthContext(search);
  const [name, setName] = useState("");
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string; password?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: typeof fieldErrors = {};
    if (!name.trim()) errs.name = t("validation.nameRequired");
    if (!isValidEmail(email)) errs.email = t("validation.email");
    const pw = passwordProblem(password);
    if (pw === "short") errs.password = t("validation.passwordShort", { min: PASSWORD_MIN });
    if (pw === "long") errs.password = t("validation.passwordLong");
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const normalized = normalizeEmail(email);
      const res = await authClient.signUp.email({ name: name.trim(), email: normalized, password });
      if (res.error) {
        setError(describeFailure(toFailure(res.error)));
        return;
      }
      if (oauth) stashAuthorize(oauth);
      setDone(normalized);
    } catch (err) {
      setError(describeFailure(toFailure(err)));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!done) return;
    setBusy(true);
    const res = await resendVerification(done);
    setBusy(false);
    if (!res.ok) setError(describeFailure(res.error));
    else setResent(true);
  }

  if (done) {
    return (
      <Card title={t("signup.checkMailTitle")}>
        {error ? <Notice kind="danger">{error}</Notice> : null}
        <StateView
          kind="success"
          title={t("signup.checkMail", { email: done })}
          detail={t("signup.checkMailDetail")}
          actions={
            <Button size="lg" onClick={() => void resend()} busy={busy} disabled={resent}>
              {resent ? t("login.resent") : t("login.resend")}
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <Card title={t("signup.title")} description={t("signup.desc")}>
      <form className="web-form" onSubmit={submit} noValidate>
        {error ? <Notice kind="danger">{error}</Notice> : null}
        <Field
          label={t("fields.name")}
          name="name"
          autoComplete="name"
          autoFocus
          value={name}
          error={fieldErrors.name}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label={t("fields.email")}
          type="email"
          name="email"
          autoComplete="username"
          value={email}
          error={fieldErrors.email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label={t("fields.password")}
          type="password"
          name="password"
          autoComplete="new-password"
          hint={t("validation.passwordHint", { min: PASSWORD_MIN })}
          value={password}
          error={fieldErrors.password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" variant="primary" size="lg" className="web-btn-block" busy={busy}>
          {t("signup.submit")}
        </Button>
      </form>
      <div className="web-links">
        <span />
        <a href={`/login${search}`}>{t("signup.haveAccount")}</a>
      </div>
    </Card>
  );
}
