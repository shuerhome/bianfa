import { getBody, openNoteDoc, readMeta } from "@bianfa/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { buildProjection } from "../editor/projection.js";
import { fromB64, toB64 } from "../lib/base64.js";
import { openNoteSession, withNoteDoc } from "../lib/doc-store.js";
import { invokeMock, mockCommand, resetCommands } from "./setup.js";

const NOTE_ID = "01920000-0000-7000-8000-000000000001";

/** 内存版 Rust：note_create / note_append_update / note_load_doc / note_updates_since / note_write_snapshot */
function fakeDb() {
  const updates: string[] = [];
  let created: { updateV2B64: string } | null = null;
  mockCommand("note_create", (args) => {
    created = { updateV2B64: args.updateV2B64 as string };
    updates.push(created.updateV2B64);
    return { id: args.noteId, headSeq: 1, bodyHtml: "", contentText: "" };
  });
  mockCommand("note_append_update", (args) => {
    updates.push(args.updateV2B64 as string);
    return { seq: updates.length };
  });
  mockCommand("note_load_doc", () => ({
    snapshotB64: null,
    snapshotUptoSeq: 0,
    updatesB64: [...updates],
    headSeq: updates.length,
  }));
  mockCommand("note_updates_since", (args) => {
    const after = args.afterSeq as number;
    return { updatesB64: updates.slice(after), headSeq: updates.length };
  });
  mockCommand("note_write_snapshot", () => undefined);
  return { updates };
}

function typeInto(doc: Y.Doc, text: string, origin: unknown) {
  doc.transact(() => {
    const body = getBody(doc);
    const p = new Y.XmlElement("paragraph");
    const t = new Y.XmlText();
    t.insert(0, text);
    p.insert(0, [t]);
    body.insert(body.length, [p]);
  }, origin);
}

describe("doc store", () => {
  beforeEach(() => resetCommands());
  afterEach(() => resetCommands());

  it("fresh：createNoteDoc → note_create，投影含 bigram 与 bodyHtml", async () => {
    const db = fakeDb();
    const s = await openNoteSession(NOTE_ID, { fresh: true, color: "citron" });
    expect(invokeMock).toHaveBeenCalledWith("note_create", expect.objectContaining({ noteId: NOTE_ID }));
    expect(s.projection.color).toBe("citron");
    expect(s.headSeq).toBe(1);

    typeInto(s.doc, "买牛奶 and eggs", "local");
    await s.flush();
    expect(db.updates.length).toBe(2);
    const call = invokeMock.mock.calls.find((c) => c[0] === "note_append_update");
    if (!call) throw new Error("note_append_update 未被调用");
    const projection = (call[1] as { projection: ReturnType<typeof buildProjection> }).projection;
    expect(projection.contentText).toBe("买牛奶 and eggs");
    expect(projection.contentBigram).toContain("买牛 牛奶");
    expect(projection.bodyHtml).toContain("<p>买牛奶 and eggs</p>");
    expect(projection.color).toBe("citron");
    s.destroy();
  });

  it("round-trip：落库的 update 重建出相同文档；db:changed 增量应用为 remote", async () => {
    const db = fakeDb();
    const s = await openNoteSession(NOTE_ID, { fresh: true });
    typeInto(s.doc, "第一行", "local");
    await s.flush();
    const rebuilt = openNoteDoc(NOTE_ID, db.updates.map(fromB64), "load");
    expect(getBody(rebuilt).toString()).toBe(getBody(s.doc).toString());
    expect(readMeta(rebuilt).color).toBe("graphite");

    // 另一个端写入（直接塞进「库」），本窗口通过 note_updates_since 拉取
    typeInto(rebuilt, "远端一行", "other");
    db.updates.push(toB64(Y.encodeStateAsUpdateV2(rebuilt)));
    await s.applyRemoteSince();
    expect(getBody(s.doc).toString()).toContain("远端一行");
    expect(s.headSeq).toBe(db.updates.length);
    // 远端应用不再回写
    const appends = invokeMock.mock.calls.filter((c) => c[0] === "note_append_update").length;
    await s.flush();
    expect(invokeMock.mock.calls.filter((c) => c[0] === "note_append_update").length).toBe(appends);
    s.destroy();
  });

  it("withNoteDoc：改 meta 并落库一条 update，投影反映 deletedAt", async () => {
    fakeDb();
    const s = await openNoteSession(NOTE_ID, { fresh: true });
    s.destroy();
    const res = await withNoteDoc(NOTE_ID, (doc) => doc.getMap("meta").set("deletedAt", 123));
    expect(res.projection.deletedAt).toBe(123);
    expect(invokeMock).toHaveBeenCalledWith(
      "note_append_update",
      expect.objectContaining({ origin: "local" }),
    );
  });

  it("IME 组合期挂起远端应用，compositionend 后放行", async () => {
    const db = fakeDb();
    const s = await openNoteSession(NOTE_ID, { fresh: true });
    const other = openNoteDoc(NOTE_ID, db.updates.map(fromB64), "load");
    typeInto(other, "远端", "other");
    db.updates.push(toB64(Y.encodeStateAsUpdateV2(other)));
    s.setComposing(true);
    await s.applyRemoteSince();
    expect(getBody(s.doc).toString()).not.toContain("远端");
    s.setComposing(false);
    await new Promise((r) => setTimeout(r, 0));
    await s.applyRemoteSince();
    expect(getBody(s.doc).toString()).toContain("远端");
    s.destroy();
  });
});
