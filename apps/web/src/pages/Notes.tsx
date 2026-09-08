// /notes：网页端（含 iOS「添加到主屏幕」的 PWA）的便笺列表。这一步只读展示，正文编辑在后续步骤接 Hocuspocus。
//
// 当前工作区放在查询串里（/notes?ws=<id>），理由与管理台一样：服务端只对 WEB_PAGE_PATHS 列出的路径回
// index.html，一个路径 + 查询串就不用为每个工作区再开一条服务端路由，刷新与后退也不会 404。
// 搜索词故意**不**进 URL：它是即打即用的过滤，每敲一个字就 replaceState 只是噪音。
import { Button, Icon, Select } from "@bianfa/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card } from "../components/Shell.js";
import { StateView } from "../components/StateView.js";
import { describeFailure } from "../lib/errors.js";
import { useQuery } from "../lib/query.js";
import { useRequireSession } from "../lib/session.js";
import { fetchNotes, fetchWorkspaces, type WebNote } from "../notes-api.js";
import { navigate, queryOf } from "../router.js";

export function notesUrl(workspaceId?: string | null): string {
  return workspaceId ? `/notes?ws=${encodeURIComponent(workspaceId)}` : "/notes";
}

export function Notes({ search }: { search: string }) {
  const { t } = useTranslation();
  const { user, pending } = useRequireSession("/notes");
  const [keyword, setKeyword] = useState("");
  const ws = useQuery("workspaces", () => fetchWorkspaces());
  const wantedWs = queryOf(search).get("ws");

  if (pending || !user || (!ws.data && !ws.error)) {
    return (
      <Card title={t("notes.title")}>
        <StateView kind="loading" title={t("common.loading")} />
      </Card>
    );
  }
  if (ws.error) {
    return (
      <Card title={t("notes.title")}>
        <StateView
          kind="error"
          title={describeFailure(ws.error)}
          actions={
            <Button variant="primary" size="lg" onClick={ws.reload}>
              {t("common.retry")}
            </Button>
          }
        />
      </Card>
    );
  }
  const workspaces = ws.data ?? [];
  // 查询串里的 ws 不在可见列表里（换了账号、被移出团队）→ 退回第一个，别把整页顶成错误
  const current = workspaces.find((w) => w.id === wantedWs) ?? workspaces[0];
  if (!current) {
    return (
      <Card title={t("notes.title")}>
        <StateView kind="info" title={t("notes.noWorkspace")} detail={t("notes.noWorkspaceHint")} />
      </Card>
    );
  }

  return (
    <Card title={t("notes.title")} wide labelledBy="notes-title">
      <div className="notes-bar">
        {workspaces.length > 1 ? (
          <Select
            className="notes-bar__ws"
            label={t("notes.workspace")}
            value={current.id}
            options={workspaces.map((w) => ({
              value: w.id,
              label: w.kind === "personal" ? t("notes.personal") : w.name,
            }))}
            onValueChange={(id) => navigate(notesUrl(id), { replace: true })}
          />
        ) : null}
        <input
          className="bf-input notes-bar__search"
          type="search"
          autoComplete="off"
          aria-label={t("notes.searchPlaceholder")}
          placeholder={t("notes.searchPlaceholder")}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Button className="notes-bar__account" icon="user" size="md" onClick={() => navigate("/account")}>
          {t("notes.account")}
        </Button>
      </div>
      <NoteGrid workspaceId={current.id} keyword={keyword} />
    </Card>
  );
}

function NoteGrid({ workspaceId, keyword }: { workspaceId: string; keyword: string }) {
  const { t } = useTranslation();
  const { data, error, reload } = useQuery(`notes|${workspaceId}`, () => fetchNotes(workspaceId));

  if (error)
    return (
      <StateView
        kind="error"
        title={describeFailure(error)}
        actions={
          <Button variant="primary" size="lg" onClick={reload}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  if (!data) return <StateView kind="loading" title={t("common.loading")} />;
  if (data.notes.length === 0)
    return <StateView kind="info" title={t("notes.empty")} detail={t("notes.emptyHint")} />;

  const needle = keyword.trim().toLocaleLowerCase();
  const shown = needle
    ? data.notes.filter(
        (n) => n.title.toLocaleLowerCase().includes(needle) || n.excerpt.toLocaleLowerCase().includes(needle),
      )
    : data.notes;
  if (shown.length === 0) return <StateView kind="info" title={t("notes.noMatch", { keyword })} />;

  return (
    <>
      <p className="notes-count" aria-live="polite">
        {needle
          ? t("notes.countFiltered", { shown: shown.length, total: data.notes.length })
          : t("notes.count", { total: data.notes.length })}
      </p>
      <ul className="notes-grid">
        {shown.map((n) => (
          <NoteCard key={n.id} note={n} />
        ))}
      </ul>
    </>
  );
}

function NoteCard({ note }: { note: WebNote }) {
  const { t } = useTranslation();
  // e2ee 的正文服务端存的是密文，title_cache / excerpt 一定是空的 —— 说清楚是「加密」而不是「空白」
  const encrypted = note.encryption === "e2ee";
  return (
    <li className="notes-card" data-color={note.color}>
      <p className="notes-card__title">
        {note.pinned ? <Icon name="pin" size={13} label={t("notes.pinned")} /> : null}
        <span className="notes-card__titletext">{note.title.trim() || t("notes.untitled")}</span>
      </p>
      <p className="notes-card__body">
        {encrypted ? (
          <span className="notes-card__locked">
            <Icon name="lock" size={13} />
            {t("notes.encrypted")}
          </span>
        ) : (
          note.excerpt.trim() || t("notes.blank")
        )}
      </p>
      <p className="notes-card__meta">{formatDay(note.updated_at ?? note.created_at)}</p>
    </li>
  );
}

/** 本地时区的 YYYY-MM-DD HH:mm；空值给短横线（与管理台 formatTime 同一种写法） */
function formatDay(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
