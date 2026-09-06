import { describe, expect, it } from "vitest";
import { readImportExt, readMeta } from "../doc.js";
import { projectNoteDoc } from "../projector.js";
import { plumExportFixture } from "./__fixtures__/plum-export.js";
import { parsePlumExportFile, plumNoteToDocInit, plumNoteToNoteDoc, plumTimeToMs } from "./plum.js";

describe("plum JSON import", () => {
  const file = parsePlumExportFile(plumExportFixture);
  const byId = new Map(file.notes.map((n) => [n.external_id, n]));

  it("parses the exporter's notes.json shape", () => {
    expect(file.count).toBe(4);
    expect(file.notes.map((n) => n.external_id)).toEqual(["n-001", "n-003", "n-002", "n-005"]);
    expect(byId.get("n-002")?.window).toEqual({
      x: -1600,
      y: -240,
      w: 180,
      h: 140,
      display_id: "{DISPLAY2}",
    });
    expect(() => parsePlumExportFile({ ...plumExportFixture, notes: [{ external_id: "x" }] })).toThrow();
    expect(() =>
      parsePlumExportFile({
        ...plumExportFixture,
        notes: [{ ...plumExportFixture.notes[0], color: "Yellow" }],
      }),
    ).toThrow();
  });

  it("converts ISO times with the exporter's sanity window", () => {
    expect(plumTimeToMs("2025-08-24T02:26:40+00:00")).toBe(1756002400000);
    expect(plumTimeToMs(null)).toBeNull();
    expect(plumTimeToMs("not a date")).toBeNull();
    expect(plumTimeToMs("1800-01-01T00:00:00Z")).toBeNull();
    expect(plumTimeToMs("2200-01-01T00:00:00Z")).toBeNull();
  });

  it("maps color / pinned / times / ext.import for a normal note", () => {
    const note = byId.get("n-001");
    if (!note) throw new Error("fixture missing");
    const init = plumNoteToDocInit(note, { now: 123 });
    expect(init.meta).toEqual({
      color: "citron",
      zMode: 1,
      createdAt: 1756002400000,
      updatedAt: 1756802400000,
      deletedAt: null,
      schemaVersion: 1,
    });
    expect(init.ext.import).toEqual({
      source: "json",
      externalId: "n-001",
      contentSource: "Text",
      degraded: false,
      hasInk: false,
      originalTheme: "Yellow",
    });
    expect(init.isOpen).toBe(true);
    expect(init.attachments).toEqual([{ path: "media/abc123.png", mime: "image/png" }]);
    expect(init.fallbacks).toEqual({ createdAt: false, updatedAt: false });
    expect(init.content.content?.map((n) => n.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(init.content.content?.[0]?.content?.[1]).toEqual({
      type: "text",
      text: "产品评审",
      marks: [{ type: "bold" }],
    });
    expect(init.content.content?.[2]?.content?.[0]?.marks).toEqual([{ type: "italic" }]);
  });

  it("falls back on missing times and keeps degraded / ink flags", () => {
    const degraded = byId.get("n-005");
    const ink = byId.get("n-002");
    if (!degraded || !ink) throw new Error("fixture missing");
    const init = plumNoteToDocInit(degraded, { now: 999 });
    expect(init.meta.createdAt).toBe(1752500000000);
    expect(init.meta.updatedAt).toBe(1752500000000);
    expect(init.fallbacks).toEqual({ createdAt: true, updatedAt: false });
    expect(init.degraded).toBe(true);
    expect(init.ext.import.degraded).toBe(true);
    expect(init.ext.import.originalTheme).toBe("Teal");
    expect(init.window).toBeNull();
    expect(plumNoteToDocInit(ink).hasInk).toBe(true);
    const nothing = plumNoteToDocInit({ ...degraded, updated_at: null }, { now: 4242 });
    expect(nothing.meta).toMatchObject({ createdAt: 4242, updatedAt: 4242 });
    expect(nothing.fallbacks).toEqual({ createdAt: true, updatedAt: true });
  });

  it("builds a Y.Doc whose projection matches the exporter's plain text", () => {
    for (const note of file.notes) {
      const { doc, init } = plumNoteToNoteDoc(note, `id-${note.external_id}`, { now: 1 });
      expect(doc.guid).toBe(`id-${note.external_id}`);
      const projection = projectNoteDoc(doc);
      expect(projection.contentText).toBe(note.text);
      expect(projection.meta).toEqual(init.meta);
      expect(readMeta(doc).color).toBe(note.color);
      expect(readImportExt(doc)?.externalId).toBe(note.external_id);
      expect(projection.checklistItems).toEqual([]);
      expect(projection.attachmentIds).toEqual([]);
    }
    const strike = plumNoteToNoteDoc(byId.get("n-005") as NonNullable<ReturnType<typeof byId.get>>, "x");
    expect(projectNoteDoc(strike.doc).content.content?.[2]?.content?.[0]).toEqual({
      type: "text",
      text: "已买",
      marks: [{ type: "strike" }],
    });
  });
});
