// /notes：网页端（含 iOS「添加到主屏幕」的 PWA）的便笺列表。这一步只读展示，正文编辑在后续步骤接 Hocuspocus。
//
// 当前工作区放在查询串里（/notes?ws=<id>），理由与管理台一样：服务端只对 WEB_PAGE_PATHS 列出的路径回
// index.html，一个路径 + 查询串就不用为每个工作区再开一条服务端路由，刷新与后退也不会 404。
// 搜索词故意**不**进 URL：它是即打即用的过滤，每敲一个字就 replaceState 只是噪音。
import { Button, Icon, Select } from "@bianfa/ui";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { ErrorBoundary } from "../components/ErrorBoundary.js";
import { Card } from "../components/Shell.js";
import { StateView } from "../components/StateView.js";
import { describeFailure } from "../lib/errors.js";
import { useQuery } from "../lib/query.js";
import { useRequireSession } from "../lib/session.js";
import { fetchNotes, fetchWorkspaces, type WebNote } from "../notes-api.js";
import { navigate, queryOf } from "../router.js";

// 编辑器（TipTap + Yjs + Hocuspocus）是整个网页端最大的一块，压缩后也有 180 KB 上下。
// 静态 import 的话 /login 这种页面也得先把它下载完——手机上第一次打开就是那么多流量。
// 只有真的打开某张便笺时才去取。
const NoteView = lazy(() => import("./NoteView.js").then((m) => ({ default: m.NoteView })));

export function notesUrl(workspaceId?: string | null, noteId?: string | null): string {
  const q = new URLSearchParams();
  if (workspaceId) q.set("ws", workspaceId);
  if (noteId) q.set("note", noteId);
  const s = q.toString();
  return s ? `/notes?${s}` : "/notes";
}

export function Notes({ search }: { search: string }) {
  const { t } = useTranslation();
  const { user, pending } = useRequireSession("/notes");
  const [keyword, setKeyword] = useState("");
  const ws = useQuery("workspaces", () => fetchWorkspaces());
  const q = queryOf(search);
  const wantedWs = q.get("ws");
  const wantedNote = q.get("note");

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
      <NoteGrid workspaceId={current.id} keyword={keyword} openNoteId={wantedNote} user={user} />
    </Card>
  );
}

function NoteGrid({
  workspaceId,
  keyword,
  openNoteId,
  user,
}: {
  workspaceId: string;
  keyword: string;
  openNoteId: string | null;
  user: { id: string; name: string; email: string };
}) {
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

  // 打开某张便笺：整块换成编辑器，列表的筛选栏也一并让位（返回按钮在编辑器里）
  if (openNoteId) {
    const open = data.notes.find((n) => n.id === openNoteId);
    // 便笺不在这个工作区（换了账号、链接过期、刚被删）→ 说清楚，而不是渲染一张空编辑器
    if (!open)
      return (
        <StateView
          kind="error"
          title={t("notes.notFound")}
          actions={
            <Button variant="primary" size="lg" onClick={() => navigate(notesUrl(workspaceId))}>
              {t("notes.backToList")}
            </Button>
          }
        />
      );
    if (open.encryption === "e2ee")
      return (
        <StateView
          kind="info"
          title={t("notes.encrypted")}
          actions={
            <Button variant="primary" size="lg" onClick={() => navigate(notesUrl(workspaceId))}>
              {t("notes.backToList")}
            </Button>
          }
        />
      );
    return (
      <ErrorBoundary
        fallback={(retry) => (
          <StateView
            kind="error"
            title={t("notes.chunkFailed")}
            actions={
              <Button variant="primary" size="lg" onClick={retry}>
                {t("notes.reload")}
              </Button>
            }
          />
        )}
      >
        <Suspense fallback={<StateView kind="loading" title={t("common.loading")} />}>
          <NoteView
            note={open}
            userId={user.id}
            userName={user.name || user.email}
            backTo={notesUrl(workspaceId)}
          />
        </Suspense>
      </ErrorBoundary>
    );
  }

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
          <NoteCard key={n.id} note={n} onOpen={() => navigate(notesUrl(workspaceId, n.id))} />
        ))}
      </ul>
    </>
  );
}

function NoteCard({ note, onOpen }: { note: WebNote; onOpen: () => void }) {
  const { t } = useTranslation();
  // e2ee 的正文服务端存的是密文，title_cache / excerpt 一定是空的 —— 说清楚是「加密」而不是「空白」
  const encrypted = note.encryption === "e2ee";
  return (
    <li className="notes-card" data-color={note.color}>
      <button type="button" className="notes-card__open" onClick={onOpen}>
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
      </button>
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
