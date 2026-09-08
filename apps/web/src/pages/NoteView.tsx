// /notes?note=<id>：网页端打开一张便笺，直连同步服务实时编辑。
//
// 这一页只做三件事：开会话（sync/session.ts）、把 Y.Doc 交给 TipTap、把连接状态如实显示出来。
// 「如实」是重点：同步失败在浏览器里几乎全是静默的——握手被拒只给一个没有原因的 1006，
// 只读连接照样收键盘输入却永远存不上去。所以状态条宁可多说一句，也不留白。
import { Button, IconButton } from "@bianfa/ui";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { type MouseEvent, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { StateView } from "../components/StateView.js";
import { createWebNoteExtensions } from "../editor/extensions.js";
import type { WebNote } from "../notes-api.js";
import { navigate } from "../router.js";
import { openNoteSession, type SyncFailure } from "../sync/session.js";

export interface NoteViewProps {
  note: WebNote;
  /** 拆成两个原始值传：useSession 每次渲染都返回一个新对象，
      整个对象进 useMemo 依赖会让同步会话每渲染一次就重建一次。 */
  userId: string;
  userName: string;
  /** 返回列表（保留当前工作区） */
  backTo: string;
}

export function NoteView({ note, userId, userName, backTo }: NoteViewProps) {
  const { t } = useTranslation();
  // 每张便笺一个会话；换便笺时旧的必须先销毁——同一个 socket 上不能有两个同名 provider
  // （attach() 会直接抛 "Cannot attach two providers with the same effective name"）。
  const session = useMemo(
    () =>
      openNoteSession({
        workspaceId: note.workspace_id,
        noteId: note.id,
        user: { id: userId, name: userName },
        color: note.color,
      }),
    [note.workspace_id, note.id, note.color, userId, userName],
  );
  useEffect(() => () => session.destroy(), [session]);

  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);

  const editor = useEditor(
    {
      extensions: createWebNoteExtensions({
        doc: session.doc,
        undoManager: session.undoManager,
        placeholder: t("notes.placeholder"),
      }),
      editorProps: { attributes: { class: "bf-prose web-note__body" } },
      // 正文内容完全来自 Y.Doc，绝不能再给 content：那会在协同文档上再插一份初始内容。
      immediatelyRender: false,
      onUpdate: () => session.touch(),
    },
    [session],
  );

  // 权限是服务端说了算（onAuthenticated 的 scope）。在拿到答复之前先让用户能打字：
  // Yjs 会合并，握手完成后本地改动会补上去；反过来"先锁住等答复"在网络慢时就是一张死页面。
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(state.editable || state.failure === null);
  }, [editor, state.editable, state.failure]);

  return (
    <div className="web-note" data-color={note.color}>
      <div className="web-note__bar">
        <IconButton icon="arrow-left" label={t("common.back")} onClick={() => navigate(backTo)} />
        <span className="web-note__title">{note.title.trim() || t("notes.untitled")}</span>
        <SyncBadge state={state} />
      </div>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} className="web-note__editor" />
      <FailureNotice failure={state.failure} editable={state.editable} synced={state.synced} />
    </div>
  );
}

function SyncBadge({
  state,
}: {
  state: { synced: boolean; saving: boolean; connected: boolean; failure: SyncFailure | null };
}) {
  const { t } = useTranslation();
  const kind = state.failure
    ? "error"
    : state.saving
      ? "saving"
      : state.synced && state.connected
        ? "live"
        : "connecting";
  const label =
    kind === "error"
      ? t("notes.sync.offline")
      : kind === "saving"
        ? t("notes.sync.saving")
        : kind === "live"
          ? t("notes.sync.live")
          : t("notes.sync.connecting");
  return (
    <span className="web-note__sync" data-kind={kind} aria-live="polite">
      {kind === "connecting" || kind === "saving" ? (
        <span className="bf-spinner web-note__spinner" aria-hidden="true" />
      ) : null}
      {label}
    </span>
  );
}

/** 失败要说清楚是哪一种，以及还能不能继续打字 —— 这两件事用户判断不了 */
function FailureNotice({
  failure,
  editable,
  synced,
}: {
  failure: SyncFailure | null;
  editable: boolean;
  synced: boolean;
}) {
  const { t } = useTranslation();
  if (!failure) {
    // 服务端明确给了只读（viewer，或便笺 schema 比本端新）
    if (synced && !editable) return <p className="web-note__hint">{t("notes.sync.readonly")}</p>;
    return null;
  }
  const detail =
    failure === "unauthorized" ? (
      <Button variant="primary" size="lg" onClick={() => navigate("/login?next=%2Fnotes")}>
        {t("notes.sync.signIn")}
      </Button>
    ) : null;
  return <StateView kind="error" title={t(`notes.sync.failure.${failure}`)} actions={detail ?? undefined} />;
}

/**
 * 工具栏。两处必须照桌面端做，否则「选中文字点加粗没反应」会原样重现：
 *   ① mousedown 上 preventDefault —— 不吃掉的话焦点会离开 contenteditable，选区塌缩，
 *      等到 click 里再 focus() 已经晚了。
 *   ② 订阅 selectionUpdate / transaction —— 否则按钮的按下态永远不会重新求值。
 */
function Toolbar({ editor }: { editor: Editor | null }) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const onChange = () => setTick((n) => n + 1);
    editor.on("selectionUpdate", onChange);
    editor.on("transaction", onChange);
    return () => {
      editor.off("selectionUpdate", onChange);
      editor.off("transaction", onChange);
    };
  }, [editor]);

  const cmd = (fn: (e: Editor) => boolean) => ({
    onMouseDown: (ev: MouseEvent) => ev.preventDefault(),
    onClick: () => {
      if (editor) fn(editor);
    },
  });
  const active = (name: string) => (editor ? editor.isActive(name) : false);

  return (
    <div className="web-note__toolbar" role="toolbar" aria-label={t("notes.toolbar")}>
      <IconButton
        icon="bold"
        label={t("format.bold")}
        pressed={active("bold")}
        {...cmd((e) => e.chain().focus().toggleBold().run())}
      />
      <IconButton
        icon="italic"
        label={t("format.italic")}
        pressed={active("italic")}
        {...cmd((e) => e.chain().focus().toggleItalic().run())}
      />
      <IconButton
        icon="underline"
        label={t("format.underline")}
        pressed={active("underline")}
        {...cmd((e) => e.chain().focus().toggleUnderline().run())}
      />
      <IconButton
        icon="strikethrough"
        label={t("format.strike")}
        pressed={active("strike")}
        {...cmd((e) => e.chain().focus().toggleStrike().run())}
      />
      <IconButton
        icon="list"
        label={t("format.bulletList")}
        pressed={active("bulletList")}
        {...cmd((e) => e.chain().focus().toggleBulletList().run())}
      />
      <IconButton
        icon="list-todo"
        label={t("format.taskList")}
        pressed={active("taskList")}
        {...cmd((e) => e.chain().focus().toggleTaskList().run())}
      />
    </div>
  );
}
