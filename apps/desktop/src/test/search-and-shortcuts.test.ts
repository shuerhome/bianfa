import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../lib/search-query.js";
import { matchShortcut } from "../lib/shortcuts.js";

const key = (
  k: string,
  mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean; code: string }> = {},
) => ({
  key: k,
  code: mods.code ?? (k.length === 1 && /\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`),
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  shiftKey: mods.shift ?? false,
  altKey: mods.alt ?? false,
});

describe("search prefix parsing", () => {
  it("is:pinned / 色:柠檬 → filters；余下走 bigram", () => {
    const p = parseSearchQuery("is:pinned 色:柠檬 买牛奶");
    expect(p.filters).toEqual({ pinned: true, color: "citron" });
    expect(p.text).toBe("买牛奶");
    expect(p.bigramQuery).toContain("买牛 牛奶");
  });
  it("单字走 LIKE（bigramQuery=null）", () => {
    expect(parseSearchQuery("奶").bigramQuery).toBeNull();
  });
});

describe("shortcut map", () => {
  it("Windows：Ctrl+Shift+0 石墨、Ctrl+1 玫瑰、Ctrl+0 缩放复位、Ctrl+T 删除线", () => {
    expect(matchShortcut(key("0", { ctrl: true, shift: true }), false)).toBe("color:graphite");
    expect(matchShortcut(key("1", { ctrl: true }), false)).toBe("color:rose");
    // 浓色档走 Ctrl/⌘+Shift+数字；Ctrl/⌘+0 仍是缩放归位
    expect(matchShortcut(key("1", { ctrl: true, shift: true }), false)).toBe("color:carmine");
    expect(matchShortcut(key("9", { ctrl: true, shift: true }), false)).toBe("color:eggplant");
    expect(matchShortcut(key("0", { ctrl: true }), false)).toBe("uiScaleReset");
    expect(matchShortcut(key("t", { ctrl: true }), false)).toBe("strike");
    expect(matchShortcut(key("Delete", { ctrl: true, shift: true, code: "Delete" }), false)).toBe(
      "deleteNote",
    );
  });
  it("macOS：⌘ 为修饰键，⌘⇧X 删除线，⌘T 不占用", () => {
    expect(matchShortcut(key("9", { meta: true }), true)).toBe("color:fuchsia");
    expect(matchShortcut(key("x", { meta: true, shift: true }), true)).toBe("strike");
    expect(matchShortcut(key("t", { meta: true }), true)).toBeNull();
    expect(matchShortcut(key("k", { meta: true }), true)).toBe("commandPalette");
  });
  it("IME 组合期不触发", () => {
    expect(matchShortcut({ ...key("s", { ctrl: true }), isComposing: true }, false)).toBeNull();
    expect(matchShortcut({ ...key("s", { ctrl: true }), keyCode: 229 }, false)).toBeNull();
  });
});
