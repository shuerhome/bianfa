import { describe, expect, it } from "vitest";
import { applyMotion, applyNoteColor, applyThemeSetting, applyUiScale } from "../lib/theme.js";

describe("theme applier", () => {
  it("跟随系统 → 无 data-theme；显式 → data-theme", () => {
    const root = document.createElement("html");
    applyThemeSetting("dark", root);
    expect(root.getAttribute("data-theme")).toBe("dark");
    applyThemeSetting("light", root);
    expect(root.getAttribute("data-theme")).toBe("light");
    applyThemeSetting("system", root);
    expect(root.hasAttribute("data-theme")).toBe(false);
  });

  it("data-color 只接受 10 色，未知回落 graphite", () => {
    const el = document.createElement("div");
    expect(applyNoteColor(el, "citron")).toBe("citron");
    expect(el.getAttribute("data-color")).toBe("citron");
    expect(applyNoteColor(el, "hotpink")).toBe("graphite");
    expect(el.getAttribute("data-color")).toBe("graphite");
  });

  it("ui-scale 写成 --ui-scale 比例；motion 三态", () => {
    const root = document.createElement("html");
    applyUiScale(115, root);
    expect(root.style.getPropertyValue("--ui-scale")).toBe("1.15");
    applyMotion("reduce", root);
    expect(root.getAttribute("data-motion")).toBe("reduce");
    applyMotion("system", root);
    expect(root.hasAttribute("data-motion")).toBe(false);
  });
});
