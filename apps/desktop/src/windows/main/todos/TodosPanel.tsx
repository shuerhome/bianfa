// 待办页（跨便笺聚合 checklist 行）：分段 未完成 / 已完成 / 全部 · 范围 我的便笺（本机 todos_list）/ 团队工作区（服务端 /v1/todos
// + /v1/todos/summary 成员筛选）· 按便笺分组（标题 + 色点，点标题开窗）· 勾选 = 对该便笺正文的一次真实 CRDT 编辑
// （lib/checklist.ts），乐观显示、失败回滚。团队项若不在本机则不能勾选（sync host 目前只发现个人工作区）。
import "../../../styles/todos.css";
import { Button, type TabItem, Tabs, Tooltip, useToast } from "@bianfa/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteWorkspace } from "../../../api/workspaces.js";
import { noteWindowOpen } from "../../../ipc/commands.js";
import type { AuthStatus } from "../../../ipc/types.js";
import { ChecklistItemMissingError, setChecklistItemChecked } from "../../../lib/checklist.js";
import { keyCombo } from "../../../lib/platform.js";
import { EmptyState } from "../EmptyState.js";
import {
  filterBySegment,
  groupTodos,
  LOCAL_SCOPE,
  rowKey,
  type Segment,
  type TodoGroup,
  type TodoRowItem,
  useLocalNoteIds,
  useLocalTodos,
  useRemoteTodos,
  useTeamWorkspaces,
  useTodosSummary,
} from "./todos-data.js";

const SKELETON_KEYS = ["sk-0", "sk-1", "sk-2"];
const NO_WORKSPACES: RemoteWorkspace[] = [];

type Overrides = ReadonlyMap<string, boolean>;

