// 便笺窗口（specs/06 §4.1）：顶栏 / 正文两级 / 底部条 / 颜色 popover / 更多菜单 / 右键 / 层级 / 快捷键 / 折叠 / 关闭动画。

import { applyUpdateV2, isNoteColor, type NoteColor, titleFromText, type ZMode } from "@bianfa/shared";
import { Menu, MenuItem, MenuSeparator, useToast } from "@bianfa/ui";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { countText, WARN_CHARS } from "../../editor/limits.js";
import {
  mainWindowOpen,
  noteDiscardIfEmpty,
  noteVersionGet,
  noteWindowClose,
  noteWindowSetCollapsed,
  noteWindowSetColor,
  noteWindowSetZmode,
  settingsWindowOpen,
  windowStateGet,
  windowStateSave,
} from "../../ipc/commands.js";
import { useTauriEvent } from "../../ipc/events.js";
import type { SyncStatusPayload } from "../../ipc/types.js";
import { fromB64 } from "../../lib/base64.js";
import { type NoteSession, openNoteSession } from "../../lib/doc-store.js";
import { createNote } from "../../lib/note-actions.js";
import { type ShortcutAction, shortcutLabel, useHotkeys } from "../../lib/shortcuts.js";
import { applyNoteColor } from "../../lib/theme.js";
import { debounce } from "../../lib/time.js";
import { effectiveState } from "../../sync/status-store.js";
import { ShareDialog } from "../main/team/ShareDialog.js";
import { ColorPopover } from "./ColorPopover.js";
import { NoteBody } from "./NoteBody.js";
import { useNoteStore } from "./note-store.js";
import { TitleBar } from "./TitleBar.js";
import { Toolbar } from "./Toolbar.js";

export interface NoteAppProps {
  noteId: string;
  fresh: boolean;
  initialColor?: NoteColor | undefined;
}

const EDITOR_DESTROY_AFTER_BLUR_MS = 5000;
const TOOLBAR_HIDE_AFTER_LEAVE_MS = 800;
const TOOLBAR_SHOW_AFTER_INPUT_MS = 3000;

