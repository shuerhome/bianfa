// 账号 / 同步（specs/06 §4.4–4.5、4.8）：登录等待态（20s 复制链接 / 60s 验证码降级 / 120s 失败）、退出、
// 设备列表（GET /v1/me/devices · 逐个吊销 · 注销其他设备）、安全码（/v1/me/security-code，只用于 Web 端忘记密码）、
// 云端导出（/v1/me/export）、删除账号（/v1/me/delete）、同步错误列表。
import { Button, useToast } from "@bianfa/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { API_ERROR, isApiError } from "../../../api/http.js";
import {
  cancelAccountDeletion,
  type ExportJob,
  fetchCloudExport,
  fetchMe,
  listDevices,
  requestCloudExport,
  revokeAllDevices,
  revokeDevice,
  scheduleAccountDeletion,
} from "../../../api/me.js";
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
import { describeError } from "../../../ipc/errors.js";
import { useTauriEvent } from "../../../ipc/events.js";
import type { LoginPhase } from "../../../ipc/types.js";
import { queryKeys } from "../../../lib/query.js";
import { relativeTime } from "../../../lib/time.js";
import { SecurityCodeDialog } from "../SecurityCodeDialog.js";

type LoginUi =
  | { phase: "idle" }
  | { phase: "waiting"; authUrl: string; startedAt: number }
  | { phase: "device"; userCode: string; verificationUrl: string }
  | { phase: "failed"; message: string | null }
  | { phase: "done" };

const FREE_DEVICE_LIMIT = 2;

