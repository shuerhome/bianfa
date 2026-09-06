import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTE_COLOR,
  isNoteColor,
  LEGACY_THEME_TO_COLOR,
  legacyThemeToColor,
  NOTE_COLOR_INFO,
  NOTE_COLORS,
  noteColorByName,
  noteColorSchema,
} from "./colors.js";

describe("colors", () => {
  it("has the 10 colors in shortcut order", () => {
    expect(NOTE_COLORS).toEqual([
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
    NOTE_COLORS.forEach((color, index) => {
      expect(NOTE_COLOR_INFO[color].shortcut).toBe(index);
    });
    expect(DEFAULT_NOTE_COLOR).toBe("graphite");
    expect(NOTE_COLOR_INFO.graphite).toEqual({ zh: "石墨", en: "Graphite", hue: 96, shortcut: 0 });
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
    expect(isNoteColor("Rose")).toBe(false);
    expect(isNoteColor(3)).toBe(false);
    expect(noteColorSchema.safeParse("#fff").success).toBe(false);
    expect(noteColorByName("柠檬")).toBe("citron");
    expect(noteColorByName("Azure")).toBe("azure");
    expect(noteColorByName("nope")).toBeNull();
  });
});
