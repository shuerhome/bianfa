// 共享对话框（便笺窗「更多」菜单 / 主窗卡片右键）：GET /v1/notes/:id/shares 列表；按邮箱 PUT 添加或改权限；DELETE 撤销。
// 只支持 grantee_kind=user；权限本期只给 viewer / editor 两档（已有的其它档照常显示）。
import { Button, Dialog, Select, useToast } from "@bianfa/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NotePerm } from "../../../api/notes.js";
import { listShares, putShare, revokeShare, type Share } from "../../../api/shares.js";
import "../../../styles/team.css";
import { describeShareError } from "./team-errors.js";
import { teamKeys } from "./team-keys.js";

export interface ShareDialogProps {
  open: boolean;
  /** null = 未选中便笺（对话框关着） */
  noteId: string | null;
  noteTitle?: string | undefined;
  onClose: () => void;
}

const OFFERED: readonly NotePerm[] = ["viewer", "editor"];
const SKELETON = ["a", "b"];

function granteeName(s: Share, fallback: string): string {
  return s.grantee?.name || s.grantee?.email || fallback;
}

export function ShareDialog({ open, noteId, noteTitle, onClose }: ShareDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const client = useQueryClient();
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [perm, setPerm] = useState<NotePerm>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = teamKeys.shares(noteId ?? "-");
  const enabled = open && noteId !== null;

  const shares = useQuery({
    queryKey: key,
    queryFn: () => listShares(noteId as string),
    enabled,
    retry: false,
  });

  useEffect(() => {
    if (!open) {
      setEmail("");
      setPerm("viewer");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const refresh = () => client.invalidateQueries({ queryKey: key });
  const permLabel = (p: NotePerm) => t(`share.perm_${p}`);
  const permOptions = (current?: NotePerm) =>
    [...new Set<NotePerm>([...OFFERED, ...(current ? [current] : [])])].map((p) => ({
      value: p,
      label: permLabel(p),
    }));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!noteId || !value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const existed = (shares.data ?? []).some(
        (s) => s.grantee?.email?.toLowerCase() === value.toLowerCase(),
      );
      const r = await putShare(noteId, { email: value }, perm);
      toast({
        message: t(existed ? "share.updated" : "share.added", { name: granteeName(r.share, value) }),
        kind: "success",
      });
      setEmail("");
      await refresh();
    } catch (err) {
      setError(describeShareError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const changePerm = async (s: Share, next: NotePerm) => {
    if (!noteId || !s.grantee || next === s.permission) return;
    setError(null);
    try {
      await putShare(noteId, { userId: s.grantee.userId }, next);
      toast({ message: t("share.updated", { name: granteeName(s, t("share.link")) }), kind: "success" });
      await refresh();
    } catch (err) {
      setError(describeShareError(err, t));
    }
  };

  const revoke = async (s: Share) => {
    if (!noteId) return;
    setError(null);
    try {
      await revokeShare(noteId, s.id);
      toast({ message: t("share.revoked", { name: granteeName(s, t("share.link")) }) });
      await refresh();
    } catch (err) {
      setError(describeShareError(err, t));
    }
  };

  const list = shares.data ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={noteTitle ? `${t("share.title")} · ${noteTitle}` : t("share.title")}
      description={t("share.desc")}
      width={480}
      closeLabel={t("common.close")}
    >
      <form className="share-form" onSubmit={(e) => void add(e)}>
        <div className="team-field team-field--grow">
          <label htmlFor={emailId} className="team-label">
            {t("share.email")}
          </label>
          <input
            id={emailId}
            className="bf-input"
            type="email"
            autoComplete="off"
            data-autofocus
            placeholder={t("share.emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <Select
          label={t("share.permission")}
          value={perm}
          options={permOptions()}
          onValueChange={(v) => setPerm(v)}
        />
        <Button variant="primary" type="submit" busy={busy} disabled={email.trim().length === 0}>
          {t("share.add")}
        </Button>
      </form>
      {error ? (
        <p className="team-warning" role="alert" style={{ marginTop: "var(--sp-3)" }}>
          {error}
        </p>
      ) : null}
      <div className="share-list">
        <p className="share-section">{t("share.current")}</p>
        {shares.isLoading ? (
          <div className="team-skeleton" aria-busy="true">
            {SKELETON.map((k) => (
              <div key={k} className="bf-skeleton" />
            ))}
          </div>
        ) : shares.isError ? (
          <p className="team-warning" role="alert">
            {describeShareError(shares.error, t)}{" "}
            <Button size="sm" variant="ghost" onClick={() => void shares.refetch()}>
              {t("common.retry")}
            </Button>
          </p>
        ) : list.length === 0 ? (
          <p className="share-empty">{t("share.empty")}</p>
        ) : (
          <ul className="team-list">
            {list.map((s) => {
              const name = granteeName(s, t("share.link"));
              return (
                <li key={s.id} className="team-row">
                  <div className="team-row__avatar" aria-hidden="true">
                    {name.slice(0, 1)}
                  </div>
                  <div className="team-row__text">
                    <div className="team-row__name">{name}</div>
                    <div className="team-row__meta">
                      {s.grantee?.email && s.grantee.email !== name ? s.grantee.email : null}
                      {s.expiresAt !== null
                        ? ` · ${t("share.expires", { time: new Date(s.expiresAt).toLocaleDateString() })}`
                        : null}
                    </div>
                  </div>
                  <div className="team-row__actions">
                    {s.grantee ? (
                      <Select
                        label={`${t("share.permission")} · ${name}`}
                        value={s.permission}
                        options={permOptions(s.permission)}
                        onValueChange={(v) => void changePerm(s, v)}
                      />
                    ) : (
                      <span className="team-badge">{permLabel(s.permission)}</span>
                    )}
                    <Button size="sm" variant="danger-secondary" onClick={() => void revoke(s)}>
                      {t("share.revoke")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