export function AccountSection() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const client = useQueryClient();
  const auth = useQuery({ queryKey: queryKeys.auth, queryFn: authStatus, retry: false });
  const loggedIn = auth.data?.loggedIn === true;
  const me = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe, enabled: loggedIn, retry: false });
  const devices = useQuery({
    queryKey: queryKeys.devices,
    queryFn: listDevices,
    enabled: loggedIn,
    retry: false,
  });
  const errors = useQuery({ queryKey: queryKeys.syncErrors, queryFn: syncErrorsList, retry: false });
  const pending = useQuery({ queryKey: queryKeys.pendingSync, queryFn: notesPendingSync, retry: false });
  const [login, setLogin] = useState<LoginUi>({ phase: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const [deleteText, setDeleteText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [exportJob, setExportJob] = useState<ExportJob | null>(null);
  const [codeDialog, setCodeDialog] = useState(false);
  const timer = useRef<number | null>(null);

  useTauriEvent("auth:changed", (a) => {
    client.setQueryData(queryKeys.auth, a);
    void client.invalidateQueries({ queryKey: ["account"] });
    if (a.loggedIn) {
      setLogin({ phase: "done" });
      window.setTimeout(() => setLogin({ phase: "idle" }), 700);
    }
  });
  useTauriEvent("auth:login-progress", (p) => {
    const phase: LoginPhase = p.phase;
    if (phase === "failed") setLogin({ phase: "failed", message: p.message ?? null });
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
      if (s >= 120) setLogin({ phase: "failed", message: null });
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
    } catch (e) {
      setLogin({ phase: "failed", message: describeError(e) });
    }
  };
  const startDevice = async () => {
    try {
      await authLoginCancel().catch(() => undefined);
      const res = await authLoginDeviceStart();
      setLogin({ phase: "device", userCode: res.userCode, verificationUrl: res.verificationUrl });
    } catch (e) {
      setLogin({ phase: "failed", message: describeError(e) });
    }
  };
  const cancel = () => {
    void authLoginCancel().catch(() => undefined);
    setLogin({ phase: "idle" });
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast({ message: `${t("common.failed")}: ${describeError(e)}`, kind: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const doRevoke = (id: string, name: string) =>
    run(`revoke:${id}`, async () => {
      if (!window.confirm(t("settings.deviceRevokeConfirm", { name }))) return;
      await revokeDevice(id);
      await devices.refetch();
      toast({ message: t("settings.deviceRevokedToast", { count: 1 }) });
    });

  const doRevokeOthers = () =>
    run("revoke-others", async () => {
      if (!window.confirm(t("settings.deviceRevokeOthersConfirm"))) return;
      const r = await revokeAllDevices({ keepCurrent: true });
      await devices.refetch();
      toast({ message: t("settings.deviceRevokedToast", { count: r.count }) });
    });

  const doExport = () =>
    run("export", async () => {
      try {
        const r = await requestCloudExport();
        setExportJob(await fetchCloudExport(r.jobId));
      } catch (e) {
        if (isApiError(e, API_ERROR.exportRateLimited)) {
          const jobId = e.details.body?.job_id;
          if (typeof jobId === "string") setExportJob(await fetchCloudExport(jobId));
          toast({ message: t("settings.cloudExportRateLimited"), kind: "warning" });
          return;
        }
        throw e;
      }
    });

  const refreshExport = () =>
    run("export-refresh", async () => {
      if (exportJob) setExportJob(await fetchCloudExport(exportJob.id));
    });

  const doDelete = () =>
    run("delete", async () => {
      if (!window.confirm(t("settings.deleteAccountConfirm"))) return;
      try {
        const r = await scheduleAccountDeletion();
        toast({
          message: t("settings.deleteScheduled", {
            date: r.deletionDueAt ? new Date(r.deletionDueAt).toLocaleDateString() : "",
          }),
          kind: "warning",
        });
        // 服务端已撤销全部 token：本机也清掉凭据（便笺保留）
        await authLogout(false).catch(() => undefined);
        await auth.refetch();
      } catch (e) {
        if (isApiError(e, API_ERROR.transferOwnershipFirst)) {
          toast({ message: t("settings.deleteTransferFirst"), kind: "danger" });
          return;
        }
        throw e;
      }
    });

  const doCancelDelete = () =>
    run("delete-cancel", async () => {
      await cancelAccountDeletion();
      await me.refetch();
      toast({ message: t("settings.deleteCanceled"), kind: "success" });
    });

  const user = auth.data?.user ?? null;
  const plan = me.data?.plan ?? auth.data?.plan ?? null;
  const activeDevices = (devices.data ?? []).filter((d) => d.revokedAt === null);
  const otherActive = activeDevices.filter((d) => !d.current).length;

  return (
    <section className="settings-section" aria-labelledby="sec-account">
      <h2 id="sec-account" className="settings-section__title">
        {t("settings.account")}
      </h2>
      {loggedIn && user ? (
        <>
          <div className="account-card">
            <div className="account-avatar" aria-hidden="true">
              {user.image ? (
                <img src={user.image} alt="" />
              ) : (
                (user.name ?? user.email).slice(0, 1).toUpperCase()
              )}
            </div>
            <div className="account-card__text">
              <div className="account-card__name">
                {user.name ?? user.email}
                {plan ? <span className="plan-badge">{t(`settings.plan_${plan}`)}</span> : null}
              </div>
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

          <h3 className="settings-subtitle">{t("settings.devices")}</h3>
          <p className="settings-hint">
            {t("settings.devicesHint")}
            {plan === "free" ? ` ${t("settings.devicesFreeHint", { limit: FREE_DEVICE_LIMIT })}` : ""}
          </p>
          {devices.isError ? (
            <p className="settings-warning">{t("settings.devicesLoadFailed")}</p>
          ) : (
            <ul className="device-list">
              {(devices.data ?? []).map((d) => (
                <li key={d.id} className="device-row" data-revoked={d.revokedAt !== null || undefined}>
                  <div className="device-row__text">
                    <div className="device-row__name">
                      {d.name}
                      {d.current ? (
                        <span className="device-row__badge">{t("settings.deviceCurrent")}</span>
                      ) : null}
                      {d.revokedAt !== null ? (
                        <span className="device-row__badge device-row__badge--muted">
                          {t("settings.deviceRevoked")}
                        </span>
                      ) : null}
                    </div>
                    <div className="device-row__meta tabular">
                      {d.platform} · {d.appVersion} · {relativeTime(d.lastSeenAt, t)}
                    </div>
                  </div>
                  {!d.current && d.revokedAt === null ? (
                    <Button
                      size="sm"
                      variant="danger-secondary"
                      busy={busy === `revoke:${d.id}`}
                      onClick={() => void doRevoke(d.id, d.name)}
                    >
                      {t("settings.deviceRevoke")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {otherActive > 0 ? (
            <Button size="sm" busy={busy === "revoke-others"} onClick={() => void doRevokeOthers()}>
              {t("settings.deviceRevokeOthers")}
            </Button>
          ) : null}

          <h3 className="settings-subtitle">{t("settings.securityCode")}</h3>
          <p className="settings-hint">{t("settings.securityCodeHint")}</p>
          <div className="settings-inline">
            <span className="settings-hint tabular">
              {me.data?.securityCodeSetAt
                ? t("settings.securityCodeSetAt", {
                    date: new Date(me.data.securityCodeSetAt).toLocaleString(),
                  })
                : t("settings.securityCodeUnset")}
            </span>
            <Button size="sm" onClick={() => setCodeDialog(true)}>
              {t("settings.securityCodeChange")}
            </Button>
          </div>
          <SecurityCodeDialog
            open={codeDialog}
            onClose={() => setCodeDialog(false)}
            onChanged={() => {
              setCodeDialog(false);
              void me.refetch();
              toast({ message: t("settings.securityCodeChanged"), kind: "success" });
            }}
          />
        </>
      ) : (
        <div className="login-panel">
          {login.phase === "idle" || login.phase === "failed" ? (
            <>
              <p className="settings-hint">{t("settings.loginHint")}</p>
              {login.phase === "failed" ? (
                <p className="settings-warning" role="alert">
                  {t("login.failed")}
                  {login.message ? <span className="login-failure-detail">{login.message}</span> : null}
                </p>
              ) : null}
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
        {loggedIn ? t("settings.pendingUpload", { count: pending.data?.length ?? 0 }) : t("sync.localMode")}
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

      {loggedIn ? (
        <>
          <h3 className="settings-subtitle">{t("settings.cloudExport")}</h3>
          <p className="settings-hint">{t("settings.cloudExportHint")}</p>
          <div className="settings-inline">
            <Button icon="file-down" busy={busy === "export"} onClick={() => void doExport()}>
              {t("settings.cloudExportRequest")}
            </Button>
            {exportJob ? (
              <>
                <span className="settings-hint tabular">
                  {t("settings.cloudExportStatus", { status: exportJob.status })}
                </span>
                {exportJob.status === "ready" && exportJob.downloadUrl ? (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void openExternal(exportJob.downloadUrl as string)}
                  >
                    {t("settings.cloudExportDownload")}
                  </Button>
                ) : exportJob.status === "queued" || exportJob.status === "running" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={busy === "export-refresh"}
                    onClick={() => void refreshExport()}
                  >
                    {t("settings.cloudExportRefresh")}
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="danger-zone">
            <h3 className="danger-zone__title">{t("settings.deleteAccount")}</h3>
            {me.data?.deletionDueAt ? (
              <>
                <p className="settings-warning">
                  {t("settings.deleteScheduled", {
                    date: new Date(me.data.deletionDueAt).toLocaleDateString(),
                  })}
                </p>
                <Button busy={busy === "delete-cancel"} onClick={() => void doCancelDelete()}>
                  {t("settings.deleteCancel")}
                </Button>
              </>
            ) : (
              <>
                <p className="settings-hint">{t("settings.deleteAccountHint")}</p>
                <div className="settings-inline">
                  <input
                    id="delete-account-confirm"
                    className="bf-input"
                    aria-label={t("settings.deleteAccount")}
                    value={deleteText}
                    onChange={(e) => setDeleteText(e.target.value)}
                    placeholder={t("settings.deleteAccountWord")}
                  />
                  <Button
                    variant="danger"
                    busy={busy === "delete"}
                    disabled={deleteText !== t("settings.deleteAccountWord")}
                    onClick={() => void doDelete()}
                  >
                    {t("settings.deleteAccountButton")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
