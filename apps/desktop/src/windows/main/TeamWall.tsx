// 团队墙（简，specs/06 §4.12）：占位实现——经 api_request 读 /v1/orgs/:id/notes，按颜色分列展示。
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchOrgNotes } from "../../api/notes.js";
import type { AuthStatus } from "../../ipc/types.js";
import { queryKeys } from "../../lib/query.js";
import { relativeTime } from "../../lib/time.js";
import { EmptyState } from "./EmptyState.js";

export function TeamWall({ auth }: { auth: AuthStatus | null }) {
  const { t } = useTranslation();
  const orgId = auth?.activeOrganizationId ?? null;
  const q = useQuery({
    queryKey: queryKeys.teamNotes(orgId ?? "-"),
    queryFn: () => fetchOrgNotes(orgId as string),
    enabled: orgId !== null,
  });

  if (!auth?.loggedIn) return <EmptyState title={t("team.loginFirst")} hint={t("team.loginHint")} />;
  if (!orgId) return <EmptyState title={t("team.noOrg")} hint={t("team.noOrgHint")} />;
  if (q.isLoading) {
    return (
      <div className="team-wall" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="team-col">
            <div className="bf-skeleton" style={{ width: "60%" }} />
            <div className="bf-skeleton" />
            <div className="bf-skeleton" style={{ width: "80%" }} />
          </div>
        ))}
      </div>
    );
  }
  if (q.isError) return <EmptyState title={t("team.loadFailed")} action={{ label: t("common.retry"), onClick: () => void q.refetch() }} />;
  const notes = q.data ?? [];
  if (notes.length === 0) return <EmptyState title={t("team.empty")} hint={t("team.emptyHint")} />;
  return (
    <div className="team-wall">
      {notes.map((n) => (
        <div key={n.id} className="note-card note-card--grid" data-color={n.color}>
          {n.editing ? (
            <div className="team-card__editing">{t("team.editing", { name: n.editing.name })}</div>
          ) : null}
          <div className="note-card__title">{n.title || t("note.untitled")}</div>
          <div className="note-card__excerpt">{n.excerpt}</div>
          <div className="note-card__meta tabular">
            <span className="note-card__dot" />
            <span>{relativeTime(n.updatedAt, t)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
