// 主窗（specs/06 §4.2）：顶栏搜索 · 侧栏筛选（全部/桌面上/置顶/回收站/团队）· 卡片网格 · 批量条 · 命令面板 · 更新条。
import { Button, IconButton, Menu, MenuItem, MenuSeparator, useToast } from "@bianfa/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  authStatus,
  notesPurgeExpired,
  noticeAck,
  noticeGet,
  settingsWindowOpen,
  trashEmpty,
  updateCheck,
} from "../../ipc/commands.js";
import { useTauriEvent } from "../../ipc/events.js";
import type { NoteListItem } from "../../ipc/types.js";
import { closeNote, createNote, openNote, restoreNote, trashNote } from "../../lib/note-actions.js";
import { queryKeys } from "../../lib/query.js";
import { globalNewNoteLabel, shortcutLabel, useHotkeys } from "../../lib/shortcuts.js";
import { CommandPalette } from "./CommandPalette.js";
import { EmptyState } from "./EmptyState.js";
import { useDbInvalidation, useNotes } from "./hooks.js";
import { type Filter, useMainStore } from "./main-store.js";
import { NoteCard } from "./NoteCard.js";
import { TeamWall } from "./TeamWall.js";
import { UpdateBanner } from "./UpdateBanner.js";

const FILTERS: Filter[] = ["all", "open", "pinned", "trash", "team"];
const SKELETON_KEYS = Array.from({ length: 12 }, (_, i) => `sk-${i}`);

