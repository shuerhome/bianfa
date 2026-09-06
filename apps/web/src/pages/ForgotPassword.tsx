// /forgot-password：邮箱 + 安全码 + 新密码 → POST /v1/auth/reset-with-code（不经邮件）。
// 成功后所有设备 / 会话已退出，给「去登录」按钮；search（桌面端授权参数 / next）原样带到 /login，桌面端流程能接着走。
import { Button } from "@bianfa/ui";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { resetPasswordWithCode } from "../api.js";
import { Field } from "../components/Field.js";
import { Notice } from "../components/Notice.js";
import { Card } from "../components/Shell.js";
import { StateView } from "../components/StateView.js";
import { describeFailure } from "../lib/errors.js";
import {
  isValidEmail,
  normalizeEmail,
  normalizeSecurityCode,
  PASSWORD_MIN,
  passwordProblem,
  SECURITY_CODE_MAX,
  SECURITY_CODE_MIN,
  securityCodeProblem,
} from "../lib/validation.js";

interface FieldErrors {
  email?: string;
  securityCode?: string;
  password?: string;
  confirm?: string;
}

export function ForgotPassword({ search }: { search: string }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [securityCode, setSecurityCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  function validate(): FieldErrors {
    const errs: FieldErrors = {};
    if (!isValidEmail(email)) errs.email = t("validation.email");
    const code = securityCodeProblem(securityCode, password);
    if (code === "required") errs.securityCode = t("validation.securityCodeRequired");
    if (code === "short") errs.securityCode = t("validation.securityCodeShort", { min: SECURITY_CODE_MIN });
    if (code === "long") errs.securityCode = t("validation.securityCodeLong", { max: SECURITY_CODE_MAX });
    if (code === "same_as_password") errs.password = t("validation.passwordSameAsSecurityCode");
    const pw = passwordProblem(password);
    if (pw === "short") errs.password = t("validation.passwordShort", { min: PASSWORD_MIN });
    if (pw === "long") errs.password = t("validation.passwordLong");
    if (confirm !== password) errs.confirm = t("validation.passwordMismatch");
    return errs;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    setError(null);
    const res = await resetPasswordWithCode({
      email: normalizeEmail(email),
      securityCode: normalizeSecurityCode(securityCode),
      newPassword: password,
    });
    setBusy(false);
    if (!res.ok) {
      setError(describeFailure(res.error));
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <Card title={t("forgot.title")}>
        <StateView
          kind="success"
          title={t("forgot.done")}
          detail={t("forgot.doneDetail")}
          actions={
            <a className="bf-btn bf-btn--primary bf-btn--lg" href={`/login${search}`}>
              {t("forgot.goLogin")}
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
          error={fieldErrors.email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label={t("fields.securityCode")}
          type="password"
          name="securityCode"
          autoComplete="off"
          hint={t("forgot.codeHint")}
          value={securityCode}
          error={fieldErrors.securityCode}
          onChange={(e) => setSecurityCode(e.target.value)}
        />
        <Field
          label={t("fields.newPassword")}
          type="password"
          name="password"
          autoComplete="new-password"
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
          {t("forgot.submit")}
        </Button>
      </form>
      <div className="web-links">
        <a href={`/login${search}`}>{t("common.backToLogin")}</a>
        <span />
      </div>
    </Card>
  );
}
