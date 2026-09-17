// /note?ws=<id>&note=<id>：一张便笺的独立窗口（列表页用 window.open 弹出来的那种）。
//
// 和 /notes 分开是有理由的：这个页面没有列表那一圈外壳，而且它是**独立的浏览器窗口**——
// 关掉列表窗口它照样在，这正是"退出列表后便笺还留在屏幕上"要的行为。
//
// 它不经过列表，所以拿不到列表缓存里的那份元信息，要自己 GET /v1/notes/:id。
import { Button } from "@bianfa/ui";
import { useTranslation } from "react-i18next";
import { StateView } from "../components/StateView.js";
import { describeFailure } from "../lib/errors.js";
import { useQuery } from "../lib/query.js";
import { useRequireSession } from "../lib/session.js";
import { fetchNote } from "../notes-api.js";
import { queryOf } from "../router.js";
import { NoteView } from "./NoteView.js";

/** 同一张便笺只对应一个窗口：window.open 的 name 用它，再点一次是聚焦而不是再开一个 */
export function noteWindowName(noteId: string): string {
  return `bianfa-note-${noteId}`;
}

export function NoteWindow({ search }: { search: string }) {
  const { t } = useTranslation();
  const { user, pending } = useRequireSession("/notes");
  const q = queryOf(search);
  const noteId = q.get("note") ?? "";
  const note = useQuery(`note|${noteId}`, () =>
    noteId
      ? fetchNote(noteId)
      : Promise.resolve({
          ok: false as const,
          error: { status: 400, code: "missing_note_id", message: "" },
        }),
  );

  if (pending || !user || (!note.data && !note.error)) {
    return <StateView kind="loading" title={t("common.loading")} />;
  }
  if (note.error) {
    return (
      <StateView
        kind="error"
        title={note.error.status === 404 ? t("notes.notFound") : describeFailure(note.error)}
        actions={
          <Button variant="primary" size="lg" onClick={note.reload}>
            {t("common.retry")}
          </Button>
        }
      />
    );
  }
  if (!note.data) return null;
  if (note.data.encryption === "e2ee") {
    return <StateView kind="info" title={t("notes.encrypted")} />;
  }

  // backTo 传 null：独立窗口里没有"返回列表"这回事，关窗口用浏览器自己的按钮
  return <NoteView note={note.data} userId={user.id} userName={user.name || user.email} backTo={null} />;
}
