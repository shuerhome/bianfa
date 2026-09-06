// 修改安全码对话框（设置 → 账号）：当前密码 + 新安全码 + 确认 → POST /v1/me/security-code（api/me.ts changeSecurityCode）。
// 本地先校验（4–32、≠ 密码、两次一致）；服务端 403 invalid_password / 400 security_code_equals_password / 409 no_password 映射成文案。
import { Button, Dialog } from "@bianfa/ui";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { API_ERROR, isApiError } from "../../api/http.js";
import { changeSecurityCode, SECURITY_CODE_MAX, SECURITY_CODE_MIN } from "../../api/me.js";
import { describeError } from "../../ipc/errors.js";

export interface SecurityCodeDialogProps {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}

export function SecurityCodeDialog({ open, onClose, onChanged }: SecurityCodeDialogProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setPassword("");
      setCode("");
      setConfirm("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  function localProblem(): string | null {
    const trimmed = code.trim();
    if (!password) return t("settings.securityCodePasswordRequired");
    if (trimmed.length < SECURITY_CODE_MIN || trimmed.length > SECURITY_CODE_MAX)
      return t("settings.securityCodeLength", { min: SECURITY_CODE_MIN, max: SECURITY_CODE_MAX });
    if (trimmed === password) return t("settings.securityCodeSamePassword");
    if (confirm.trim() !== trimmed) return t("settings.securityCodeMismatch");
    return null;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = localProblem();
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changeSecurityCode({ password, newSecurityCode: code });
      onChanged();
    } catch (err) {
      if (isApiError(err, API_ERROR.invalidPassword)) setError(t("settings.securityCodeWrongPassword"));
      else if (isApiError(err, API_ERROR.securityCodeEqualsPassword))
        setError(t("settings.securityCodeSamePassword"));
      else if (isApiError(err, API_ERROR.noPassword)) setError(t("settings.securityCodeNoPassword"));
      else setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("settings.securityCodeDialogTitle")}
      description={t("settings.securityCodeDialogDesc")}
      closeLabel={t("common.close")}
    >
      <form className="security-code-form" onSubmit={(e) => void submit(e)}>
        <div className="settings-row settings-row--stack">
          <label htmlFor="security-code-password" className="settings-label">
            {t("settings.securityCodeCurrentPassword")}
          </label>
          <input
            id="security-code-password"
            className="bf-input"
            type="password"
            autoComplete="current-password"
            data-autofocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="settings-row settings-row--stack">
          <label htmlFor="security-code-new" className="settings-label">
            {t("settings.securityCodeNew")}
          </label>
          <input
            id="security-code-new"
            className="bf-input"
            type="password"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <p className="settings-hint">
            {t("settings.securityCodeRule", { min: SECURITY_CODE_MIN, max: SECURITY_CODE_MAX })}
          </p>
        </div>
        <div className="settings-row settings-row--stack">
          <label htmlFor="security-code-confirm" className="settings-label">
            {t("settings.securityCodeConfirm")}
          </label>
          <input
            id="security-code-confirm"
            className="bf-input"
            type="password"
            autoComplete="off"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        {error ? (
          <p className="settings-warning" role="alert">
            {error}
          </p>
        ) : null}
        <div className="bf-dialog__footer">
          <Button variant="ghost" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" busy={busy}>
            {t("settings.securityCodeSave")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
