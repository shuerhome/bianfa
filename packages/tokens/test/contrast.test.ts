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

/** sRGB → OKLCH 彩度（判「墨是不是近中性」用；与 scripts/palette.mjs 同一套系数） */
function chroma(hex: string): number {
  const lin = solid(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  const [r, g, b] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return Math.hypot(a, bb);
}

const WHITE: Rgb = [255, 255, 255];
const gates = tokens.contrastGates;
/** 门禁之上再收紧一档：这两条是当前实测下限附近的地板，只能往上走 */
const NOTE_INK_FLOOR = 10.5; // 实测 10.80–15.07（gates["note-ink"] = 10）
const NOTE_INK2_FLOOR = 4.8; // 实测 4.93–6.08（gates["note-ink2"] = 4.5）
/** 调色板性格：纸必须很浅 / 很深，墨必须近中性 */
const PAPER_LUM_LIGHT_MIN = 0.86;
const PAPER_LUM_DARK_MAX = 0.075;
const INK_CHROMA_MAX = 0.02;
const DOT_CHROMA_MIN = 0.105; // 实测 0.109（松石亮色，受 sRGB 青色域限制）–0.181

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

  it("柠檬 dim 黄金测试：#FDFBCE → #FDFBE3", () => {
    expect(notePalette.light.citron.paper).toBe("#FDFBCE");
    expect(notePalette.light.citron.paperDim).toBe("#FDFBE3");
  });
});

// ── 调色板性格断言（scripts/palette.mjs 的设计目标，防止以后被改回「深纸 + 带色的黑」）──
describe("便笺纸与墨的性格", () => {
  it(`亮色：每张纸的相对亮度 ≥ ${PAPER_LUM_LIGHT_MIN}（纸必须很浅）`, () => {
    for (const color of NOTE_COLORS) {
      const paper = notePalette.light[color].paper;
      expect(luminance(solid(paper)), `light.${color}.paper ${paper}`).toBeGreaterThanOrEqual(
        PAPER_LUM_LIGHT_MIN,
      );
    }
  });

  it(`亮色：每种墨的 OKLCH 彩度 ≤ ${INK_CHROMA_MAX}（墨必须近中性）`, () => {
    for (const color of NOTE_COLORS) {
      const p = notePalette.light[color];
      for (const role of ["ink", "inkDim"] as const) {
        expect(chroma(p[role]), `light.${color}.${role} ${p[role]}`).toBeLessThanOrEqual(INK_CHROMA_MAX);
      }
    }
  });

  it(`暗色：每张纸的相对亮度 ≤ ${PAPER_LUM_DARK_MAX}（纸必须很深）`, () => {
    for (const color of NOTE_COLORS) {
      const paper = notePalette.dark[color].paper;
      expect(luminance(solid(paper)), `dark.${color}.paper ${paper}`).toBeLessThanOrEqual(PAPER_LUM_DARK_MAX);
    }
  });

  it(`暗色：每种墨的 OKLCH 彩度 ≤ ${INK_CHROMA_MAX}（墨必须近中性）`, () => {
    for (const color of NOTE_COLORS) {
      const p = notePalette.dark[color];
      for (const role of ["ink", "inkDim"] as const) {
        expect(chroma(p[role]), `dark.${color}.${role} ${p[role]}`).toBeLessThanOrEqual(INK_CHROMA_MAX);
      }
    }
  });

  it(`dot 才是身份色：彩度 ≥ ${DOT_CHROMA_MIN}，且远高于同色的纸与墨`, () => {
    for (const theme of THEMES) {
      for (const color of NOTE_COLORS) {
        if (color === "graphite") continue; // 石墨是中性色，没有身份彩度
        const p = notePalette[theme][color];
        const label = `${theme}.${color}.dot ${p.dot}`;
        expect(chroma(p.dot), label).toBeGreaterThanOrEqual(DOT_CHROMA_MIN);
        expect(chroma(p.dot), label).toBeGreaterThan(chroma(p.paper));
        expect(chroma(p.dot), label).toBeGreaterThan(chroma(p.ink) * 5);
      }
    }
  });
});

