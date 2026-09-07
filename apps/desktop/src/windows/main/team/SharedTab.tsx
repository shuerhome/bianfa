// 共享给我：GET /v1/shared-with-me → 卡片（共享者 + 权限）；点开与团队工作区一样（先建本地行再开窗）。

import { useToast } from "@bianfa/ui";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { fetchSharedWithMe, type SharedWithMeItem } from "../../../api/shares.js";
import { relativeTime } from "../../../lib/time.js";
import { EmptyState } from "../EmptyState.js";
import { openRemoteNote } from "./open-remote-note.js";
import { describeTeamError } from "./team-errors.js";
import { teamKeys } from "./team-keys.js";

const SKELETON = ["a", "b", "c", "d"];

export function SharedTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const shared = useQuery({
    queryKey: teamKeys.sharedWithMe,
    queryFn: () => fetchSharedWithMe({ limit: 200 }),
    retry: false,
    staleTime: 15_000,
  });

  const open = async (item: SharedWithMeItem) => {
    try {
      await openRemoteNote({
        id: item.noteId,
        workspaceId: item.workspaceId,
        color: item.color,
        zMode: item.zMode,
        createdAt: item.updatedAt,
        updatedAt: item.updatedAt,
        deletedAt: null,
      });
    } catch {
      toast({ message: t("team.openFailed"), kind: "danger" });
    }
  };

  if (shared.isLoading) {
    return (
      <div className="team-wall" aria-busy="true">
        {SKELETON.map((k) => (
          <div key={k} className="note-card note-card--grid note-card--skeleton">
            <div className="bf-skeleton" style={{ width: "70%" }} />
            <div className="bf-skeleton" />
            <div className="bf-skeleton" style={{ width: "85%" }} />
          </div>
        ))}
      </div>
    );
  }
  if (shared.isError) {
    return (
      <EmptyState
        level="panel"
        title={t("team.sharedLoadFailed")}
        hint={describeTeamError(shared.error, t)}
        action={{ label: t("common.retry"), onClick: () => void shared.refetch() }}
      />
    );
  }
  const items = shared.data?.items ?? [];
  if (items.length === 0) {
    return <EmptyState level="panel" title={t("team.sharedEmpty")} hint={t("team.sharedEmptyHint")} />;
  }
  return (
    <ul className="team-wall" aria-label={t("team.sharedWithMe")}>
      {items.map((item) => (
        <li key={item.shareId}>
          <button
            type="button"
            className="note-card note-card--grid team-card"
            data-color={item.color}
            onClick={() => void open(item)}
          >
            <div className="team-card__sharer">
              <span>{t("team.sharedBy", { name: item.sharedBy.name || t("common.unknown") })}</span>
              <span className="team-badge">{t(`share.perm_${item.permission}`)}</span>
            </div>
            <div className="note-card__title">{item.title || t("note.untitled")}</div>
            <div className="note-card__excerpt" />
            <div className="note-card__meta tabular">
              <span className="note-card__dot" />
              <span>{relativeTime(item.updatedAt, t)}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