export function MainApp({ initialSection }: { initialSection: string | null }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const s = useMainStore();
  const [contextNote, setContextNote] = useState<NoteListItem | null>(null);
  const contextAnchor = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [notice, setNotice] = useState<{ id: string; title: string; body: string; severity: string } | null>(
    null,
  );
  useDbInvalidation();

  const notes = useNotes(s.filter, s.query, s.sort);
  const auth = useQuery({ queryKey: queryKeys.auth, queryFn: authStatus, retry: false });

  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅启动一次
  useEffect(() => {
    if (initialSection === "trash" || initialSection === "team") s.set({ filter: initialSection });
    void notesPurgeExpired().catch(() => undefined);
    void updateCheck(false)
      .then((r) => r.available && r.version && s.set({ updateBanner: { version: r.version } }))
      .catch(() => undefined);
    void noticeGet()
      .then((r) => r.notice && setNotice(r.notice))
      .catch(() => undefined);
  }, []);

  useTauriEvent("update:available", (p) => s.set({ updateBanner: { version: p.version, notes: p.notes } }));
  useTauriEvent("notice", (n) => setNotice(n));
  useTauriEvent("auth:changed", () => void auth.refetch());
  useTauriEvent("hotkey:new-note", () => void notes.refetch());
  useTauriEvent("sync:status", (p) => {
    if (p.state === "error" && p.detail?.startsWith("lost-access:")) {
      toast({
        message: t("sync.lostAccess", { title: p.detail.slice("lost-access:".length) }),
        kind: "warning",
      });
    }
    if (p.detail === "restored-by-edit") toast({ message: t("sync.restoredByEdit") });
  });

  const openContext = useCallback((note: NoteListItem, anchor: HTMLElement) => {
    contextAnchor.current = anchor;
    setContextNote(note);
  }, []);

  const bulkTrash = useCallback(async () => {
    const ids = Array.from(s.selected);
    for (const id of ids) await trashNote(id);
    s.set({ selected: new Set() });
    toast({
      message: t("list.deletedCount", { count: ids.length }),
      action: {
        label: t("common.undo"),
        onClick: () => {
          for (const id of ids) void restoreNote(id);
        },
      },
    });
  }, [s, toast, t]);

  useHotkeys((action) => {
    switch (action) {
      case "newNote":
        void createNote();
        return true;
      case "commandPalette":
        s.set({ paletteOpen: true });
        return true;
      case "find":
        searchRef.current?.focus();
        searchRef.current?.select();
        return true;
      case "settings":
        void settingsWindowOpen();
        return true;
      case "deleteNote":
        if (s.selected.size > 0) void bulkTrash();
        return true;
      default:
        return false;
    }
  });

  const filterLabel = (f: Filter) => t(`list.filter.${f}`);
  const emptyForFilter = () => {
    if (notes.searching) {
      return (
        <EmptyState
          title={t("empty.searchNoResult", { q: notes.parsed.text })}
          action={{ label: t("empty.createFromSearch"), onClick: () => void createNote() }}
        />
      );
    }
    switch (s.filter) {
      case "trash":
        return <EmptyState title={t("empty.trash")} hint={t("empty.trashHint")} />;
      case "open":
      case "pinned":
        return (
          <EmptyState
            title={t("empty.filtered")}
            action={{ label: t("empty.clearFilter"), onClick: () => s.set({ filter: "all" }) }}
          />
        );
      default:
        return (
          <EmptyState
            title={t("empty.noNotes")}
            hint={t("empty.noNotesHint", { key: globalNewNoteLabel() })}
            action={{ label: t("empty.createFirst"), onClick: () => void createNote() }}
          />
        );
    }
  };

  return (
    <div className="main">
      <header className="main-topbar">
        <div className="main-search">
          <input
            ref={searchRef}
            className="bf-input main-search__input"
            placeholder={t("list.searchPlaceholder")}
            value={s.query}
            onChange={(e) => s.set({ query: e.target.value })}
            aria-label={t("list.search")}
          />
          <kbd className="bf-kbd main-search__kbd">{shortcutLabel("commandPalette")}</kbd>
        </div>
        <div className="main-topbar__actions">
          <IconButton
            icon="layout-grid"
            label={t("list.viewGrid")}
            pressed={s.view === "grid"}
            onClick={() => s.set({ view: "grid" })}
          />
          <IconButton
            icon="layout-list"
            label={t("list.viewList")}
            pressed={s.view === "list"}
            onClick={() => s.set({ view: "list" })}
          />
          <select
            className="bf-select__native"
            value={s.sort}
            onChange={(e) => s.set({ sort: e.target.value as typeof s.sort })}
            aria-label={t("list.sort")}
          >
            <option value="updated">{t("list.sortUpdated")}</option>
            <option value="created">{t("list.sortCreated")}</option>
            <option value="title">{t("list.sortTitle")}</option>
            <option value="color">{t("list.sortColor")}</option>
          </select>
          <Button variant="primary" icon="plus" onClick={() => void createNote()}>
            {t("list.newNote")}
          </Button>
        </div>
      </header>
      {s.updateBanner ? (
        <UpdateBanner version={s.updateBanner.version} onDismiss={() => s.set({ updateBanner: null })} />
      ) : null}
      {notice ? (
        <div
          className={`bf-banner ${notice.severity === "block" ? "bf-banner--danger" : "bf-banner--warning"}`}
          role="alert"
        >
          <strong>{notice.title}</strong>
          <span>{notice.body}</span>
          <span className="bf-banner__spacer" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void noticeAck(notice.id);
              setNotice(null);
            }}
          >
            {t("common.gotIt")}
          </Button>
        </div>
      ) : null}
      <div className="main-body">
        <nav className="main-sidebar" aria-label={t("list.filters")}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className={`main-sidebar__item${s.filter === f ? " main-sidebar__item--current" : ""}`}
              aria-current={s.filter === f ? "page" : undefined}
              onClick={() => s.set({ filter: f, selected: new Set() })}
            >
              <span>{filterLabel(f)}</span>
            </button>
          ))}
          <div className="main-sidebar__spacer" />
          <button type="button" className="main-sidebar__item" onClick={() => void settingsWindowOpen()}>
            {t("app.settings")}
          </button>
        </nav>
        <main className="main-content">
          {s.filter === "team" ? (
            <TeamWall auth={auth.data ?? null} />
          ) : notes.isLoading ? (
            <div className="note-grid" aria-busy="true">
              {SKELETON_KEYS.map((k) => (
                <div key={k} className="note-card note-card--grid note-card--skeleton">
                  <div className="bf-skeleton" style={{ width: "70%" }} />
                  <div className="bf-skeleton" />
                  <div className="bf-skeleton" style={{ width: "85%" }} />
                </div>
              ))}
            </div>
          ) : notes.isError ? (
            <EmptyState
              title={t("empty.loadFailed")}
              hint={t("empty.loadFailedHint")}
              action={{ label: t("common.retry"), onClick: () => void notes.refetch() }}
            />
          ) : notes.items.length === 0 ? (
            emptyForFilter()
          ) : (
            <>
              {s.filter === "trash" ? (
                <div className="trash-head">
                  <span>{t("trash.autoPurge")}</span>
                  <Button
                    variant="danger-secondary"
                    size="sm"
                    onClick={() => {
                      if (window.confirm(t("trash.confirmEmpty")))
                        void trashEmpty().then((r) =>
                          toast({ message: t("trash.emptied", { count: r.purged }) }),
                        );
                    }}
                  >
                    {t("trash.empty")}
                  </Button>
                </div>
              ) : null}
              <div
                className={s.view === "grid" ? "note-grid" : "note-list"}
                role="listbox"
                aria-multiselectable="true"
                aria-label={filterLabel(s.filter)}
              >
                {notes.items.map((n) => (
                  <NoteCard
                    key={n.id}
                    note={n}
                    view={s.view}
                    selected={s.selected.has(n.id)}
                    onOpen={(note) =>
                      void (note.deletedAt === null ? openNote(note.id) : restoreNote(note.id))
                    }
                    onSelect={(note, multi) => s.toggleSelected(note.id, multi)}
                    onContextMenu={openContext}
                  />
                ))}
              </div>
            </>
          )}
        </main>
      </div>
      {s.selected.size > 0 ? (
        <div className="bottom-dock">
          <div className="bulk-bar">
            <span>{t("list.selectedCount", { count: s.selected.size })}</span>
            {s.filter === "trash" ? (
              <Button
                size="sm"
                icon="archive-restore"
                onClick={() => {
                  for (const id of s.selected) void restoreNote(id);
                  s.set({ selected: new Set() });
                }}
              >
                {t("trash.restore")}
              </Button>
            ) : (
              <Button size="sm" variant="danger-secondary" icon="trash-2" onClick={() => void bulkTrash()}>
                {t("note.delete")}
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => s.set({ selected: new Set() })}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      <Menu
        open={contextNote !== null}
        onClose={() => setContextNote(null)}
        anchorRef={contextAnchor}
        label={t("note.more")}
      >
        {contextNote?.deletedAt === null ? (
          <>
            <MenuItem icon="external-link" onSelect={() => contextNote && void openNote(contextNote.id)}>
              {t("list.open")}
            </MenuItem>
            {contextNote?.isOpen ? (
              <MenuItem icon="minimize-2" onSelect={() => contextNote && void closeNote(contextNote.id)}>
                {t("list.closeWindow")}
              </MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem icon="trash-2" danger onSelect={() => contextNote && void trashNote(contextNote.id)}>
              {t("note.delete")}
            </MenuItem>
          </>
        ) : (
          <MenuItem icon="archive-restore" onSelect={() => contextNote && void restoreNote(contextNote.id)}>
            {t("trash.restore")}
          </MenuItem>
        )}
      </Menu>
      <CommandPalette
        open={s.paletteOpen}
        onClose={() => s.set({ paletteOpen: false })}
        initialQuery={paletteQuery}
        onFilter={(q) => {
          setPaletteQuery(q);
          s.set({ query: q });
        }}
      />
    </div>
  );
}
