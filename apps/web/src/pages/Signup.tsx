// /signup：邮箱（只是登录标识，不验证）+ 密码 + 安全码（只在忘记密码时使用）。注册即登录（服务端 autoSignIn）：
// 处于桌面端授权流程时服务端直接返回 { redirect: true, url }（oauth_query 由 fetch 插件附带）整页跳回 loopback，
// 没拿到 redirect 就自己重新发起 authorize；否则回 next / /account。没有「去邮箱验证」这一步。
import { Button } from "@bianfa/ui";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../auth-client.js";
import { Field } from "../components/Field.js";
import { Notice } from "../components/Notice.js";
import { Card } from "../components/Shell.js";
import { describeFailure, toFailure } from "../lib/errors.js";
import { leaveTo } from "../lib/external.js";
import { authorizeUrl, readOAuthContext, redirectTarget } from "../lib/oauth-query.js";
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
import { navigate, queryOf, safeNext } from "../router.js";

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
  securityCode?: string;
  confirmSecurityCode?: string;
}

export function Signup({ search }: { search: string }) {
  const { t } = useTranslation();
  const params = queryOf(search);
  const next = safeNext(params.get("next")) ?? "/account";
  const oauth = readOAuthContext(search);
  const [name, setName] = useState("");
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [securityCode, setSecurityCode] = useState("");
  const [confirmSecurityCode, setConfirmSecurityCode] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function validate(): FieldErrors {
    const errs: FieldErrors = {};
    if (!name.trim()) errs.name = t("validation.nameRequired");
    if (!isValidEmail(email)) errs.email = t("validation.email");
    const pw = passwordProblem(password);
    if (pw === "short") errs.password = t("validation.passwordShort", { min: PASSWORD_MIN });
    if (pw === "long") errs.password = t("validation.passwordLong");
    if (confirmPassword !== password) errs.confirmPassword = t("validation.passwordMismatch");
    const code = securityCodeProblem(securityCode, password);
    if (code === "required") errs.securityCode = t("validation.securityCodeRequired");
    if (code === "short") errs.securityCode = t("validation.securityCodeShort", { min: SECURITY_CODE_MIN });
    if (code === "long") errs.securityCode = t("validation.securityCodeLong", { max: SECURITY_CODE_MAX });
    if (code === "same_as_password") errs.securityCode = t("validation.securityCodeSamePassword");
    if (normalizeSecurityCode(confirmSecurityCode) !== normalizeSecurityCode(securityCode))
      errs.confirmSecurityCode = t("validation.securityCodeMismatch");
    return errs;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.signUp.email({
        name: name.trim(),
        email: normalizeEmail(email),
        password,
        securityCode: normalizeSecurityCode(securityCode),
      });
      if (res.error) {
        setError(describeFailure(toFailure(res.error)));
        return;
      }
      // 桌面端授权流程：服务端在注册响应里直接给出回跳 loopback 的 url；没有就带着新会话重新 authorize
      const target = redirectTarget(res.data);
      if (target) {
        leaveTo(target);
        return;
      }
      if (oauth) {
        leaveTo(authorizeUrl(oauth.authorizeQuery));
        return;
      }
      navigate(next, { replace: true });
    } catch (err) {
      setError(describeFailure(toFailure(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t("signup.title")} description={oauth ? t("signup.desktopDesc") : t("signup.desc")}>
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
        <Field
          label={t("fields.passwordConfirm")}
          type="password"
          name="confirmPassword"
          autoComplete="new-password"
          value={confirmPassword}
          error={fieldErrors.confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
        />
        <Field
          label={t("fields.securityCode")}
          type="password"
          name="securityCode"
          autoComplete="off"
          hint={t("validation.securityCodeHint", { min: SECURITY_CODE_MIN, max: SECURITY_CODE_MAX })}
          value={securityCode}
          error={fieldErrors.securityCode}
          onChange={(e) => setSecurityCode(e.target.value)}
        />
        <Field
          label={t("fields.confirmSecurityCode")}
          type="password"
          name="confirmSecurityCode"
          autoComplete="off"
          value={confirmSecurityCode}
          error={fieldErrors.confirmSecurityCode}
          onChange={(e) => setConfirmSecurityCode(e.target.value)}
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
