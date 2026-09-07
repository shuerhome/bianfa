// 管理台 · 审计：谁、什么时候、对谁、做了什么。
// 「看了别人的内容」这件事本身也在这张表里（admin.content_viewed），管理台必须把它显示出来 ——
// 否则「查看会被记录」只是一句写在页面上的话，没人能真的去查。
import { Button } from "@bianfa/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type AdminAuditEntry, fetchAdminAudit } from "../../admin-api.js";
import { StateView } from "../../components/StateView.js";
import { actionLabelKey, formatTime, QueryError, useAdminQuery } from "./shared.js";

const PAGE_SIZE = 50;
const META_MAX = 160;

function metadataSummary(entry: AdminAuditEntry): string {
  if (!entry.metadata || Object.keys(entry.metadata).length === 0) return "—";
  const text = JSON.stringify(entry.metadata);
  return text.length > META_MAX ? `${text.slice(0, META_MAX)}…` : text;
}

export function AuditLog() {
  const { t } = useTranslation();
  const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useAdminQuery(`audit|${offset}`, () =>
    fetchAdminAudit({ limit: PAGE_SIZE, offset }),
  );

  if (error) return <QueryError failure={error} onRetry={reload} />;
  return (
    <section className="admin-section">
      <h2 className="admin-h2">{t("admin.audit.title")}</h2>
      <p className="web-hint">{t("admin.audit.desc")}</p>
      {!data ? (
        <StateView kind="loading" title={t("common.loading")} />
      ) : data.entries.length === 0 ? (
        <StateView kind="info" title={t("admin.audit.empty")} />
      ) : (
        <>
          <div className="admin-scroll">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">{t("admin.audit.at")}</th>
                  <th scope="col">{t("admin.audit.actor")}</th>
                  <th scope="col">{t("admin.audit.action")}</th>
                  <th scope="col">{t("admin.audit.target")}</th>
                  <th scope="col">{t("admin.audit.outcome")}</th>
                  <th scope="col">{t("admin.audit.metadata")}</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => {
                  const key = actionLabelKey(e.action);
                  return (
                    <tr key={String(e.id)}>
                      <td className="admin-nowrap">{formatTime(e.at)}</td>
                      <td>
                        {e.actor_email ?? e.actor_id ?? t("admin.audit.system")}
                        {e.actor_ip ? <span className="admin-list__meta"> {e.actor_ip}</span> : null}
                      </td>
                      <td>{key ? t(key) : e.action}</td>
                      <td className="web-mono">{e.target_id ?? e.target_type ?? "—"}</td>
                      <td>
                        {e.outcome === "denied" ? (
                          <span className="admin-tag admin-tag--danger">{t("admin.audit.denied")}</span>
                        ) : e.outcome === "error" ? (
                          <span className="admin-tag admin-tag--danger">{t("admin.audit.error")}</span>
                        ) : (
                          <span className="admin-tag">{t("admin.audit.success")}</span>
                        )}
                      </td>
                      <td className="admin-meta">{metadataSummary(e)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="admin-pager">
            <span className="web-hint">
              {t("admin.users.range", { from: offset + 1, to: offset + data.entries.length })}
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
