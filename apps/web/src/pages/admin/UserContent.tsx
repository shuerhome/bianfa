// 管理台 · 看内容：工作区 → 便笺列表 → 便笺正文。
//
// 范围由服务端决定：它在只读事务里把 app.user_id 切成目标用户后重新进入 RLS，
// 所以这里列出的就是「该用户自己能看到的东西」，团队工作区天然包含在内（也因此要标出是哪个组织 / 团队的）。
//
// E2EE 便笺必须显式说明「服务端只有密文」。这不是可省的细节：把一条加密便笺画成一张空白便笺，
// 等于向管理员暗示「这个人没写什么」，也向用户隐瞒了「我们其实读不到」这个事实。
import { Button } from "@bianfa/ui";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchUserNote, fetchUserNotes, fetchUserWorkspaces } from "../../admin-api.js";
import { StateView } from "../../components/StateView.js";
import { navigate } from "../../router.js";
import { adminUrl } from "./route.js";
import { formatTime, QueryError, useAdminQuery } from "./shared.js";

const PAGE_SIZE = 25;

export function UserContent({
  userId,
  workspaceId,
  noteId,
}: {
  userId: string;
  workspaceId: string | null;
  noteId: string | null;
}) {
  if (noteId) return <NoteBody userId={userId} workspaceId={workspaceId} noteId={noteId} />;
  if (workspaceId) return <NoteList userId={userId} workspaceId={workspaceId} />;
  return <WorkspaceList userId={userId} />;
}

function BackLink({ to, label }: { to: string; label: string }) {
  return (
    <div className="admin-crumbs">
      <button type="button" className="admin-linkbtn" onClick={() => navigate(to)}>
        {label}
      </button>
    </div>
  );
}

