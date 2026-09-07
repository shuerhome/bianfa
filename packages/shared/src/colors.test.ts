import { describe, expect, it } from "vitest";
import {
  DEEP_NOTE_COLORS,
  DEFAULT_NOTE_COLOR,
  isNoteColor,
  LEGACY_THEME_TO_COLOR,
  legacyThemeToColor,
  NOTE_COLOR_INFO,
  NOTE_COLORS,
  noteColorByName,
  noteColorSchema,
  noteColorsByTier,
  PALE_NOTE_COLORS,
} from "./colors.js";

describe("colors", () => {
  it("有 20 色：浅色档 10 + 浓色档 10，顺序即取色器顺序", () => {
    expect(PALE_NOTE_COLORS).toEqual([
      "graphite",
      "rose",
      "coral",
      "amber",
      "citron",
      "fern",
      "teal",
      "azure",
      "violet",
      "fuchsia",
    ]);
    expect(DEEP_NOTE_COLORS).toEqual([
      "slate",
      "carmine",
      "vermilion",
      "ochre",
      "olive",
      "pine",
      "peacock",
      "indigo",
      "wisteria",
      "eggplant",
    ]);
    expect(NOTE_COLORS).toEqual([...PALE_NOTE_COLORS, ...DEEP_NOTE_COLORS]);
    expect(new Set(NOTE_COLORS).size).toBe(20);
    expect(DEFAULT_NOTE_COLOR).toBe("graphite");
  });

  it("每个颜色的 tier / slot 与它在本档里的位置一致", () => {
    for (const tier of ["pale", "deep"] as const) {
      const list = noteColorsByTier(tier);
      expect(list).toHaveLength(10);
      list.forEach((color, index) => {
        expect(NOTE_COLOR_INFO[color].tier, color).toBe(tier);
        expect(NOTE_COLOR_INFO[color].slot, color).toBe(index);
      });
    }
  });

  it("中英文名与色相都不重复（取色器要能逐个念出来）", () => {
    const zh = NOTE_COLORS.map((c) => NOTE_COLOR_INFO[c].zh);
    const en = NOTE_COLORS.map((c) => NOTE_COLOR_INFO[c].en);
    expect(new Set(zh).size).toBe(20);
    expect(new Set(en).size).toBe(20);
    // 两档共用 10 个色相，墨灰（250 冷灰）故意不跟石墨（96 暖灰）同相
    expect(new Set(NOTE_COLORS.map((c) => NOTE_COLOR_INFO[c].hue)).size).toBe(11);
    expect(NOTE_COLOR_INFO.graphite).toEqual({
      zh: "石墨",
      en: "Graphite",
      hue: 96,
      tier: "pale",
      slot: 0,
    });
    expect(NOTE_COLOR_INFO.slate).toEqual({
      zh: "墨灰",
      en: "Slate",
      hue: 250,
      tier: "deep",
      slot: 0,
    });
  });

  it("maps legacy themes exactly like export_sticky_notes.py THEME_MAP", () => {
    expect(LEGACY_THEME_TO_COLOR).toEqual({
      yellow: "citron",
      green: "fern",
      blue: "azure",
      purple: "violet",
      pink: "rose",
      gray: "graphite",
      grey: "graphite",
      charcoal: "graphite",
    });
    expect(legacyThemeToColor("Yellow")).toBe("citron");
    expect(legacyThemeToColor(" Teal ")).toBe("citron");
    expect(legacyThemeToColor(null)).toBe("citron");
    expect(legacyThemeToColor("Charcoal")).toBe("graphite");
  });

  it("validates enum names", () => {
    expect(isNoteColor("rose")).toBe(true);
    expect(isNoteColor("carmine")).toBe(true);
    expect(isNoteColor("Rose")).toBe(false);
    expect(isNoteColor(3)).toBe(false);
    expect(noteColorSchema.safeParse("#fff").success).toBe(false);
    expect(noteColorSchema.safeParse("eggplant").success).toBe(true);
    expect(noteColorByName("柠檬")).toBe("citron");
    expect(noteColorByName("茄紫")).toBe("eggplant");
    expect(noteColorByName("Azure")).toBe("azure");
    expect(noteColorByName("peacock")).toBe("peacock");
    expect(noteColorByName("nope")).toBeNull();
  });
});
