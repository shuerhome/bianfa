import { describe, expect, it } from "vitest";
import { attachmentIdFromSrc, attachmentSrc } from "./image.js";
import {
  createEditorExtensions,
  generateTaskItemId,
  getSchemaV1,
  isAllowedLinkHref,
  SCHEMA_VERSION,
} from "./schema.js";

type AnyOptions = Record<string, unknown>;
const optionsOf = (exts: ReturnType<typeof createEditorExtensions>, name: string): AnyOptions =>
  (exts.find((e) => e.name === name)?.options ?? {}) as AnyOptions;

describe("editor schema v1", () => {
  it("builds a headless schema with exactly the v1 node and mark set", () => {
    expect(SCHEMA_VERSION).toBe(1);
    const schema = getSchemaV1();
    expect(Object.keys(schema.nodes).sort()).toEqual(
      [
        "blockquote",
        "bulletList",
        "codeBlock",
        "doc",
        "hardBreak",
        "heading",
        "horizontalRule",
        "image",
        "listItem",
        "orderedList",
        "paragraph",
        "taskItem",
        "taskList",
        "text",
      ].sort(),
    );
    expect(Object.keys(schema.marks).sort()).toEqual([
      "bold",
      "code",
      "italic",
      "link",
      "strike",
      "underline",
    ]);
    expect(schema.nodes.heading?.spec.attrs?.level?.default).toBe(1);
    expect(Object.keys(schema.nodes.taskItem?.spec.attrs ?? {}).sort()).toEqual(["checked", "id"]);
    expect(Object.keys(schema.nodes.image?.spec.attrs ?? {}).sort()).toEqual([
      "alt",
      "attachmentId",
      "blurhash",
      "h",
      "w",
    ]);
    expect(schema.nodes.image?.isBlock).toBe(true);
    expect(schema.nodes.image?.isAtom).toBe(true);
    expect(getSchemaV1()).toBe(schema);
  });

  it("configures StarterKit, UniqueID, Link and TaskItem per spec", () => {
    const exts = createEditorExtensions();
    const starter = optionsOf(exts, "starterKit");
    expect(starter.heading).toEqual({ levels: [1, 2, 3] });
    expect(starter.undoRedo).toBe(false);
    expect(starter.paragraph).toBe(false);
    expect(starter.underline).toBe(false);
    expect(starter.link).toBe(false);
    const standalone = optionsOf(createEditorExtensions({ collaboration: false }), "starterKit");
    expect(standalone.undoRedo).not.toBe(false);
    const uid = optionsOf(exts, "uniqueID");
    expect(uid.types).toEqual(["taskItem"]);
    expect(uid.attributeName).toBe("id");
    expect(typeof uid.filterTransaction).toBe("function");
    expect(
      optionsOf(createEditorExtensions({ collaboration: false }), "uniqueID").filterTransaction,
    ).toBeNull();
    const link = optionsOf(exts, "link");
    expect(link.openOnClick).toBe(false);
    expect(link.autolink).toBe(true);
    expect(optionsOf(exts, "taskItem").nested).toBe(true);
    expect(exts.filter((e) => e.name === "underline")).toHaveLength(1);
    expect(exts.filter((e) => e.name === "paragraph")).toHaveLength(1);
  });

  it("renders image HTML with the bianfa://att/ src", () => {
    const schema = getSchemaV1();
    const node = schema.nodes.image?.create({
      attachmentId: "att-1",
      w: 10,
      h: 20,
      blurhash: "LKO2",
      alt: "图",
    });
    const spec = schema.nodes.image?.spec.toDOM?.(node as never) as unknown[];
    expect(spec[0]).toBe("img");
    expect(spec[1]).toMatchObject({
      src: "bianfa://att/att-1",
      "data-attachment-id": "att-1",
      width: 10,
      height: 20,
      "data-blurhash": "LKO2",
      alt: "图",
    });
    expect(attachmentSrc("x")).toBe("bianfa://att/x");
    expect(attachmentIdFromSrc("bianfa://att/x")).toBe("x");
    expect(attachmentIdFromSrc("bianfa://att/")).toBeNull();
    expect(attachmentIdFromSrc("https://x/y.png")).toBeNull();
    expect(attachmentIdFromSrc("bianfa://att/a/b")).toBeNull();
  });

  it("generates nanoid(10) task ids and restricts link protocols", () => {
    const id = generateTaskItemId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(generateTaskItemId()).not.toBe(id);
    expect(isAllowedLinkHref("https://example.com/a?b=1")).toBe(true);
    expect(isAllowedLinkHref("http://例子.中国")).toBe(true);
    expect(isAllowedLinkHref("mailto:a@b.c")).toBe(true);
    expect(isAllowedLinkHref("mailto:")).toBe(false);
    expect(isAllowedLinkHref("javascript:alert(1)")).toBe(false);
    expect(isAllowedLinkHref("ftp://x")).toBe(false);
    expect(isAllowedLinkHref("file:///etc/passwd")).toBe(false);
    expect(isAllowedLinkHref("example.com")).toBe(false);
    expect(isAllowedLinkHref(null)).toBe(false);
  });
});
