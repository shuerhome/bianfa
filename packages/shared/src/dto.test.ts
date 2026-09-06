import { describe, expect, it } from "vitest";
import {
  NOTE_PERMS,
  noteListItemSchema,
  permAtLeast,
  permRank,
  platformSchema,
  workspaceKindSchema,
} from "./dto.js";

describe("dto", () => {
  it("orders permissions viewer < commenter < editor < manager", () => {
    expect(NOTE_PERMS).toEqual(["viewer", "commenter", "editor", "manager"]);
    expect(permRank("manager")).toBe(3);
    expect(permAtLeast("manager", "viewer")).toBe(true);
    expect(permAtLeast("editor", "editor")).toBe(true);
    expect(permAtLeast("commenter", "editor")).toBe(false);
    expect(permAtLeast("viewer", "commenter")).toBe(false);
  });

  it("validates note list items", () => {
    const ok = noteListItemSchema.safeParse({
      id: "0192b1c0-0000-7000-8000-000000000001",
      title: "t",
      excerpt: "",
      color: "rose",
      zMode: 1,
      updatedAt: 1,
    });
    expect(ok.success).toBe(true);
    expect(
      noteListItemSchema.safeParse({
        id: "nope",
        title: "t",
        excerpt: "",
        color: "rose",
        zMode: 1,
        updatedAt: 1,
      }).success,
    ).toBe(false);
    expect(
      noteListItemSchema.safeParse({
        id: "0192b1c0-0000-7000-8000-000000000001",
        title: "t",
        excerpt: "",
        color: "#fff",
        zMode: 0,
        updatedAt: 1,
      }).success,
    ).toBe(false);
    expect(workspaceKindSchema.options).toEqual(["personal", "team"]);
    expect(platformSchema.options).toEqual(["windows", "macos", "linux"]);
  });
});
