// 管理台 · 用户详情：基本信息、组织与角色、团队、设备、内容规模，以及冻结 / 解冻 / 重置密码三个操作。
//
// 三个操作都要二次确认，确认框里必须写清后果 —— 冻结与改密都会当场把该用户从所有设备上踢下线，
// 这不是「稍后生效」的设置项。服务端还会拒绝「对自己」和「对另一个总管理员」动手，
// 那两种 403/400 在这里翻译成人话（errors.* 里的对应文案），不把错误码丢给人看。
import { Button } from "@bianfa/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchUserDetail, freezeUser, setUserPassword, unfreezeUser } from "../../admin-api.js";
import { Field } from "../../components/Field.js";
import { Notice } from "../../components/Notice.js";
import { StateView } from "../../components/StateView.js";
import { type ApiFailure, describeFailure } from "../../lib/errors.js";
import { PASSWORD_MIN, passwordProblem } from "../../lib/validation.js";
import { navigate } from "../../router.js";
import { adminUrl } from "./route.js";
import { formatTime, QueryError, useAdminQuery } from "./shared.js";

type Pending = "freeze" | "unfreeze" | "password" | null;

/** 组织角色 / 成员状态的文案键；服务端将来加了新值也不会崩，原样显示那个值 */
const ROLE_KEYS: Record<string, string> = {
  owner: "admin.role.owner",
  admin: "admin.role.admin",
  member: "admin.role.member",
};
const MEMBER_STATUS_KEYS: Record<string, string> = {
  active: "admin.memberStatus.active",
  suspended: "admin.memberStatus.suspended",
  removed: "admin.memberStatus.removed",
};

function Label({ map, value }: { map: Record<string, string>; value: string }) {
  const { t } = useTranslation();
  const key = map[value];
  return <>{key ? t(key) : value}</>;
}

