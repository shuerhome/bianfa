// 账号 / 同步（specs/06 §4.4–4.5、4.8）：登录等待态（20s 复制链接 / 60s 验证码降级 / 120s 失败）、退出、同步错误列表。
import { Button } from "@bianfa/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  authLoginCancel,
  authLoginDeviceStart,
  authLoginStart,
  authLogout,
  authStatus,
  notesPendingSync,
  openExternal,
  syncErrorsList,
} from "../../../ipc/commands.js";
import { useTauriEvent } from "../../../ipc/events.js";
import type { LoginPhase } from "../../../ipc/types.js";
import { queryKeys } from "../../../lib/query.js";
import { relativeTime } from "../../../lib/time.js";

type LoginUi =
  | { phase: "idle" }
  | { phase: "waiting"; authUrl: string; startedAt: number }
  | { phase: "device"; userCode: string; verificationUrl: string }
  | { phase: "failed" }
  | { phase: "done" };

export function AccountSection() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const auth = useQuery({ queryKey: queryKeys.auth, queryFn: authStatus, retry: false });
  const errors = useQuery({ queryKey: queryKeys.syncErrors, queryFn: syncErrorsList, retry: false });
  const pending = useQuery({ queryKey: queryKeys.pendingSync, queryFn: notesPendingSync, retry: false });
  const [login, setLogin] = useState<LoginUi>({ phase: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<number | null>(null);

  useTauriEvent("auth:changed", (a) => {
    client.setQueryData(queryKeys.auth, a);
    if (a.loggedIn) {
      setLogin({ phase: "done" });
      window.setTimeout(() => setLogin({ phase: "idle" }), 700);
    }
  });
  useTauriEvent("auth:login-progress", (p) => {
    const phase: LoginPhase = p.phase;
    if (phase === "failed") setLogin({ phase: "failed" });
    if (phase === "device-fallback") void startDevice();
  });
  useTauriEvent("db:changed", () => void errors.refetch());

  useEffect(() => {
    if (login.phase !== "waiting") {
      if (timer.current !== null) window.clearInterval(timer.current);
      timer.current = null;
      return;
    }
    const startedAt = login.startedAt;
    timer.current = window.setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      setElapsed(s);
      if (s >= 120) setLogin({ phase: "failed" });
    }, 1000);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [login]);

  const startLogin = async () => {
    try {
      const res = await authLoginStart();
      setElapsed(0);
      setLogin({ phase: "waiting", authUrl: res.authUrl, startedAt: Date.now() });
    } catch {
      setLogin({ phase: "failed" });
    }
  };
  const startDevice = async () => {
    try {
      await authLoginCancel().catch(() => undefined);
      const res = await authLoginDeviceStart();
      setLogin({ phase: "device", userCode: res.userCode, verificationUrl: res.verificationUrl });
    } catch {
      setLogin({ phase: "failed" });
    }
  };
  const cancel = () => {
    void authLoginCancel().catch(() => undefined);
    setLogin({ phase: "idle" });
  };

  const user = auth.data?.user ?? null;

  return (
    <section className="settings-section" aria-labelledby="sec-account">
      <h2 id="sec-account" className="settings-section__title">
        {t("settings.account")}
      </h2>
      {auth.data?.loggedIn && user ? (
        <div className="account-card">
          <div className="account-avatar" aria-hidden="true">
            {user.image ? (
              <img src={user.image} alt="" />
            ) : (
              (user.name ?? user.email).slice(0, 1).toUpperCase()
            )}
          </div>
          <div className="account-card__text">
            <div className="account-card__name">{user.name ?? user.email}</div>
            <div className="account-card__email">{user.email}</div>
          </div>
          <Button
            variant="danger-secondary"
            size="sm"
            onClick={() => {
              if (window.confirm(t("settings.logoutConfirm")))
                void authLogout(false).then(() => auth.refetch());
            }}
          >
            {t("settings.logout")}
          </Button>
        </div>
      ) : (
        <div className="login-panel">
          {login.phase === "idle" || login.phase === "failed" ? (
            <>
              <p className="settings-hint">{t("settings.loginHint")}</p>
              {login.phase === "failed" ? <p className="settings-warning">{t("login.failed")}</p> : null}
              <div className="settings-inline">
                <Button variant="primary" icon="log-in" onClick={() => void startLogin()}>
                  {login.phase === "failed" ? t("common.retry") : t("settings.login")}
                </Button>
                {login.phase === "failed" ? (
                  <Button variant="ghost" onClick={() => void startDevice()}>
                    {t("login.otherWay")}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
          {login.phase === "waiting" ? (
            <div className="login-waiting" aria-live="polite">
              <div className="login-pill">
                <span className="login-spinner" aria-hidden="true">
                  ◌
                </span>
                {t("login.openedInBrowser")}
              </div>
              <p className="settings-hint">{t("login.finishInBrowser")}</p>
              <button
                type="button"
                className="login-link"
                onClick={() => void navigator.clipboard.writeText(login.authUrl)}
              >
                {t("login.copyLink")}
              </button>
              {elapsed >= 20 ? (
                <>
                  <hr className="login-sep" />
                  <button type="button" className="login-link" onClick={() => void startDevice()}>
                    {t("login.useDeviceCode")}
                  </button>
                </>
              ) : null}
              <Button variant="ghost" size="sm" onClick={cancel}>
                {t("common.cancel")}
              </Button>
            </div>
          ) : null}
          {login.phase === "device" ? (
            <div className="login-device">
              <p>{t("login.deviceInstruction")}</p>
              <div className="login-code tabular">{login.userCode}</div>
              <div className="settings-inline">
                <Button variant="primary" onClick={() => void openExternal(login.verificationUrl)}>
                  {t("login.openVerify")}
                </Button>
                <Button variant="ghost" onClick={cancel}>
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          ) : null}
          {login.phase === "done" ? (
            <div className="login-pill login-pill--ok">
              ✓ {t("login.welcomeBack", { name: user?.name ?? "" })}
            </div>
          ) : null}
        </div>
      )}

      <h3 className="settings-subtitle">{t("settings.sync")}</h3>
      <p className="settings-hint">
        {auth.data?.loggedIn
          ? t("settings.pendingUpload", { count: pending.data?.length ?? 0 })
          : t("sync.localMode")}
      </p>
      {(errors.data?.length ?? 0) > 0 ? (
        <ul className="sync-errors">
          {errors.data?.map((e) => (
            <li key={e.noteId} className="sync-errors__row">
              <span className="sync-errors__code">{t(`sync.err_${e.errCode}`)}</span>
              <span className="sync-errors__msg">{e.message ?? e.noteId}</span>
              <span className="sync-errors__at tabular">{relativeTime(e.at, t)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
