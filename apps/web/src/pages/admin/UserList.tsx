// 管理台 · 用户列表：搜索（邮箱 / 姓名）、只看已冻结、服务端 next_offset 分页。
import { Button } from "@bianfa/ui";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchUsers } from "../../admin-api.js";
import { StateView } from "../../components/StateView.js";
import { navigate } from "../../router.js";
import { adminUrl } from "./route.js";
import { formatTime, QueryError, useAdminQuery } from "./shared.js";

const PAGE_SIZE = 25;

export function UserList() {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [frozenOnly, setFrozenOnly] = useState(false);
  const [offset, setOffset] = useState(0);

  const { data, error, loading, reload } = useAdminQuery(`users|${q}|${frozenOnly}|${offset}`, () =>
    fetchUsers({ q: q.trim() || undefined, limit: PAGE_SIZE, offset, frozenOnly }),
  );

  function submit(e: FormEvent) {
    e.preventDefault();
    setOffset(0);
    setQ(draft);
  }

  function toggleFrozen(next: boolean) {
    setOffset(0);
    setFrozenOnly(next);
  }

  return (
    <section className="admin-section">
      <form className="admin-filters" onSubmit={submit}>
        <label className="bf-sr-only" htmlFor="admin-user-search">
          {t("admin.users.search")}
        </label>
        <input
          id="admin-user-search"
          className="bf-input admin-input"
          type="search"
          autoComplete="off"
          placeholder={t("admin.users.searchPlaceholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <label className="admin-check">
          <input type="checkbox" checked={frozenOnly} onChange={(e) => toggleFrozen(e.target.checked)} />
          {t("admin.users.frozenOnly")}
        </label>
        <Button type="submit" variant="primary" busy={loading}>
          {t("admin.users.search")}
        </Button>
      </form>

      {error ? (
        <QueryError failure={error} onRetry={reload} />
      ) : loading && !data ? (
        <StateView kind="loading" title={t("common.loading")} />
      ) : !data || data.users.length === 0 ? (
        <StateView kind="info" title={t("admin.users.empty")} />
      ) : (
        <>
          <div className="admin-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">{t("fields.email")}</th>
                  <th scope="col">{t("fields.name")}</th>
                  <th scope="col">{t("admin.users.createdAt")}</th>
                  <th scope="col">{t("admin.users.status")}</th>
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <button
                        type="button"
                        className="admin-linkbtn"
                        onClick={() => navigate(adminUrl({ userId: u.id }))}
                      >
                        {u.email}
                      </button>
                    </td>
                    <td>{u.name}</td>
                    <td className="admin-nowrap">{formatTime(u.created_at)}</td>
                    <td>
                      <span className="admin-tags">
                        {u.frozen ? (
                          <span className="admin-tag admin-tag--danger">{t("admin.tag.frozen")}</span>
                        ) : (
                          <span className="admin-tag">{t("admin.tag.active")}</span>
                        )}
                        {u.is_platform_admin ? (
                          <span className="admin-tag admin-tag--accent">{t("admin.tag.platformAdmin")}</span>
                        ) : null}
                        {u.deleted ? (
                          <span className="admin-tag admin-tag--muted">{t("admin.tag.deleted")}</span>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="admin-pager">
            <span className="web-hint">
              {t("admin.users.range", { from: offset + 1, to: offset + data.users.length })}
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
