// 团队工作区：GET /v1/workspaces（kind=team、本 org）→ 选中工作区的便笺（GET /v1/workspaces/:id/notes）。
// 点卡片开窗（本地行不存在先按发现套路建行）；「新建团队便笺」= POST /v1/notes + note_create(workspaceId) + 开窗。
import { Button, useToast } from "@bianfa/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { OrgRole } from "../../../api/me.js";
import type { NotePerm, RemoteNoteSummary } from "../../../api/notes.js";
import {
  createTeamWorkspace,
  fetchActiveWorkspaceNotes,
  fetchTeamWorkspaces,
} from "../../../api/workspaces.js";
import { relativeTime } from "../../../lib/time.js";
import { EmptyState } from "../EmptyState.js";
import { NameDialog } from "./NameDialog.js";
import { createTeamNote, openRemoteNote } from "./open-remote-note.js";
import { describeTeamError } from "./team-errors.js";
import { teamKeys } from "./team-keys.js";

export interface WorkspacesTabProps {
  orgId: string;
  myRole: OrgRole;
}

const SKELETON = ["a", "b", "c", "d"];

const canWrite = (perm: NotePerm | null | undefined): boolean => perm === "editor" || perm === "manager";

export function WorkspacesTab({ orgId, myRole }: WorkspacesTabProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const workspaces = useQuery({
    queryKey: teamKeys.workspaces(orgId),
    queryFn: () => fetchTeamWorkspaces(orgId),
    retry: false,
  });
  const list = workspaces.data ?? [];
  const current = list.find((w) => w.id === selected) ?? list[0] ?? null;

  const notes = useQuery({
    queryKey: teamKeys.workspaceNotes(current?.id ?? "-"),
    queryFn: () => fetchActiveWorkspaceNotes(current?.id as string),
    enabled: current !== null,
    retry: false,
    staleTime: 15_000,
  });
  const writable = canWrite(notes.data?.effectivePerm ?? current?.effectivePerm);
  const isAdmin = myRole === "owner" || myRole === "admin";

  const open = async (n: RemoteNoteSummary) => {
    try {
      await openRemoteNote({
        id: n.id,
        workspaceId: n.workspaceId,
        color: n.color,
        zMode: n.zMode,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        deletedAt: n.deletedAt,
      });
    } catch {
      toast({ message: t("team.openFailed"), kind: "danger" });
    }
  };

  const newNote = async () => {
    if (!current || creating) return;
    setCreating(true);
    try {
      await createTeamNote(current.id);
      toast({ message: t("team.teamNoteCreated", { name: current.name }), kind: "success" });
      await client.invalidateQueries({ queryKey: teamKeys.workspaceNotes(current.id) });
    } catch (err) {
      toast({ message: describeTeamError(err, t), kind: "danger" });
    } finally {
      setCreating(false);
    }
  };

  const createWorkspace = async (name: string) => {
    const ws = await createTeamWorkspace(orgId, { name });
    toast({ message: t("team.workspaceCreated", { name: ws.name }), kind: "success" });
    await client.invalidateQueries({ queryKey: teamKeys.workspaces(orgId) });
    setSelected(ws.id);
    setCreateOpen(false);
  };

  if (workspaces.isLoading) {
    return (
      <div className="team-skeleton" aria-busy="true">
        {SKELETON.slice(0, 2).map((k) => (
          <div key={k} className="bf-skeleton" />
        ))}
      </div>
    );
  }
  if (workspaces.isError) {
    return (
      <EmptyState
        level="panel"
        title={t("team.workspacesLoadFailed")}
        hint={describeTeamError(workspaces.error, t)}
        action={{ label: t("common.retry"), onClick: () => void workspaces.refetch() }}
      />
    );
  }

  const createDialog = (
    <NameDialog
      open={createOpen}
      title={t("team.createWorkspaceTitle")}
      label={t("team.workspaceName")}
      submitLabel={t("team.create")}
      onSubmit={createWorkspace}
      onClose={() => setCreateOpen(false)}
    />
  );

  if (!current) {
    return (
      <>
        <EmptyState
          level="panel"
          title={t("team.noWorkspaces")}
          hint={t("team.noWorkspacesHint")}
          {...(isAdmin
            ? { action: { label: t("team.createWorkspace"), onClick: () => setCreateOpen(true) } }
            : {})}
        />
        {createDialog}
      </>
    );
  }

  return (
    <div className="team-panel">
      <div className="team-toolbar">
        <div className="team-ws-list" role="tablist" aria-label={t("team.workspaces")}>
          {list.map((w) => (
            <button
              key={w.id}
              type="button"
              role="tab"
              aria-selected={w.id === current.id}
              className={`team-ws-chip${w.id === current.id ? " team-ws-chip--current" : ""}`}
              onClick={() => setSelected(w.id)}
            >
              {w.name}
            </button>
          ))}
        </div>
        <div className="team-toolbar__spacer" />
        {isAdmin ? (
          <Button size="sm" variant="ghost" icon="plus" onClick={() => setCreateOpen(true)}>
            {t("team.createWorkspace")}
          </Button>
        ) : null}
        {!writable ? <span className="team-badge">{t("team.readOnly")}</span> : null}
        <Button
          size="sm"
          variant="primary"
          icon="plus"
          busy={creating}
          disabled={!writable}
          onClick={() => void newNote()}
        >
          {t("team.newTeamNote")}
        </Button>
      </div>
      {notes.isLoading ? (
        <div className="team-wall" aria-busy="true">
          {SKELETON.map((k) => (
            <div key={k} className="note-card note-card--grid note-card--skeleton">
              <div className="bf-skeleton" style={{ width: "70%" }} />
              <div className="bf-skeleton" />
              <div className="bf-skeleton" style={{ width: "85%" }} />
            </div>
          ))}
        </div>
      ) : notes.isError ? (
        <EmptyState
          level="panel"
          title={t("team.notesLoadFailed")}
          hint={describeTeamError(notes.error, t)}
          action={{ label: t("common.retry"), onClick: () => void notes.refetch() }}
        />
      ) : (notes.data?.notes.length ?? 0) === 0 ? (
        <EmptyState level="panel" title={t("team.empty")} hint={t("team.emptyHint")} />
      ) : (
        <ul className="team-wall" aria-label={current.name}>
          {(notes.data?.notes ?? []).map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className="note-card note-card--grid team-card"
                data-color={n.color}
                onClick={() => void open(n)}
              >
                <div className="note-card__title">{n.title || t("note.untitled")}</div>
                <div className="note-card__excerpt">{n.excerpt}</div>
                <div className="note-card__meta tabular">
                  <span className="note-card__dot" />
                  <span>{relativeTime(n.updatedAt, t)}</span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
      {createDialog}
    </div>
  );
}