describe("对比度门禁：便笺纸面对类", () => {
  for (const theme of THEMES) {
    for (const color of NOTE_COLORS) {
      const p = notePalette[theme][color];
      const paper = solid(p.paper);
      const paperDim = solid(p.paperDim);
      it(`${theme}/${color}: ink/paper ≥ ${gates["note-ink"]}（含 dim；实测已收紧到 ${NOTE_INK_FLOOR}）`, () => {
        expect(contrast(solid(p.ink), paper)).toBeGreaterThanOrEqual(gates["note-ink"]);
        expect(contrast(solid(p.inkDim), paperDim)).toBeGreaterThanOrEqual(gates["note-ink"]);
        expect(contrast(solid(p.ink), paper)).toBeGreaterThanOrEqual(NOTE_INK_FLOOR);
        expect(contrast(solid(p.inkDim), paperDim)).toBeGreaterThanOrEqual(NOTE_INK_FLOOR);
      });
      it(`${theme}/${color}: ink2/paper ≥ ${gates["note-ink2"]}（实测已收紧到 ${NOTE_INK2_FLOOR}）`, () => {
        expect(contrast(solid(p.ink2), paper)).toBeGreaterThanOrEqual(gates["note-ink2"]);
        expect(contrast(solid(p.ink2), paper)).toBeGreaterThanOrEqual(NOTE_INK2_FLOOR);
      });
      // dot × #FFF 只对亮色有意义（规格 §1.2 实测 4.41–5.13）；暗色的色点（L .70）改对 canvas
      it(`${theme}/${color}: dot/paper 与 dot/${theme === "light" ? "#FFF" : "canvas"} ≥ ${gates["note-dot"]}`, () => {
        expect(contrast(solid(p.dot), paper)).toBeGreaterThanOrEqual(gates["note-dot"]);
        const second = theme === "light" ? WHITE : solid(semantic.dark.canvas);
        expect(contrast(solid(p.dot), second)).toBeGreaterThanOrEqual(gates["note-dot"]);
      });
      it(`${theme}/${color}: focus/paper ≥ ${gates["focus-ring"]}`, () => {
        expect(contrast(solid(semantic[theme].focus), paper)).toBeGreaterThanOrEqual(gates["focus-ring"]);
      });
      it(`${theme}/${color}: ink on mark(dot 30%) / sel(dot 22%) ≥ ${gates["note-mark-sel"]}`, () => {
        expect(contrast(solid(p.ink), mixOver(p.dot, 0.3, paper))).toBeGreaterThanOrEqual(
          gates["note-mark-sel"],
        );
        expect(contrast(solid(p.ink), mixOver(p.dot, 0.22, paper))).toBeGreaterThanOrEqual(
          gates["note-mark-sel"],
        );
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
        expect(contrast(solid(s["text-1"]), bg), `text-1 on ${name}`).toBeGreaterThanOrEqual(
          gates["body-text"],
        );
        expect(contrast(solid(s["text-2"]), bg), `text-2 on ${name}`).toBeGreaterThanOrEqual(
          gates["body-text"],
        );
      }
    });

    it(`${theme}: tertiary-text（text-3 × T3_BG 白名单）≥ ${gates["tertiary-text"]}`, () => {
      for (const name of t3Backgrounds) {
        const bg = surfaces[name];
        if (!bg) throw new Error(name);
        expect(contrast(solid(s["text-3"]), bg), `text-3 on ${name}`).toBeGreaterThanOrEqual(
          gates["tertiary-text"],
        );
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
      expect(contrast(solid(s["tooltip-text"]), solid(s["tooltip-bg"]))).toBeGreaterThanOrEqual(
        gates.tooltip,
      );
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
    expect(css).toContain("--p-citron: #FDFBCE;");
    expect(css).toContain("--c-accent: #4C5FD5;");
    for (const color of NOTE_COLORS) expect(css).toContain(`[data-color="${color}"]`);
    expect(css).not.toMatch(/https?:\/\//);
  });
  it("tokens.rs 含 10 色纸面常量与 note_paper()", () => {
    const rs = readFileSync(resolve(dist, "tokens.rs"), "utf8");
    expect(rs).toContain("pub const NOTE_PAPER_LIGHT: [Rgb; 10]");
    expect(rs).toContain("pub const NOTE_PAPER_DARK: [Rgb; 10]");
    expect(rs).toContain("pub fn note_paper(name: &str, dark: bool) -> Rgb");
    expect(rs).toContain("Rgb { r: 253, g: 251, b: 206 }, // citron");
  });
});
