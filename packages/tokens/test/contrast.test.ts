// 对比度门禁（specs/06 §1.6）：按对类阈值计算 WCAG 2.x 对比度；半透明底按最亮表面合成。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTE_COLORS, notePalette, semantic, THEMES, tokens } from "../dist/tokens.js";

type Rgb = [number, number, number];

function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value.trim());
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  throw new Error(`无法解析颜色 ${value}`);
}

/** 半透明色合成到底色上（sRGB 空间） */
function composite(fg: string, bg: Rgb): Rgb {
  const { rgb, alpha } = parseColor(fg);
  return [0, 1, 2].map((i) => Math.round((rgb[i] ?? 0) * alpha + (bg[i] ?? 0) * (1 - alpha))) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const solid = (value: string): Rgb => parseColor(value).rgb;
/** 近似 color-mix(in oklab, a p%, transparent) 叠在 base 上：线性 sRGB 混合（门槛余量 >2.5，足够） */
function mixOver(a: string, percent: number, base: Rgb): Rgb {
  const fa = solid(a);
  return [0, 1, 2].map((i) => Math.round((fa[i] ?? 0) * percent + (base[i] ?? 0) * (1 - percent))) as Rgb;
}

const WHITE: Rgb = [255, 255, 255];
const gates = tokens.contrastGates;

describe("便笺色板完整性", () => {
  it("10 色 × 2 主题 × 7 角色全部存在且为 #RRGGBB", () => {
    expect(NOTE_COLORS).toHaveLength(10);
    for (const theme of THEMES) {
      for (const color of NOTE_COLORS) {
        const p = notePalette[theme][color];
        for (const role of ["paper", "ink", "ink2", "line", "dot", "paperDim", "inkDim"] as const) {
          expect(p[role], `${theme}.${color}.${role}`).toMatch(/^#[0-9A-F]{6}$/);
        }
      }
    }
  });

  it("柠檬 dim 黄金测试：#EBE7A4 → #EBE8B3", () => {
    expect(notePalette.light.citron.paper).toBe("#EBE7A4");
    expect(notePalette.light.citron.paperDim).toBe("#EBE8B3");
  });
});

describe("对比度门禁：便笺纸面对类", () => {
  for (const theme of THEMES) {
    for (const color of NOTE_COLORS) {
      const p = notePalette[theme][color];
      const paper = solid(p.paper);
      const paperDim = solid(p.paperDim);
      it(`${theme}/${color}: ink/paper ≥ ${gates["note-ink"]}（含 dim）`, () => {
        expect(contrast(solid(p.ink), paper)).toBeGreaterThanOrEqual(gates["note-ink"]);
        expect(contrast(solid(p.inkDim), paperDim)).toBeGreaterThanOrEqual(gates["note-ink"]);
      });
      it(`${theme}/${color}: ink2/paper ≥ ${gates["note-ink2"]}`, () => {
        expect(contrast(solid(p.ink2), paper)).toBeGreaterThanOrEqual(gates["note-ink2"]);
      });
      it(`${theme}/${color}: dot/paper 与 dot/#FFF ≥ ${gates["note-dot"]}`, () => {
        expect(contrast(solid(p.dot), paper)).toBeGreaterThanOrEqual(gates["note-dot"]);
        expect(contrast(solid(p.dot), WHITE)).toBeGreaterThanOrEqual(gates["note-dot"]);
      });
      it(`${theme}/${color}: focus/paper ≥ ${gates["focus-ring"]}`, () => {
        expect(contrast(solid(semantic[theme].focus), paper)).toBeGreaterThanOrEqual(gates["focus-ring"]);
      });
      it(`${theme}/${color}: ink on mark(dot 30%) / sel(dot 22%) ≥ ${gates["note-mark-sel"]}`, () => {
        expect(contrast(solid(p.ink), mixOver(p.dot, 0.3, paper))).toBeGreaterThanOrEqual(gates["note-mark-sel"]);
        expect(contrast(solid(p.ink), mixOver(p.dot, 0.22, paper))).toBeGreaterThanOrEqual(gates["note-mark-sel"]);
      });
    }
  }
});

describe("对比度门禁：语义色对类", () => {
  for (const theme of THEMES) {
    const s = semantic[theme];
    // 半透明底按最亮表面合成：暗 surface-3 / 亮 #FFF
    const brightest = theme === "dark" ? solid(s["surface-3"]) : WHITE;
    const surfaces: Record<string, Rgb> = {
      canvas: solid(s.canvas),
      "surface-1": solid(s["surface-1"]),
      "surface-2": solid(s["surface-2"]),
      "surface-3": solid(s["surface-3"]),
      overlay: solid(s.overlay),
      hover: composite(s.hover, brightest),
      active: composite(s.active, brightest),
    };
    const t3Backgrounds = ["canvas", "surface-1", "surface-2", "surface-3", "overlay"];
    if (theme === "dark") surfaces.selected = solid(s.selected);
    if (theme === "dark") t3Backgrounds.push("selected");

    it(`${theme}: body-text（text-1/text-2 × 各表面含 hover/active）≥ ${gates["body-text"]}`, () => {
      for (const [name, bg] of Object.entries(surfaces)) {
        if (name === "selected") continue;
        expect(contrast(solid(s["text-1"]), bg), `text-1 on ${name}`).toBeGreaterThanOrEqual(gates["body-text"]);
        expect(contrast(solid(s["text-2"]), bg), `text-2 on ${name}`).toBeGreaterThanOrEqual(gates["body-text"]);
      }
    });

    it(`${theme}: tertiary-text（text-3 × T3_BG 白名单）≥ ${gates["tertiary-text"]}`, () => {
      for (const name of t3Backgrounds) {
        const bg = surfaces[name];
        if (!bg) throw new Error(name);
        expect(contrast(solid(s["text-3"]), bg), `text-3 on ${name}`).toBeGreaterThanOrEqual(gates["tertiary-text"]);
      }
    });

    it(`${theme}: on-accent（text-on-accent × accent/danger 三态、success、warning）≥ ${gates["on-accent"]}`, () => {
      const fg = solid(s["text-on-accent"]);
      for (const name of [
        "accent",
        "accent-hover",
        "accent-active",
        "danger",
        "danger-hover",
        "danger-active",
        "success",
        "warning",
      ] as const) {
        expect(contrast(fg, solid(s[name])), `on ${name}`).toBeGreaterThanOrEqual(gates["on-accent"]);
      }
    });

    it(`${theme}: semantic-text（语义色 × -subtle）≥ ${gates["semantic-text"]}`, () => {
      const pairs: [keyof typeof s, keyof typeof s][] = [
        ["accent", "accent-subtle"],
        ["danger", "danger-subtle"],
        ["success", "success-subtle"],
        ["warning", "warning-subtle"],
      ];
      for (const [fg, bg] of pairs) {
        expect(contrast(solid(s[fg]), solid(s[bg])), `${fg} on ${bg}`).toBeGreaterThanOrEqual(
          gates["semantic-text"],
        );
      }
    });

    it(`${theme}: tooltip ≥ ${gates.tooltip}`, () => {
      expect(contrast(solid(s["tooltip-text"]), solid(s["tooltip-bg"]))).toBeGreaterThanOrEqual(gates.tooltip);
    });
  }
});

describe("生成物", () => {
  const dist = resolve(import.meta.dirname, "../dist");
  it("tokens.css 三段式主题与 L3 映射齐全", () => {
    const css = readFileSync(resolve(dist, "tokens.css"), "utf8");
    expect(css).toContain(":root {");
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain("--p-citron: #EBE7A4;");
    expect(css).toContain("--c-accent: #4C5FD5;");
    for (const color of NOTE_COLORS) expect(css).toContain(`[data-color="${color}"]`);
    expect(css).not.toMatch(/https?:\/\//);
  });
  it("tokens.rs 含 10 色纸面常量与 note_paper()", () => {
    const rs = readFileSync(resolve(dist, "tokens.rs"), "utf8");
    expect(rs).toContain("pub const NOTE_PAPER_LIGHT: [Rgb; 10]");
    expect(rs).toContain("pub const NOTE_PAPER_DARK: [Rgb; 10]");
    expect(rs).toContain("pub fn note_paper(name: &str, dark: bool) -> Rgb");
    expect(rs).toContain("Rgb { r: 235, g: 231, b: 164 }, // citron");
  });
});