export function UserDetail({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const { data, error, loading, reload } = useAdminQuery(`user|${userId}`, () => fetchUserDetail(userId));
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  /** 服务端的业务错误码翻译；404 在这里是「找不到这个用户」，不能落到邀请那条 not_found 文案上 */
  function explain(f: ApiFailure): string {
    return f.status === 404 ? t("admin.notFound") : describeFailure(f);
  }

  /** 打开确认框时顺手清掉上一次的成功提示，免得两条互相矛盾的话同时挂在页面上 */
  function openConfirm(kind: Exclude<Pending, null>) {
    setDone(null);
    setActionError(null);
    setFieldError(null);
    setPending(kind);
  }

  function closeConfirm() {
    setPending(null);
    setFieldError(null);
    setActionError(null);
    setReason("");
    setPassword("");
  }

  async function run(kind: Exclude<Pending, null>) {
    if (kind === "password") {
      const problem = passwordProblem(password);
      if (problem) {
        setFieldError(
          problem === "short"
            ? t("validation.passwordShort", { min: PASSWORD_MIN })
            : t("validation.passwordLong"),
        );
        return;
      }
    }
    setBusy(true);
    setActionError(null);
    const res =
      kind === "freeze"
        ? await freezeUser(userId, reason.trim() || null)
        : kind === "unfreeze"
          ? await unfreezeUser(userId)
          : await setUserPassword(userId, password);
    setBusy(false);
    if (!res.ok) {
      setActionError(explain(res.error));
      return;
    }
    const revoked = "revoked_devices" in res.data ? res.data.revoked_devices : 0;
    setDone(
      kind === "freeze"
        ? t("admin.actionsPanel.freezeDone", { n: revoked })
        : kind === "unfreeze"
          ? t("admin.actionsPanel.unfreezeDone")
          : t("admin.actionsPanel.passwordDone", { n: revoked }),
    );
    closeConfirm();
    reload();
  }

  if (error) return <QueryError failure={error} onRetry={reload} />;
  if (!data) return <StateView kind="loading" title={t("common.loading")} />;

  const u = data.user;
  return (
    <section className="admin-section">
      <div className="admin-crumbs">
        <button type="button" className="admin-linkbtn" onClick={() => navigate(adminUrl({}))}>
          {t("admin.backToUsers")}
        </button>
      </div>

      {done ? <Notice kind="accent">{done}</Notice> : null}

      <h2 className="admin-h2">{u.email}</h2>
      <dl className="web-kv admin-kv">
        <dt>{t("fields.name")}</dt>
        <dd>{u.name}</dd>
        <dt>{t("admin.detail.userId")}</dt>
        <dd className="web-mono">{u.id}</dd>
        <dt>{t("admin.users.createdAt")}</dt>
        <dd>{formatTime(u.created_at)}</dd>
        <dt>{t("admin.users.status")}</dt>
        <dd>
          <span className="admin-tags">
            {u.frozen ? (
              <span className="admin-tag admin-tag--danger">{t("admin.tag.frozen")}</span>
            ) : (
              <span className="admin-tag">{t("admin.tag.active")}</span>
            )}
            {u.is_platform_admin ? (
              <span className="admin-tag admin-tag--accent">{t("admin.tag.platformAdmin")}</span>
            ) : null}
            {u.deleted ? <span className="admin-tag admin-tag--muted">{t("admin.tag.deleted")}</span> : null}
          </span>
        </dd>
        {u.frozen ? (
          <>
            <dt>{t("admin.detail.frozenAt")}</dt>
            <dd>{formatTime(u.frozen_at)}</dd>
            <dt>{t("admin.detail.frozenReason")}</dt>
            <dd>{u.frozen_reason || t("admin.detail.noReason")}</dd>
            <dt>{t("admin.detail.frozenBy")}</dt>
            <dd className="web-mono">{data.frozen_by ?? "—"}</dd>
          </>
        ) : null}
      </dl>

      <h3 className="admin-h3">{t("admin.detail.orgs")}</h3>
      {data.organizations.length === 0 ? (
        <p className="web-hint">{t("admin.detail.noOrgs")}</p>
      ) : (
        <ul className="admin-list">
          {data.organizations.map((o) => (
            <li key={o.id}>
              <span className="admin-list__main">{o.name}</span>
              <span className="admin-list__meta">
                <Label map={ROLE_KEYS} value={o.role} /> · <Label map={MEMBER_STATUS_KEYS} value={o.status} />
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="admin-h3">{t("admin.detail.teams")}</h3>
      {data.teams.length === 0 ? (
        <p className="web-hint">{t("admin.detail.noTeams")}</p>
      ) : (
        <ul className="admin-list">
          {data.teams.map((tm) => (
            <li key={tm.id}>
              <span className="admin-list__main">{tm.name}</span>
              <span className="admin-list__meta web-mono">{tm.org_id}</span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="admin-h3">{t("admin.detail.devices")}</h3>
      {data.devices.length === 0 ? (
        <p className="web-hint">{t("admin.detail.noDevices")}</p>
      ) : (
        <ul className="admin-list">
          {data.devices.map((d) => (
            <li key={d.id}>
              <span className="admin-list__main">{d.name || d.id}</span>
              <span className="admin-list__meta">
                {d.platform ?? "—"}
                {d.revoked ? ` · ${t("admin.detail.deviceRevoked")}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="admin-h3">{t("admin.detail.scale")}</h3>
      <dl className="admin-stats">
        <div>
          <dt>{t("admin.detail.workspaces")}</dt>
          <dd>{data.scale.workspaces}</dd>
        </div>
        <div>
          <dt>{t("admin.detail.notes")}</dt>
          <dd>{data.scale.notes}</dd>
        </div>
        <div>
          <dt>{t("admin.detail.deletedNotes")}</dt>
          <dd>{data.scale.deleted_notes}</dd>
        </div>
        <div>
          <dt>{t("admin.detail.e2eeNotes")}</dt>
          <dd>{data.scale.e2ee_notes}</dd>
        </div>
      </dl>

      <div className="admin-actions">
        <Button
          variant="primary"
          onClick={() => navigate(adminUrl({ userId, content: true }))}
          disabled={loading}
        >
          {t("admin.detail.viewContent")}
        </Button>
        {u.frozen ? (
          <Button onClick={() => openConfirm("unfreeze")} disabled={pending !== null}>
            {t("admin.actionsPanel.unfreeze")}
          </Button>
        ) : (
          <Button
            variant="danger-secondary"
            onClick={() => openConfirm("freeze")}
            disabled={pending !== null}
          >
            {t("admin.actionsPanel.freeze")}
          </Button>
        )}
        <Button
          variant="danger-secondary"
          onClick={() => openConfirm("password")}
          disabled={pending !== null}
        >
          {t("admin.actionsPanel.password")}
        </Button>
      </div>

      {pending ? (
        <Confirm
          kind={pending}
          busy={busy}
          error={actionError}
          onCancel={closeConfirm}
          onConfirm={() => void run(pending)}
        >
          {pending === "freeze" ? (
            <Field
              label={t("admin.actionsPanel.reasonLabel")}
              hint={t("admin.actionsPanel.reasonHint")}
              maxLength={200}
              value={reason}
              autoFocus
              onChange={(e) => setReason(e.target.value)}
            />
          ) : null}
          {pending === "password" ? (
            <Field
              label={t("fields.newPassword")}
              type="password"
              autoComplete="new-password"
              hint={t("validation.passwordHint", { min: PASSWORD_MIN })}
              error={fieldError}
              value={password}
              autoFocus
              onChange={(e) => {
                setPassword(e.target.value);
                setFieldError(null);
              }}
            />
          ) : null}
        </Confirm>
      ) : null}
    </section>
  );
}

/** 二次确认：标题 + 后果 + 可选表单 + 「取消 / 确认」。取消永远排在前面。 */
function Confirm({
  kind,
  busy,
  error,
  children,
  onCancel,
  onConfirm,
}: {
  kind: "freeze" | "unfreeze" | "password";
  busy: boolean;
  error: string | null;
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const copy = {
    freeze: {
      title: t("admin.actionsPanel.freezeConfirm"),
      body: t("admin.actionsPanel.freezeConsequence"),
      submit: t("admin.actionsPanel.freezeSubmit"),
    },
    unfreeze: {
      title: t("admin.actionsPanel.unfreezeConfirm"),
      body: t("admin.actionsPanel.unfreezeConsequence"),
      submit: t("admin.actionsPanel.unfreezeSubmit"),
    },
    password: {
      title: t("admin.actionsPanel.passwordConfirm"),
      body: t("admin.actionsPanel.passwordConsequence"),
      submit: t("admin.actionsPanel.passwordSubmit"),
    },
  }[kind];
  return (
    <section className="admin-confirm" aria-label={copy.title}>
      <p className="admin-confirm__title">{copy.title}</p>
      <p className="admin-confirm__body">{copy.body}</p>
      {children}
      {error ? <Notice kind="danger">{error}</Notice> : null}
      <div className="admin-confirm__actions">
        <Button onClick={onCancel} disabled={busy}>
          {t("admin.cancel")}
        </Button>
        <Button variant="danger" busy={busy} onClick={onConfirm}>
          {copy.submit}
        </Button>
      </div>
    </section>
  );
}
