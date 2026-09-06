import { getBody, openNoteDoc, type PlumExportNote, readImportExt, readMeta } from "@bianfa/shared";
import { describe, expect, it } from "vitest";
import { fromB64 } from "../lib/base64.js";
import { buildCommitItem } from "../windows/settings/ImportWizard.js";

const note: PlumExportNote = {
  external_id: "{ABC-123}",
  source: "plum.sqlite",
  title: "买菜",
  markdown: "买菜\n**牛奶** 两盒\n- [ ] 鸡蛋",
  text: "买菜\n牛奶 两盒\n- [ ] 鸡蛋",
  color: "citron",
  original_theme: "Yellow",
  pinned: true,
  is_open: true,
  window: { x: 100, y: 200, w: 300, h: 320, display_id: "DISPLAY1" },
  created_at: "2024-01-02T03:04:05Z",
  updated_at: "2024-02-03T04:05:06Z",
  attachments: [],
  has_ink: false,
  content_source: "Text",
  import_degraded: false,
};

describe("import：plum 文本 → Y.Doc → import_commit 项", () => {
  it("构造 update + 投影，meta 取原始时间与颜色，窗口与 isOpen 透传", () => {
    const item = buildCommitItem(note);
    expect(item.externalId).toBe("{ABC-123}");
    expect(item.noteId).toMatch(/^[0-9a-f-]{36}$/);
    expect(item.projection.color).toBe("citron");
    expect(item.projection.zMode).toBe(1);
    expect(item.projection.contentText).toContain("买菜");
    expect(item.projection.contentText).toContain("牛奶");
    expect(item.projection.contentBigram).toContain("买菜");
    expect(item.isOpen).toBe(true);
    expect(item.window).toEqual({ x: 100, y: 200, w: 300, h: 320, displayId: "DISPLAY1" });
    expect(item.sourceUpdatedAt).toBe(Date.parse("2024-02-03T04:05:06Z"));
    expect(item.degraded).toBe(false);

    const doc = openNoteDoc(item.noteId, [fromB64(item.updateV2B64)], "load");
    const meta = readMeta(doc);
    expect(meta.createdAt).toBe(Date.parse("2024-01-02T03:04:05Z"));
    expect(meta.updatedAt).toBe(Date.parse("2024-02-03T04:05:06Z"));
    expect(getBody(doc).toString()).toContain("牛奶");
    expect(readImportExt(doc)?.externalId).toBe("{ABC-123}");
  });
});
