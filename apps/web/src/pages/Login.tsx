// /login：邮箱密码登录（邮箱不需要验证）；Google / Apple 按钮按 /web-config.json；桌面端 OAuth 流程（URL 带 sig）登录成功后
// 服务端直接返回 { redirect: true, url: http://127.0.0.1:<port>/cb?code=… }，页面整页跳过去；否则回 next / /account。
// 「忘记密码」把 search 原样带去 /forgot-password（安全码重置后能接着回桌面端流程）。
import { Button } from "@bianfa/ui";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchWebConfig, verifyTotp, type WebConfig } from "../api.js";
import { authClient } from "../auth-client.js";
import { Field } from "../components/Field.js";
import { Notice } from "../components/Notice.js";
import { Card } from "../components/Shell.js";
import { SocialButtons } from "../components/SocialButtons.js";
import { describeFailure, toFailure } from "../lib/errors.js";
import { leaveTo } from "../lib/external.js";
import { readOAuthContext, redirectTarget } from "../lib/oauth-query.js";
import { useSession } from "../lib/session.js";
import { isValidEmail, normalizeEmail } from "../lib/validation.js";
import { navigate, queryOf, safeNext } from "../router.js";

type Step = "credentials" | "totp";

export function Login({ search }: { search: string }) {
  const { t } = useTranslation();
  const params = queryOf(search);
  const next = safeNext(params.get("next")) ?? "/account";
  const oauth = readOAuthContext(search);
  const { user, pending } = useSession();
  const [config, setConfig] = useState<WebConfig | null>(null);
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [error, setError] = useState<string | null>(
    params.get("error") === "social" ? t("errors.social") : null,
  );
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>("credentials");
  const [totp, setTotp] = useState("");

  useEffect(() => {
    let alive = true;
    void fetchWebConfig().then((c) => {
      if (alive) setConfig(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 已登录且不在桌面端授权流程里（authorize 会自己处理已登录，只有 prompt=login 才会带着会话到这里）→ 直接去目的地
  useEffect(() => {
    if (!pending && user && !oauth) navigate(next, { replace: true });
  }, [pending, user, oauth, next]);

  function finish(data: unknown) {
    const target = redirectTarget(data);
    if (target) {
      leaveTo(target);
      return;
    }
    navigate(next, { replace: true });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: { email?: string; password?: string } = {};
    if (!isValidEmail(email)) errs.email = t("validation.email");
    if (!password) errs.password = t("validation.passwordRequired");
    setFieldErrors(errs);
    if (errs.email || errs.password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.signIn.email({ email: normalizeEmail(email), password, rememberMe: true });
      if (res.error) {
        setError(describeFailure(toFailure(res.error)));
        return;
      }
      const data = res.data as unknown as { twoFactorRedirect?: boolean } | null;
      if (data?.twoFactorRedirect) {
        setStep("totp");
        return;
      }
      finish(res.data);
    } catch (err) {
      setError(describeFailure(toFailure(err)));
    } finally {
      setBusy(false);
    }
  }

  async function submitTotp(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(totp.trim())) {
      setError(t("validation.totp"));
      return;
    }
    setBusy(true);
    setError(null);
    const res = await verifyTotp(totp.trim());
    setBusy(false);
    if (!res.ok) {
      setError(describeFailure(res.error));
      return;
    }
    finish(res.data);
  }

  if (step === "totp") {
    return (
      <Card title={t("login.totpTitle")} description={t("login.totpDesc")}>
        <form className="web-form" onSubmit={submitTotp} noValidate>
          {error ? <Notice kind="danger">{error}</Notice> : null}
          <Field
            label={t("login.totpLabel")}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
            inputClassName="web-code-input"
          />
          <Button type="submit" variant="primary" size="lg" className="web-btn-block" busy={busy}>
            {t("login.totpSubmit")}
          </Button>
          <Button type="button" variant="ghost" size="md" onClick={() => setStep("credentials")}>
            {t("common.back")}
          </Button>
        </form>
      </Card>
    );
  }

  return (
    <Card title={t("login.title")} description={oauth ? t("login.desktopDesc") : t("login.desc")}>
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
          label={t("fields.password")}
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          error={fieldErrors.password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" variant="primary" size="lg" className="web-btn-block" busy={busy}>
          {t("login.submit")}
        </Button>
        <SocialButtons providers={config?.providers ?? []} callbackURL={next} onError={(m) => setError(m)} />
      </form>
      <div className="web-links">
        <a href={`/forgot-password${search}`}>{t("login.forgot")}</a>
        <a href={`/signup${search}`}>{t("login.signup")}</a>
      </div>
    </Card>
  );
}
