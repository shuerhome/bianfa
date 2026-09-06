// /device?user_code=：Device Authorization Grant 的浏览器侧（specs/04 §2.3）。
// 需登录；输入 8 位码 → GET /device 认领 → 显示客户端 / 权限 → 允许 / 拒绝 → 「可以回到桌面端了」。
import { Button } from "@bianfa/ui";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { approveDevice, claimDeviceCode, type DeviceClaim, denyDevice } from "../api.js";
import { Field } from "../components/Field.js";
import { Notice } from "../components/Notice.js";
import { Card } from "../components/Shell.js";
import { StateView } from "../components/StateView.js";
import { describeFailure } from "../lib/errors.js";
import { useRequireSession } from "../lib/session.js";
import { formatUserCode, normalizeUserCode, USER_CODE_LENGTH } from "../lib/validation.js";
import { queryOf } from "../router.js";

type Phase =
  | { kind: "enter" }
  | { kind: "review"; code: string; claim: DeviceClaim }
  | { kind: "approved" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "taken"; code: string };

const SCOPE_KEYS: Record<string, string> = {
  openid: "consent.scopeOpenid",
  profile: "consent.scopeProfile",
  email: "consent.scopeEmail",
  offline_access: "consent.scopeOffline",
};

export function Device({ search }: { search: string }) {
  const { t } = useTranslation();
  const prefill = queryOf(search).get("user_code") ?? "";
  const { user, pending } = useRequireSession(`/device${search}`);
  const [code, setCode] = useState(formatUserCode(prefill));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"claim" | "approve" | "deny" | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "enter" });

  if (pending || !user) {
    return (
      <Card title={t("device.title")}>
        <StateView kind="loading" title={t("common.loading")} />
      </Card>
    );
  }

  async function claim(e: FormEvent) {
    e.preventDefault();
    const normalized = normalizeUserCode(code);
    if (normalized.length !== USER_CODE_LENGTH) {
      setFieldError(t("device.codeInvalid", { n: USER_CODE_LENGTH }));
      return;
    }
    setFieldError(null);
    setError(null);
    setBusy("claim");
    const res = await claimDeviceCode(normalized);
    setBusy(null);
    if (!res.ok) {
      if (res.error.code === "expired_token") setPhase({ kind: "expired" });
      else if (res.error.code === "invalid_request") setFieldError(t("device.codeUnknown"));
      else setError(describeFailure(res.error));
      return;
    }
    const claim = res.data;
    if (claim.status === "approved") setPhase({ kind: "approved" });
    else if (claim.status === "denied") setPhase({ kind: "denied" });
    else if (!claim.client_id) setPhase({ kind: "taken", code: normalized });
    else setPhase({ kind: "review", code: normalized, claim });
  }

  async function decide(accept: boolean) {
    if (phase.kind !== "review") return;
    setBusy(accept ? "approve" : "deny");
    setError(null);
    const res = accept ? await approveDevice(phase.code) : await denyDevice(phase.code);
    setBusy(null);
    if (!res.ok) {
      if (res.error.code === "expired_token" || /expired/i.test(res.error.message))
        setPhase({ kind: "expired" });
      else setError(describeFailure(res.error));
      return;
    }
    setPhase({ kind: accept ? "approved" : "denied" });
  }

  if (phase.kind === "approved") {
    return (
      <Card title={t("device.title")}>
        <StateView kind="success" headline={t("device.approved")} title={t("device.approvedDetail")} />
      </Card>
    );
  }
  if (phase.kind === "denied") {
    return (
      <Card title={t("device.title")}>
        <StateView kind="info" headline={t("device.denied")} title={t("device.deniedDetail")} />
      </Card>
    );
  }
  if (phase.kind === "expired") {
    return (
      <Card title={t("device.title")}>
        <StateView
          kind="error"
          headline={t("device.expired")}
          title={t("device.expiredDetail")}
          actions={
            <Button variant="primary" size="lg" onClick={() => setPhase({ kind: "enter" })}>
              {t("device.enterAnother")}
            </Button>
          }
        />
      </Card>
    );
  }
  if (phase.kind === "taken") {
    return (
      <Card title={t("device.title")}>
        <StateView
          kind="error"
          headline={t("device.taken")}
          title={t("device.takenDetail")}
          actions={
            <Button variant="primary" size="lg" onClick={() => setPhase({ kind: "enter" })}>
              {t("device.enterAnother")}
            </Button>
          }
        />
      </Card>
    );
  }
  if (phase.kind === "review") {
    const clientName =
      phase.claim.client_id === "bianfa-desktop" ? t("consent.desktopClient") : phase.claim.client_id;
    const scopes = (phase.claim.scope ?? "").split(" ").filter(Boolean);
    return (
      <Card
        title={t("device.reviewTitle")}
        description={t("device.reviewDesc", { client: clientName ?? "" })}
      >
        {error ? <Notice kind="danger">{error}</Notice> : null}
        <dl className="web-kv">
          <dt>{t("device.code")}</dt>
          <dd className="web-mono">{formatUserCode(phase.code)}</dd>
          <dt>{t("consent.account")}</dt>
          <dd>{user.email}</dd>
          <dt>{t("consent.scopes")}</dt>
          <dd>
            <ul className="web-list">
              {scopes.map((s) => (
                <li key={s}>{SCOPE_KEYS[s] ? t(SCOPE_KEYS[s]) : s}</li>
              ))}
            </ul>
          </dd>
        </dl>
        <p className="web-hint">{t("device.reviewHint")}</p>
        <div className="web-actions">
          <Button
            variant="primary"
            size="lg"
            className="web-btn-block"
            busy={busy === "approve"}
            disabled={busy !== null}
            onClick={() => void decide(true)}
            autoFocus
          >
            {t("device.allow")}
          </Button>
          <Button
            size="lg"
            className="web-btn-block"
            busy={busy === "deny"}
            disabled={busy !== null}
            onClick={() => void decide(false)}
          >
            {t("device.deny")}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card title={t("device.title")} description={t("device.desc")}>
      <form className="web-form" onSubmit={claim} noValidate>
        {error ? <Notice kind="danger">{error}</Notice> : null}
        <Field
          label={t("device.code")}
          name="user_code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          autoFocus
          placeholder="XXXX-XXXX"
          maxLength={USER_CODE_LENGTH + 1}
          value={code}
          error={fieldError}
          inputClassName="web-code-input"
          onChange={(e) => setCode(formatUserCode(e.target.value))}
        />
        <Button type="submit" variant="primary" size="lg" className="web-btn-block" busy={busy === "claim"}>
          {t("device.continue")}
        </Button>
      </form>
      <p className="web-hint web-hint--center">{t("device.signedInAs", { email: user.email })}</p>
    </Card>
  );
}
