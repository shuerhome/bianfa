// /reset-password?token=：新密码 + 确认；成功后其它会话已被撤销（revokeSessionsOnPasswordReset），引导重新登录
import { Button } from "@bianfa/ui";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../auth-client.js";
import { Field } from "../components/Field.js";
import { Notice } from "../components/Notice.js";
import { Card } from "../components/Shell.js";
import { StateView } from "../components/StateView.js";
import { describeFailure, toFailure } from "../lib/errors.js";
import { PASSWORD_MIN, passwordProblem } from "../lib/validation.js";
import { queryOf } from "../router.js";

export function ResetPassword({ search }: { search: string }) {
  const { t } = useTranslation();
  const token = queryOf(search).get("token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; confirm?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<"form" | "done" | "invalid">(token ? "form" : "invalid");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    const errs: typeof fieldErrors = {};
    const pw = passwordProblem(password);
    if (pw === "short") errs.password = t("validation.passwordShort", { min: PASSWORD_MIN });
    if (pw === "long") errs.password = t("validation.passwordLong");
    if (confirm !== password) errs.confirm = t("validation.passwordMismatch");
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.resetPassword({ newPassword: password, token });
      if (res.error) {
        const f = toFailure(res.error);
        if (f.code === "INVALID_TOKEN" || f.code === "TOKEN_EXPIRED") setState("invalid");
        else setError(describeFailure(f));
        return;
      }
      setState("done");
    } catch (err) {
      setError(describeFailure(toFailure(err)));
    } finally {
      setBusy(false);
    }
  }

  if (state === "invalid") {
    return (
      <Card title={t("reset.title")}>
        <StateView
          kind="error"
          title={t("reset.invalid")}
          detail={t("reset.invalidDetail")}
          actions={
            <a className="bf-btn bf-btn--primary bf-btn--lg" href="/forgot-password">
              {t("reset.requestAgain")}
            </a>
          }
        />
      </Card>
    );
  }

  if (state === "done") {
    return (
      <Card title={t("reset.title")}>
        <StateView
          kind="success"
          title={t("reset.done")}
          detail={t("reset.doneDetail")}
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
    <Card title={t("reset.title")} description={t("reset.desc")}>
      <form className="web-form" onSubmit={submit} noValidate>
        {error ? <Notice kind="danger">{error}</Notice> : null}
        <Field
          label={t("fields.newPassword")}
          type="password"
          name="password"
          autoComplete="new-password"
          autoFocus
          hint={t("validation.passwordHint", { min: PASSWORD_MIN })}
          value={password}
          error={fieldErrors.password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Field
          label={t("fields.confirmPassword")}
          type="password"
          name="confirm"
          autoComplete="new-password"
          value={confirm}
          error={fieldErrors.confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        <Button type="submit" variant="primary" size="lg" className="web-btn-block" busy={busy}>
          {t("reset.submit")}
        </Button>
      </form>
    </Card>
  );
}