function WorkspaceList({ userId }: { userId: string }) {
  const { t } = useTranslation();
  const { data, error, reload } = useAdminQuery(`ws|${userId}`, () => fetchUserWorkspaces(userId));

  if (error) return <QueryError failure={error} onRetry={reload} />;
  return (
    <section className="admin-section">
      <BackLink to={adminUrl({ userId })} label={t("admin.backToUser")} />
      <h2 className="admin-h2">{t("admin.content.workspaces")}</h2>
      <p className="web-hint">{t("admin.content.workspacesHint")}</p>
      {!data ? (
        <StateView kind="loading" title={t("common.loading")} />
      ) : data.workspaces.length === 0 ? (
        <StateView kind="info" title={t("admin.content.noWorkspaces")} />
      ) : (
        <ul className="admin-list">
          {data.workspaces.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                className="admin-linkbtn admin-list__main"
                onClick={() => navigate(adminUrl({ userId, content: true, workspaceId: w.id }))}
              >
                {w.name}
              </button>
              <span className="admin-list__meta">
                {w.kind === "team"
                  ? t("admin.content.teamWorkspace", {
                      org: w.org_name ?? w.org_id ?? "—",
                      team: w.team_name ?? t("admin.content.wholeOrg"),
                    })
                  : t("admin.content.personalWorkspace")}
                {" · "}
                {t("admin.content.noteCount", { n: w.note_count })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NoteList({ userId, workspaceId }: { userId: string; workspaceId: string }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useAdminQuery(
    `notes|${userId}|${workspaceId}|${q}|${includeDeleted}|${offset}`,
    () =>
      fetchUserNotes(userId, {
        workspaceId,
        q: q.trim() || undefined,
        limit: PAGE_SIZE,
        offset,
        includeDeleted,
      }),
  );

  function submit(e: FormEvent) {
    e.preventDefault();
    setOffset(0);
    setQ(draft);
  }

  if (error) return <QueryError failure={error} onRetry={reload} />;
  return (
    <section className="admin-section">
      <BackLink to={adminUrl({ userId, content: true })} label={t("admin.backToWorkspaces")} />
      <h2 className="admin-h2">{t("admin.content.notes")}</h2>
      <form className="admin-filters" onSubmit={submit}>
        <label className="bf-sr-only" htmlFor="admin-note-search">
          {t("admin.content.searchNotes")}
        </label>
        <input
          id="admin-note-search"
          className="bf-input admin-input"
          type="search"
          autoComplete="off"
          placeholder={t("admin.content.searchPlaceholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <label className="admin-check">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => {
              setOffset(0);
              setIncludeDeleted(e.target.checked);
            }}
          />
          {t("admin.content.includeDeleted")}
        </label>
        <Button type="submit" variant="primary" busy={loading}>
          {t("admin.content.searchNotes")}
        </Button>
      </form>

      {!data ? (
        <StateView kind="loading" title={t("common.loading")} />
      ) : data.notes.length === 0 ? (
        <StateView kind="info" title={t("admin.content.noNotes")} />
      ) : (
        <>
          <ul className="admin-notes">
            {data.notes.map((n) => (
              <li key={n.id} className="admin-note">
                <button
                  type="button"
                  className="admin-linkbtn admin-note__title"
                  onClick={() => navigate(adminUrl({ userId, content: true, workspaceId, noteId: n.id }))}
                >
                  {n.title || t("admin.content.untitled")}
                </button>
                <p className={n.readable ? "admin-note__excerpt" : "admin-note__excerpt admin-note__sealed"}>
                  {n.readable ? n.excerpt : t("admin.content.e2eeShort")}
                </p>
                <span className="admin-list__meta">
                  {formatTime(n.updated_at)}
                  {n.deleted ? ` · ${t("admin.content.inTrash")}` : ""}
                  {n.unreadable_reason === "e2ee" ? ` · ${t("admin.tag.e2ee")}` : ""}
                </span>
              </li>
            ))}
          </ul>
          <div className="admin-pager">
            <span className="web-hint">
              {t("admin.users.range", { from: offset + 1, to: offset + data.notes.length })}
            </span>
            <div className="admin-pager__buttons">
              <Button
                size="sm"
                disabled={offset === 0 || loading}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                {t("admin.prevPage")}
              </Button>
              <Button
                size="sm"
                disabled={data.next_offset === null || loading}
                onClick={() => setOffset(data.next_offset ?? offset)}
              >
                {t("admin.nextPage")}
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function NoteBody({
  userId,
  workspaceId,
  noteId,
}: {
  userId: string;
  workspaceId: string | null;
  noteId: string;
}) {
  const { t } = useTranslation();
  const { data, error, reload } = useAdminQuery(`note|${userId}|${noteId}`, () =>
    fetchUserNote(userId, noteId),
  );

  const back = adminUrl({ userId, content: true, ...(workspaceId ? { workspaceId } : {}) });
  if (error) return <QueryError failure={error} onRetry={reload} />;
  if (!data) return <StateView kind="loading" title={t("common.loading")} />;

  const note = data.note;
  return (
    <section className="admin-section">
      <BackLink to={back} label={t("admin.backToNotes")} />
      <h2 className="admin-h2">{t("admin.content.noteTitle")}</h2>
      <dl className="web-kv admin-kv">
        <dt>{t("admin.content.workspace")}</dt>
        <dd>{note.workspace_name}</dd>
        <dt>{t("admin.content.author")}</dt>
        <dd>{note.creator_email ?? note.created_by}</dd>
        <dt>{t("admin.content.updatedAt")}</dt>
        <dd>{formatTime(note.updated_at)}</dd>
        <dt>{t("admin.users.status")}</dt>
        <dd>
          <span className="admin-tags">
            {note.deleted ? (
              <span className="admin-tag admin-tag--muted">{t("admin.content.inTrash")}</span>
            ) : (
              <span className="admin-tag">{t("admin.tag.active")}</span>
            )}
            {note.readable ? null : (
              <span className="admin-tag admin-tag--accent">{t("admin.tag.e2ee")}</span>
            )}
          </span>
        </dd>
      </dl>
      {note.readable ? (
        <pre className="admin-note__body">{note.content_text}</pre>
      ) : (
        <StateView
          kind="info"
          headline={t("admin.content.e2eeHeadline")}
          title={t("admin.content.e2eeDetail")}
          detail={t("admin.content.e2eeHint")}
        />
      )}
    </section>
  );
}