export function NoteApp({ noteId, fresh, initialColor }: NoteAppProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const store = useNoteStore();
  const [session, setSession] = useState<NoteSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bodyHtml, setBodyHtml] = useState("");
  const [title, setTitle] = useState("");
  const [updatedAt, setUpdatedAt] = useState(Date.now());
  const [editor, setEditor] = useState<Editor | null>(null);
  const [globalSync, setGlobalSync] = useState<SyncStatusPayload | null>(null);
  const [noteSync, setNoteSync] = useState<SyncStatusPayload | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const colorBtnRef = useRef<HTMLButtonElement>(null);
  const toolbarColorBtnRef = useRef<HTMLButtonElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const contextAnchorRef = useRef<HTMLElement | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ current: HTMLElement | null }>(moreBtnRef);
  const blurTimer = useRef<number | null>(null);
  const toolbarTimer = useRef<number | null>(null);
  const closing = useRef(false);

  // ── 打开 / 创建 ──
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅在 noteId 变化时重开；store/t 经 getState 读取
  useEffect(() => {
    let alive = true;
    openNoteSession(noteId, { fresh, color: initialColor })
      .then(async (s) => {
        if (!alive) {
          s.destroy();
          return;
        }
        const ws = await windowStateGet(noteId).catch(() => null);
        const meta = s.projection;
        store.set({
          color: meta.color,
          zMode: meta.zMode,
          collapsed: ws?.collapsed ?? false,
          editorMounted: fresh,
          focused: fresh,
        });
        setSession(s);
        setBodyHtml(meta.bodyHtml);
        setTitle(titleFromText(meta.contentText));
        setUpdatedAt(meta.updatedAt);
        const counts = countText(meta.contentText);
        store.set({ chars: counts.chars, words: counts.words, longWarning: counts.chars > WARN_CHARS });
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [noteId, fresh, initialColor]);

  // 投影变化 → 静态 html / 标题 / 字数 / 颜色 / zMode
  useEffect(() => {
    if (!session) return;
    const off = session.onProjection((p) => {
      setBodyHtml(p.bodyHtml);
      setTitle(titleFromText(p.contentText));
      setUpdatedAt(p.updatedAt);
      const counts = countText(p.contentText);
      const patch: Partial<ReturnType<typeof useNoteStore.getState>> = {
        chars: counts.chars,
        words: counts.words,
        longWarning: counts.chars > WARN_CHARS,
      };
      if (p.color !== useNoteStore.getState().color) patch.color = p.color;
      if (p.zMode !== useNoteStore.getState().zMode) patch.zMode = p.zMode;
      useNoteStore.getState().set(patch);
    });
    return () => {
      off();
    };
  }, [session]);

  useEffect(() => () => session?.destroy(), [session]);

  // data-color 写在容器上；同帧 Rust set_background_color 由换色动作触发
  useEffect(() => {
    if (rootRef.current) applyNoteColor(rootRef.current, store.color);
  }, [store.color]);

  // 标题：首行前 20 字 + · 便笺（防抖）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const head = Array.from(title).slice(0, 20).join("");
      document.title = head ? `${head} · ${t("app.noteSuffix")}` : t("app.noteSuffix");
      void getCurrentWindow()
        .setTitle(document.title)
        .catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [title, t]);

  // ── 焦点 → 两级编辑器 ──
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        useNoteStore.getState().set({ focused });
        if (rootRef.current) rootRef.current.dataset.focused = String(focused);
        if (focused) {
          if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
          blurTimer.current = null;
          useNoteStore.getState().set({ editorMounted: true });
        } else {
          void session?.snapshot();
          useNoteStore.getState().set({ overlay: "none", toolbarVisible: false });
          blurTimer.current = window.setTimeout(() => {
            useNoteStore.getState().set({ editorMounted: false, hasSelection: false });
            setEditor(null);
          }, EDITOR_DESTROY_AFTER_BLUR_MS);
        }
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [session]);

  // ── 位置 / 尺寸记忆（moved/resized 防抖 300 ms） ──
  useEffect(() => {
    const win = getCurrentWindow();
    const save = debounce(() => {
      void (async () => {
        const [pos, size, scale] = await Promise.all([
          win.outerPosition(),
          win.innerSize(),
          win.scaleFactor(),
        ]);
        await windowStateSave({ noteId, x: pos.x, y: pos.y, w: size.width, h: size.height, scale });
      })().catch(() => undefined);
    }, 300);
    const offs: Array<() => void> = [];
    let disposed = false;
    Promise.all([win.onMoved(() => save()), win.onResized(() => save())])
      .then((us) => {
        if (disposed) for (const u of us) u();
        else offs.push(...us);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      save.cancel();
      for (const u of offs) u();
    };
  }, [noteId]);

  // ── db:changed / sync:status / focus-request ──
  useTauriEvent("db:changed", (p) => {
    if (
      p.origin === "local" &&
      p.ids.length === 1 &&
      p.ids[0] === noteId &&
      p.tables.length === 1 &&
      p.tables[0] === "note_window_state"
    )
      return;
    if (p.ids.includes(noteId) && session) void session.applyRemoteSince();
  });
  useTauriEvent("sync:status", (p) => {
    if (p.noteId === undefined) setGlobalSync(p);
    else if (p.noteId === noteId) {
      setNoteSync(p);
      if (p.state === "error" && p.detail?.startsWith("shrink_guard")) {
        const id = p.detail.split(":")[1] ?? null;
        useNoteStore.getState().set({ shrinkBanner: { versionId: id } });
      }
    }
  });
  useTauriEvent("note:focus-request", (p) => {
    if (p.noteId === noteId)
      void getCurrentWindow()
        .setFocus()
        .catch(() => undefined);
  });
  useEffect(() => {
    const st = effectiveState(globalSync, noteSync);
    useNoteStore.getState().set({
      syncState: st,
      syncDetail: noteSync?.detail ?? globalSync?.detail,
      offlineBanner: st === "offline",
    });
  }, [globalSync, noteSync]);

  // ── 首帧后 show()（Rust 以 visible:false 建窗） ──
  useEffect(() => {
    if (!session) return;
    requestAnimationFrame(() =>
      requestAnimationFrame(
        () =>
          void getCurrentWindow()
            .show()
            .catch(() => undefined),
      ),
    );
  }, [session]);

  // ── 动作 ──
  const setColor = useCallback(
    (color: NoteColor) => {
      if (!session) return;
      session.updateMeta({ color });
      useNoteStore.getState().set({ color });
      void noteWindowSetColor(noteId, color).catch(() => undefined);
    },
    [session, noteId],
  );

  const setZMode = useCallback(
    (zMode: ZMode) => {
      if (!session) return;
      session.updateMeta({ zMode });
      useNoteStore.getState().set({ zMode });
      void noteWindowSetZmode(noteId, zMode).catch(() => undefined);
    },
    [session, noteId],
  );

  const togglePin = useCallback(() => setZMode(store.zMode === 1 ? 0 : 1), [setZMode, store.zMode]);

  const toggleCollapse = useCallback(() => {
    const next = !useNoteStore.getState().collapsed;
    useNoteStore.getState().set({ collapsed: next });
    void noteWindowSetCollapsed(noteId, next).catch(() => undefined);
  }, [noteId]);

  const closeWindow = useCallback(async () => {
    if (closing.current) return;
    closing.current = true;
    const shell = rootRef.current?.querySelector<HTMLElement>(".note-shell");
    shell?.classList.add("note-shell--closing");
    try {
      await session?.snapshot();
      await noteDiscardIfEmpty(noteId).catch(() => undefined);
    } finally {
      window.setTimeout(() => void noteWindowClose(noteId).catch(() => getCurrentWindow().close()), 140);
    }
  }, [noteId, session]);

  const deleteToTrash = useCallback(() => {
    if (!session) return;
    session.updateMeta({ deletedAt: Date.now() });
    toast({
      message: t("note.deletedToast"),
      action: { label: t("common.undo"), onClick: () => session.updateMeta({ deletedAt: null }) },
    });
    void closeWindow();
  }, [session, toast, t, closeWindow]);

  const flushSave = useCallback(() => {
    if (!session) return;
    void session.flush().then(() => {
      useNoteStore.getState().set({ savedAck: true });
      window.setTimeout(() => useNoteStore.getState().set({ savedAck: false }), 900);
    });
  }, [session]);

  const insertLink = useCallback(() => {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const href = window.prompt(t("format.linkPrompt"), prev ?? "https://");
    if (href === null) return;
    if (href.trim() === "") editor.chain().focus().unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: href.trim() }).run();
  }, [editor, t]);

  const restoreShrink = useCallback(async () => {
    const banner = useNoteStore.getState().shrinkBanner;
    if (!session || !banner?.versionId) return;
    try {
      const { stateV2B64 } = await noteVersionGet(banner.versionId);
      // 作为一次新的 CRDT 编辑追加：把合并前状态再合并回来（不删历史，可再撤销）
      session.doc.transact(() => applyUpdateV2(session.doc, fromB64(stateV2B64), "local"), "local");
      useNoteStore.getState().set({ shrinkBanner: null });
      toast({ message: t("note.shrinkRestored"), kind: "success" });
    } catch {
      toast({ message: t("common.failed"), kind: "danger" });
    }
  }, [session, toast, t]);

  const showToolbarBriefly = useCallback(() => {
    useNoteStore.getState().set({ toolbarVisible: true });
    if (toolbarTimer.current !== null) window.clearTimeout(toolbarTimer.current);
    toolbarTimer.current = window.setTimeout(
      () => useNoteStore.getState().set({ toolbarVisible: false }),
      TOOLBAR_SHOW_AFTER_INPUT_MS,
    );
  }, []);

  // ── 快捷键 ──
  useHotkeys((action: ShortcutAction, e) => {
    if (action.startsWith("color:")) {
      const c = action.slice(6);
      if (isNoteColor(c)) setColor(c);
      return true;
    }
    switch (action) {
      case "newNote":
        void createNote();
        return true;
      case "closeNote":
        void closeWindow();
        return true;
      case "deleteNote":
        deleteToTrash();
        return true;
      case "togglePin":
        togglePin();
        return true;
      case "save":
        flushSave();
        return true;
      case "undo":
        session?.undoManager.undo();
        return true;
      case "redo":
        session?.undoManager.redo();
        return true;
      case "link":
        insertLink();
        return true;
      case "taskList":
        editor?.chain().focus().toggleTaskList().run();
        return true;
      case "strike":
        editor?.chain().focus().toggleStrike().run();
        return true;
      case "formatFocus": {
        useNoteStore.getState().set({ toolbarMode: "format", toolbarVisible: true });
        const first = rootRef.current?.querySelector<HTMLElement>(
          ".note-toolbar__group--format button:not([aria-hidden])",
        );
        first?.focus();
        return true;
      }
      case "openList":
        void mainWindowOpen("notes");
        return true;
      case "settings":
        void settingsWindowOpen();
        return true;
      case "find":
      case "commandPalette":
        void mainWindowOpen("notes");
        return true;
      case "uiScaleUp":
      case "uiScaleDown":
      case "uiScaleReset":
        e.preventDefault();
        return true;
      default:
        return false;
    }
  });

  // Esc 七级链（便笺内的可用级）：浮层 → 格式条 → 选区 → 底部条 → 编辑器失焦
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.keyCode === 229) return;
      const s = useNoteStore.getState();
      if (s.overlay !== "none") return; // Popover 自己处理
      if (s.toolbarMode === "format") return s.set({ toolbarMode: "object" });
      if (s.hasSelection && editor) return editor.commands.setTextSelection(editor.state.selection.to);
      if (s.toolbarVisible) return s.set({ toolbarVisible: false });
      editor?.commands.blur();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor]);

  if (error) {
    return (
      <div className="note-error" role="alert">
        <p>{t("note.loadFailed")}</p>
        <p className="note-error__detail">{error}</p>
      </div>
    );
  }
  if (!session) return <div className="note-loading" aria-busy="true" />;

  const openMenu = (anchor: HTMLElement) => {
    contextAnchorRef.current = anchor;
    setMenuAnchor(contextAnchorRef);
    store.set({ overlay: "menu" });
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 窗口根容器只承载悬停/右键的工具栏显隐，无独立语义
    <div
      ref={rootRef}
      className="note"
      data-color={store.color}
      data-focused={String(store.focused)}
      data-collapsed={String(store.collapsed)}
      data-zmode={store.zMode}
      onPointerEnter={showToolbarBriefly}
      onPointerLeave={() => {
        if (!useNoteStore.getState().hasSelection) {
          if (toolbarTimer.current !== null) window.clearTimeout(toolbarTimer.current);
          toolbarTimer.current = window.setTimeout(
            () => useNoteStore.getState().set({ toolbarVisible: false }),
            TOOLBAR_HIDE_AFTER_LEAVE_MS,
          );
        }
      }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("[contenteditable]") && !useNoteStore.getState().hasSelection) {
          e.preventDefault();
          openMenu(e.target as HTMLElement);
        }
      }}
      onKeyDown={showToolbarBriefly}
    >
      <div className="note-window">
        <div className="note-shell">
          <TitleBar
            title={title}
            updatedAt={updatedAt}
            chars={store.chars}
            colorButtonRef={colorBtnRef}
            moreButtonRef={moreBtnRef}
            onColorClick={() => store.set({ overlay: store.overlay === "color" ? "none" : "color" })}
            onMoreClick={() => moreBtnRef.current && openMenu(moreBtnRef.current)}
            onTogglePin={togglePin}
            onClose={() => void closeWindow()}
            onToggleCollapse={toggleCollapse}
            onSyncClick={() => void settingsWindowOpen("sync")}
          />
          {store.collapsed ? null : (
            <>
              {store.shrinkBanner ? (
                <div className="note-banner note-banner--warning" role="alert">
                  <span>{t("note.shrinkBanner")}</span>
                  <button
                    type="button"
                    className="note-banner__btn"
                    onClick={() => void settingsWindowOpen("sync")}
                  >
                    {t("note.shrinkView")}
                  </button>
                  <button type="button" className="note-banner__btn" onClick={() => void restoreShrink()}>
                    {t("note.shrinkRestore")}
                  </button>
                  <button
                    type="button"
                    className="note-banner__btn"
                    aria-label={t("common.close")}
                    onClick={() => store.set({ shrinkBanner: null })}
                  >
                    ✕
                  </button>
                </div>
              ) : null}
              {store.longWarning ? (
                <div className="note-banner note-banner--info" role="status">
                  {t("note.longWarning")}
                </div>
              ) : null}
              <NoteBody
                session={session}
                bodyHtml={bodyHtml}
                mountEditor={store.editorMounted}
                editable={!(store.zMode === 2 && document.documentElement.dataset.desktopPinReadonly === "1")}
                onEditorReady={(ed) => {
                  setEditor(ed);
                  if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
                }}
                onPasteRejected={() => toast({ message: t("note.pasteTooLong"), kind: "warning" })}
                onAttachmentFailures={(f) =>
                  toast({
                    message: f.includes("too_large")
                      ? t("note.imageTooLarge")
                      : f.includes("unsupported")
                        ? t("note.imageUnsupported")
                        : t("note.imageFailed"),
                    kind: "warning",
                  })
                }
                onSelectionChange={(has) =>
                  useNoteStore
                    .getState()
                    .set({ hasSelection: has, toolbarVisible: has || useNoteStore.getState().toolbarVisible })
                }
              />
              <div className="note-fade" aria-hidden="true" />
              {store.offlineBanner ? (
                <div className="note-inline-status" role="status">
                  {t("sync.offlineInline")}
                </div>
              ) : null}
              <Toolbar
                editor={editor}
                colorButtonRef={toolbarColorBtnRef}
                onColorClick={() => store.set({ overlay: "color" })}
                onTogglePin={togglePin}
                onMoreClick={openMenu}
                onInsertLink={insertLink}
              />
              <div className="note-grip" aria-hidden="true" />
            </>
          )}
          {store.savedAck ? (
            <span className="note-ack" role="status">
              ✓
            </span>
          ) : null}
        </div>
      </div>
      <ColorPopover
        open={store.overlay === "color"}
        onClose={() => store.set({ overlay: "none" })}
        anchorRef={
          store.focused && store.toolbarVisible && toolbarColorBtnRef.current
            ? toolbarColorBtnRef
            : colorBtnRef
        }
        value={store.color}
        onChange={setColor}
      />
      <Menu
        open={store.overlay === "menu"}
        onClose={() => store.set({ overlay: "none" })}
        anchorRef={menuAnchor}
        label={t("note.more")}
      >
        <MenuItem
          icon="pin"
          shortcut={shortcutLabel("togglePin")}
          checked={store.zMode === 1}
          onSelect={togglePin}
        >
          {t("note.pin")}
        </MenuItem>
        <MenuItem
          icon="monitor"
          checked={store.zMode === 2}
          onSelect={() => setZMode(store.zMode === 2 ? 0 : 2)}
        >
          {t("note.dockToDesktop")}
        </MenuItem>
        <MenuItem icon="minimize-2" onSelect={toggleCollapse}>
          {store.collapsed ? t("note.expand") : t("note.collapse")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon="copy" onSelect={() => void navigator.clipboard.writeText(`bianfa://note/${noteId}`)}>
          {t("note.copyLink")}
        </MenuItem>
        <MenuItem
          icon="users"
          onSelect={() => {
            store.set({ overlay: "none" });
            setShareOpen(true);
          }}
        >
          {t("share.menu")}
        </MenuItem>
        <MenuItem
          icon="layout-grid"
          shortcut={shortcutLabel("openList")}
          onSelect={() => void mainWindowOpen("notes")}
        >
          {t("note.showInList")}
        </MenuItem>
        <MenuItem icon="file-down" onSelect={() => void settingsWindowOpen("data")}>
          {t("note.exportMd")}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon="trash-2" danger shortcut={shortcutLabel("deleteNote")} onSelect={deleteToTrash}>
          {t("note.delete")}
        </MenuItem>
      </Menu>
      <ShareDialog open={shareOpen} noteId={noteId} noteTitle={title} onClose={() => setShareOpen(false)} />
    </div>
  );
}