export function TodosPanel({ auth }: { auth: AuthStatus | null }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const client = useQueryClient();
  const [segment, setSegment] = useState<Segment>("open");
  const [scope, setScope] = useState<string>(LOCAL_SCOPE);
  const [member, setMember] = useState<string | null>(null);
  /** 乐观勾选：rowKey → 目标状态；数据源追上（或该项消失）后自动清除 */
  const [overrides, setOverrides] = useState<Overrides>(new Map());

  const loggedIn = auth?.loggedIn === true;
  const remote = scope !== LOCAL_SCOPE;
  const includeDone = segment !== "open";

  const workspaces = useTeamWorkspaces(loggedIn);
  const teamWorkspaces = workspaces.data ?? NO_WORKSPACES;
  const local = useLocalTodos(!remote, includeDone);
  const remoteQ = useRemoteTodos(remote ? scope : null, includeDone, member);
  const summary = useTodosSummary(remote ? scope : null);
  const localIds = useLocalNoteIds(remote);

  // 登出 / 工作区不再可见 → 回到本机
  useEffect(() => {
    if (!remote) return;
    if (!loggedIn || (workspaces.isSuccess && !teamWorkspaces.some((w) => w.id === scope))) {
      setScope(LOCAL_SCOPE);
      setMember(null);
    }
  }, [remote, loggedIn, workspaces.isSuccess, teamWorkspaces, scope]);

  const rawItems: TodoRowItem[] = useMemo(
    () => (remote ? (remoteQ.data?.pages ?? []).flatMap((p) => p.items) : (local.data ?? [])),
    [remote, remoteQ.data, local.data],
  );

  // 数据源已反映乐观状态（或该项已不在列表里）→ 丢掉 override，避免遮住之后在便笺窗里的改动
  useEffect(() => {
    if (overrides.size === 0) return;
    const present = new Map(rawItems.map((i) => [rowKey(i), i.checked] as const));
    const next = new Map(overrides);
    for (const [k, v] of overrides) {
      const cur = present.get(k);
      if (cur === undefined || cur === v) next.delete(k);
    }
    if (next.size !== overrides.size) setOverrides(next);
  }, [rawItems, overrides]);

  // 先按分段过滤原始数据，再叠加乐观状态：刚勾掉的项在「未完成」里保留到下次刷新，而不是立刻消失
  const groups = useMemo(() => groupTodos(filterBySegment(rawItems, segment)), [rawItems, segment]);

  const isLocalNote = (noteId: string): boolean => !remote || (localIds.data?.has(noteId) ?? false);

  const openNote = (noteId: string) => {
    if (!isLocalNote(noteId)) {
      toast({ message: t("todos.notLocal"), kind: "warning" });
      return;
    }
    void noteWindowOpen(noteId, true).catch(() => toast({ message: t("common.failed"), kind: "danger" }));
  };

  const toggle = async (item: TodoRowItem, next: boolean) => {
    const k = rowKey(item);
    setOverrides((prev) => new Map(prev).set(k, next));
    try {
      await setChecklistItemChecked(item.noteId, item.blockId, next);
      // 本机列表与角标（db:changed 也会触发一次，这里保证不依赖事件时序）
      void client.invalidateQueries({ queryKey: ["notes", "todos"] });
    } catch (err) {
      setOverrides((prev) => {
        const m = new Map(prev);
        m.delete(k);
        return m;
      });
      const missing = err instanceof ChecklistItemMissingError;
      toast({ message: missing ? t("todos.itemMissing") : t("todos.toggleFailed"), kind: "danger" });
      if (missing) void client.invalidateQueries({ queryKey: ["notes", "todos"] });
    }
  };

  const segItems: TabItem<Segment>[] = [
    { key: "open", label: t("todos.seg.open") },
    { key: "done", label: t("todos.seg.done") },
    { key: "all", label: t("todos.seg.all") },
  ];

  const query = remote ? remoteQ : local;
  let body: ReactNode;
  if (query.isLoading) {
    body = (
      <div className="todos-list" aria-busy="true">
        {SKELETON_KEYS.map((k) => (
          <div key={k} className="todo-group todo-group--skeleton">
            <div className="bf-skeleton" style={{ width: "40%" }} />
            <div className="bf-skeleton" style={{ width: "85%" }} />
            <div className="bf-skeleton" style={{ width: "70%" }} />
          </div>
        ))}
      </div>
    );
  } else if (query.isError) {
    body = (
      <EmptyState
        title={t("todos.loadFailed")}
        action={{ label: t("common.retry"), onClick: () => void query.refetch() }}
      />
    );
  } else if (groups.length === 0) {
    body = remote ? (
      <EmptyState title={t("todos.emptyScope")} />
    ) : segment === "done" ? (
      <EmptyState title={t("todos.emptyDone")} />
    ) : (
      <EmptyState
        title={t("todos.empty")}
        hint={t("todos.emptyHint", { key: keyCombo({ mod: true, shift: true, key: "L" }) })}
      />
    );
  } else {
    body = (
      <div className="todos-list">
        {groups.map((g) => (
          <TodoGroupView
            key={g.noteId}
            group={g}
            segment={segment}
            local={isLocalNote(g.noteId)}
            overrides={overrides}
            onToggle={toggle}
            onOpen={openNote}
          />
        ))}
        {remote && remoteQ.hasNextPage ? (
          <Button
            variant="ghost"
            size="sm"
            className="todos-more"
            busy={remoteQ.isFetchingNextPage}
            onClick={() => void remoteQ.fetchNextPage()}
          >
            {t("todos.loadMore")}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="todos">
      <div className="todos-head">
        <Tabs<Segment> value={segment} onChange={setSegment} items={segItems} label={t("todos.segments")} />
        <div className="todos-head__scope">
          <select
            className="bf-select__native"
            aria-label={t("todos.scope")}
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setMember(null);
            }}
          >
            <option value={LOCAL_SCOPE}>{t("todos.scopeLocal")}</option>
            {teamWorkspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {remote ? (
            <select
              className="bf-select__native"
              aria-label={t("todos.member")}
              value={member ?? ""}
              onChange={(e) => setMember(e.target.value || null)}
            >
              <option value="">{t("todos.allMembers")}</option>
              {(summary.data?.byMember ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {`${m.name ?? t("common.unknown")} (${m.open})`}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </div>
      {body}
    </div>
  );
}

interface GroupProps {
  group: TodoGroup;
  segment: Segment;
  local: boolean;
  overrides: Overrides;
  onToggle: (item: TodoRowItem, next: boolean) => void;
  onOpen: (noteId: string) => void;
}

function TodoGroupView({ group, segment, local, overrides, onToggle, onOpen }: GroupProps) {
  const { t } = useTranslation();
  const headId = useId();
  const rows = group.items.map((item) => ({ item, checked: overrides.get(rowKey(item)) ?? item.checked }));
  const done = rows.filter((r) => r.checked).length;
  const total = rows.length;
  const meta =
    segment === "open"
      ? t("todos.openCount", { count: total - done })
      : segment === "done"
        ? t("todos.doneCount", { count: done })
        : t("todos.progress", { done, total });
  return (
    <section className="todo-group" data-color={group.color} aria-labelledby={headId}>
      <button
        id={headId}
        type="button"
        className="todo-group__head"
        title={local ? t("todos.openNote") : t("todos.notLocal")}
        onClick={() => onOpen(group.noteId)}
      >
        <span className="todo-group__dot" aria-hidden="true" />
        <span className="todo-group__title">{group.title || t("note.untitled")}</span>
        <span className="todo-group__meta tabular">{meta}</span>
      </button>
      <ul className="todo-group__items">
        {rows.map((r) => (
          <TodoRow
            key={r.item.blockId}
            item={r.item}
            checked={r.checked}
            local={local}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}

interface RowProps {
  item: TodoRowItem;
  checked: boolean;
  local: boolean;
  onToggle: (item: TodoRowItem, next: boolean) => void;
  onOpen: (noteId: string) => void;
}

/** 原生 checkbox：空格切换是浏览器语义；Enter 打开所在便笺 */
function TodoRow({ item, checked, local, onToggle, onOpen }: RowProps) {
  const { t } = useTranslation();
  const id = useId();
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      onOpen(item.noteId);
    }
  };
  const row = (
    <li className="todo-item" data-checked={checked ? "true" : "false"}>
      <input
        id={id}
        type="checkbox"
        className="todo-item__check"
        checked={checked}
        disabled={!local}
        onChange={(e) => onToggle(item, e.target.checked)}
        onKeyDown={onKeyDown}
      />
      <label htmlFor={id} className="todo-item__text">
        {item.text || t("todos.emptyItem")}
      </label>
    </li>
  );
  return local ? row : <Tooltip content={t("todos.notLocal")}>{row}</Tooltip>;
}
