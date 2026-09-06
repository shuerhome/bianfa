import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyUpdateV2,
  BODY_FIELD,
  createNoteDoc,
  EXT_MAP,
  encodeStateV2,
  getBody,
  getMetaMap,
  META_MAP,
  Origins,
  openNoteDoc,
  readImportExt,
  readMeta,
  writeImportExt,
  writeMeta,
  ZMode,
} from "./doc.js";

describe("doc", () => {
  it("freezes the field names", () => {
    expect(BODY_FIELD).toBe("body");
    expect(META_MAP).toBe("meta");
    expect(EXT_MAP).toBe("ext");
    expect(ZMode).toEqual({ normal: 0, pinned: 1, desktop: 2 });
    expect(Origins).toEqual({ local: "local", remote: "remote", import: "import", ai: "ai" });
  });

  it("createNoteDoc sets guid, gc and default meta", () => {
    const doc = createNoteDoc("0192b1c0-0000-7000-8000-000000000001", { now: 1_700_000_000_000 });
    expect(doc.guid).toBe("0192b1c0-0000-7000-8000-000000000001");
    expect(doc.gc).toBe(true);
    expect(readMeta(doc)).toEqual({
      color: "graphite",
      zMode: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      deletedAt: null,
      schemaVersion: 1,
    });
    expect(doc.share.has("body")).toBe(true);
    expect(getBody(doc).length).toBe(0);
    expect(() => createNoteDoc("")).toThrow();
  });

  it("createNoteDoc honours init meta/ext and origin", () => {
    const origins: unknown[] = [];
    const doc = new Y.Doc();
    doc.on("update", () => {});
    const created = (() => {
      const d = createNoteDoc("n1", {
        meta: { color: "rose", zMode: 2, createdAt: 10, updatedAt: 20 },
        ext: { hello: "world" },
        origin: Origins.import,
      });
      return d;
    })();
    expect(readMeta(created)).toMatchObject({ color: "rose", zMode: 2, createdAt: 10, updatedAt: 20 });
    expect(created.getMap("ext").get("hello")).toBe("world");

    const observed = createNoteDoc("n2");
    observed.on("afterTransaction", (tr) => origins.push(tr.origin));
    writeMeta(observed, { color: "teal" }, Origins.ai);
    expect(origins).toEqual([Origins.ai]);
  });

  it("readMeta falls back on missing or garbage values", () => {
    const doc = new Y.Doc({ guid: "n3" });
    expect(readMeta(doc)).toEqual({
      color: "graphite",
      zMode: 0,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      schemaVersion: 1,
    });
    const map = getMetaMap(doc);
    map.set("color", "neon");
    map.set("zMode", 7);
    map.set("createdAt", "yesterday");
    map.set("updatedAt", 1234.9);
    map.set("deletedAt", -1);
    map.set("schemaVersion", 0);
    expect(readMeta(doc)).toEqual({
      color: "graphite",
      zMode: 0,
      createdAt: 0,
      updatedAt: 1234,
      deletedAt: null,
      schemaVersion: 1,
    });
    map.set("zMode", 2);
    map.set("deletedAt", 5);
    expect(readMeta(doc)).toMatchObject({ zMode: 2, deletedAt: 5 });
  });

  it("writeMeta patches keys in one transaction and validates", () => {
    const doc = createNoteDoc("n4", { now: 1 });
    let transactions = 0;
    doc.on("afterTransaction", () => {
      transactions += 1;
    });
    const meta = writeMeta(doc, { color: "azure", deletedAt: 99, zMode: 1 }, Origins.local);
    expect(transactions).toBe(1);
    expect(meta).toMatchObject({ color: "azure", deletedAt: 99, zMode: 1, createdAt: 1 });
    writeMeta(doc, { deletedAt: null }, Origins.local);
    expect(readMeta(doc).deletedAt).toBeNull();
    // @ts-expect-error runtime guard
    expect(() => writeMeta(doc, { color: "plaid" }, Origins.local)).toThrow();
    expect(() => writeMeta(doc, { zMode: 3 as 0 }, Origins.local)).toThrow();
    expect(readMeta(doc).color).toBe("azure");
  });

  it("round-trips through updateV2 and merges LWW per key", () => {
    const a = createNoteDoc("n5", { now: 1 });
    writeMeta(a, { color: "fern" }, Origins.local);
    const b = openNoteDoc("n5", [encodeStateV2(a)]);
    expect(b.guid).toBe("n5");
    expect(readMeta(b)).toEqual(readMeta(a));

    const seenOrigins: unknown[] = [];
    b.on("afterTransaction", (tr) => seenOrigins.push(tr.origin));
    writeMeta(a, { zMode: 1 }, Origins.local);
    applyUpdateV2(b, encodeStateV2(a, Y.encodeStateVector(b)));
    expect(seenOrigins).toEqual([Origins.remote]);
    expect(readMeta(b).zMode).toBe(1);

    // concurrent edits on different keys both survive
    writeMeta(b, { color: "violet" }, Origins.local);
    writeMeta(a, { deletedAt: 50 }, Origins.local);
    applyUpdateV2(a, encodeStateV2(b, Y.encodeStateVector(a)));
    applyUpdateV2(b, encodeStateV2(a, Y.encodeStateVector(b)));
    expect(readMeta(a)).toEqual(readMeta(b));
    expect(readMeta(a)).toMatchObject({ color: "violet", deletedAt: 50 });
  });

  it("stores ext.import with validation", () => {
    const doc = createNoteDoc("n6");
    expect(readImportExt(doc)).toBeNull();
    writeImportExt(
      doc,
      {
        source: "json",
        externalId: "n-001",
        contentSource: "Text",
        degraded: true,
        hasInk: false,
        originalTheme: "Yellow",
      },
      Origins.import,
    );
    expect(readImportExt(doc)).toMatchObject({ source: "json", externalId: "n-001", degraded: true });
    doc.getMap("ext").set("import", { nope: 1 });
    expect(readImportExt(doc)).toBeNull();
  });
});
