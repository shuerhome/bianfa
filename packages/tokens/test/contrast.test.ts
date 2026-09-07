// 对比度门禁（specs/06 §1.6）：按对类阈值计算 WCAG 2.x 对比度；半透明底按最亮表面合成。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTE_COLOR_INFO, NOTE_COLORS, notePalette, semantic, THEMES, tokens } from "../dist/tokens.js";

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

/** sRGB → OKLab（与 scripts/palette.mjs 同一套系数） */
function oklab(hex: string): [number, number, number] {
  const lin = solid(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  const [r, g, b] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLCH 彩度（判「墨是不是近中性」「dot 是不是身份色」用） */
function chroma(hex: string): number {
  const [, a, b] = oklab(hex);
  return Math.hypot(a, b);
}

/** 两色在 OKLab 里的距离（判两张纸认不认得出） */
function deltaE(x: string, y: string): number {
  const a = oklab(x);
  const b = oklab(y);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const WHITE: Rgb = [255, 255, 255];
const gates = tokens.contrastGates;
/** 门禁之上再收紧一档：这两条是当前实测下限附近的地板，只能往上走 */
const NOTE_INK_FLOOR = 10.5; // 实测 10.56–14.91（gates["note-ink"] = 10）
const NOTE_INK2_FLOOR = 4.8; // 实测 4.94–6.05（gates["note-ink2"] = 4.5）

/** 20 色 = 10 个色相族 × 淡/浓两档；每档各有一个中性色（不承担身份彩度） */
type Tier = "pale" | "deep";
const TIERS = ["pale", "deep"] as const;
const TIER_NEUTRAL: Record<Tier, string> = { pale: "graphite", deep: "slate" };
type NoteColorName = (typeof NOTE_COLORS)[number];
const tierColors = (tier: Tier): NoteColorName[] =>
  NOTE_COLORS.filter((c) => NOTE_COLOR_INFO[c].tier === tier);

/** 调色板性格：纸必须很浅 / 很深，墨必须近中性 */
// 淡档是「极浅的纸」（实测 0.871–0.943）；浓档另立一档（实测 0.666–0.709），靠亮度和淡档拉开
const PAPER_LUM_LIGHT_MIN: Record<Tier, number> = { pale: 0.86, deep: 0.64 };
const PAPER_LUM_DARK_MAX = 0.075;
const INK_CHROMA_MAX = 0.02;
// 淡档实测 0.109（松石亮色）–0.181；浓档的纸更深，dot 得跟着压到 L 0.50–0.56，
// 而 sRGB 的青色在这一档最多只有 0.097 的彩度（孔雀亮色，见 palette.mjs --gamut），故浓档地板 0.095
const DOT_CHROMA_MIN: Record<Tier, number> = { pale: 0.105, deep: 0.095 };
/** 同档内两张纸的可区分目标（OKLab ΔE） */
const PAPER_DELTA_E_MIN = 0.02;
/** 20 色里任意两张纸的地板：淡档 rose/coral 只有 0.0142，是 sRGB 的硬限制，不是失误 */
const PAPER_DELTA_E_HARD_MIN = 0.014;
/** 淡档这两对够不到 0.020：色相只隔 30°，sRGB 在「相对亮度 ≥0.86」处彩度封顶（palette.mjs 顶部有说明） */
const DELTA_E_EXEMPT = new Set(["light:rose/coral", "light:coral/amber"]);

describe("便笺色板完整性", () => {
  it("20 色（10 色相 × 淡/浓两档）× 2 主题 × 7 角色全部存在且为 #RRGGBB", () => {
    expect(NOTE_COLORS).toHaveLength(20);
    for (const theme of THEMES) {
      for (const color of NOTE_COLORS) {
        const p = notePalette[theme][color];
        for (const role of ["paper", "ink", "ink2", "line", "dot", "paperDim", "inkDim"] as const) {
          expect(p[role], `${theme}.${color}.${role}`).toMatch(/^#[0-9A-F]{6}$/);
        }
      }
    }
  });

  it("两档各 10 色，档内序号 0–9 各一个", () => {
    for (const tier of TIERS) {
      const list = tierColors(tier);
      expect(list, tier).toHaveLength(10);
      expect(list.map((c) => NOTE_COLOR_INFO[c].slot).sort((a, b) => a - b)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
      expect(NOTE_COLOR_INFO[TIER_NEUTRAL[tier] as NoteColorName].slot, `${tier} 的中性色排头`).toBe(0);
    }
    // 顺序 = 先 10 个淡档再 10 个浓档（tokens.rs 的查表按这个下标）
    expect(NOTE_COLORS.slice(0, 10).every((c) => NOTE_COLOR_INFO[c].tier === "pale")).toBe(true);
    expect(NOTE_COLORS.slice(10).every((c) => NOTE_COLOR_INFO[c].tier === "deep")).toBe(true);
  });

  it("柠檬 dim 黄金测试：#FDFBCE → #FDFBE3", () => {
    expect(notePalette.light.citron.paper).toBe("#FDFBCE");
    expect(notePalette.light.citron.paperDim).toBe("#FDFBE3");
  });

  it("茄紫 dim 黄金测试（浓档）：#FEC2FB → #F0CFEE", () => {
    expect(notePalette.light.eggplant.paper).toBe("#FEC2FB");
    expect(notePalette.light.eggplant.paperDim).toBe("#F0CFEE");
  });
});

// ── 调色板性格断言（scripts/palette.mjs 的设计目标，防止以后被改回「深纸 + 带色的黑」）──
describe("便笺纸与墨的性格", () => {
  for (const tier of TIERS) {
    it(`亮色 ${tier}：每张纸的相对亮度 ≥ ${PAPER_LUM_LIGHT_MIN[tier]}（淡档是极浅的纸，浓档另立一档）`, () => {
      for (const color of tierColors(tier)) {
        const paper = notePalette.light[color].paper;
        expect(luminance(solid(paper)), `light.${color}.paper ${paper}`).toBeGreaterThanOrEqual(
          PAPER_LUM_LIGHT_MIN[tier],
        );
      }
    });
  }

  it("亮色：浓档的每张纸都明显深于淡档的每张纸（两档不能混成一档）", () => {
    const paleMin = Math.min(...tierColors("pale").map((c) => luminance(solid(notePalette.light[c].paper))));
    const deepMax = Math.max(...tierColors("deep").map((c) => luminance(solid(notePalette.light[c].paper))));
    expect(deepMax).toBeLessThan(paleMin - 0.1);
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

  it(`dot 才是身份色：彩度 ≥ ${DOT_CHROMA_MIN.pale}（浓档 ${DOT_CHROMA_MIN.deep}），且远高于同色的纸与墨`, () => {
    for (const theme of THEMES) {
      for (const tier of TIERS) {
        for (const color of tierColors(tier)) {
          if (color === TIER_NEUTRAL[tier]) continue; // 石墨 / 墨灰是中性色，没有身份彩度
          const p = notePalette[theme][color];
          const label = `${theme}.${color}.dot ${p.dot}`;
          expect(chroma(p.dot), label).toBeGreaterThanOrEqual(DOT_CHROMA_MIN[tier]);
          expect(chroma(p.dot), label).toBeGreaterThan(chroma(p.paper));
          expect(chroma(p.dot), label).toBeGreaterThan(chroma(p.ink) * 5);
        }
      }
    }
  });
});

// ── 可区分：20 色摆在取色器里，两两之间得认得出（同档看纸，跨档隔着亮度或彩度）──
describe("便笺色的可区分度", () => {
  for (const theme of THEMES) {
    for (const tier of TIERS) {
      it(`${theme}/${tier}：同档任意两张纸的 OKLab ΔE ≥ ${PAPER_DELTA_E_MIN}`, () => {
        const list = tierColors(tier);
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i] as NoteColorName;
            const b = list[j] as NoteColorName;
            if (DELTA_E_EXEMPT.has(`${theme}:${a}/${b}`)) continue;
            const d = deltaE(notePalette[theme][a].paper, notePalette[theme][b].paper);
            expect(d, `${theme}.${a}/${b}`).toBeGreaterThanOrEqual(PAPER_DELTA_E_MIN);
          }
        }
      });
    }

    it(`${theme}：跨档同色相的两张纸 ΔE ≥ ${PAPER_DELTA_E_MIN}（实测最小 0.0244）`, () => {
      const pale = tierColors("pale");
      const deep = tierColors("deep");
      for (let i = 0; i < pale.length; i++) {
        const a = pale[i] as NoteColorName;
        const b = deep[i] as NoteColorName;
        expect(NOTE_COLOR_INFO[a].slot, `${a}/${b} 应是同一个档内序号`).toBe(NOTE_COLOR_INFO[b].slot);
        const d = deltaE(notePalette[theme][a].paper, notePalette[theme][b].paper);
        expect(d, `${theme}.${a}/${b}`).toBeGreaterThanOrEqual(PAPER_DELTA_E_MIN);
      }
    });

    it(`${theme}：20 色的纸两两不同，且 ΔE ≥ ${PAPER_DELTA_E_HARD_MIN}；dot 也两两不同`, () => {
      const papers = NOTE_COLORS.map((c) => notePalette[theme][c].paper);
      const dots = NOTE_COLORS.map((c) => notePalette[theme][c].dot);
      expect(new Set(papers).size, "paper 撞色").toBe(NOTE_COLORS.length);
      expect(new Set(dots).size, "dot 撞色").toBe(NOTE_COLORS.length);
      for (let i = 0; i < NOTE_COLORS.length; i++) {
        for (let j = i + 1; j < NOTE_COLORS.length; j++) {
          const d = deltaE(papers[i] as string, papers[j] as string);
          expect(d, `${theme}.${NOTE_COLORS[i]}/${NOTE_COLORS[j]}`).toBeGreaterThanOrEqual(
            PAPER_DELTA_E_HARD_MIN,
          );
        }
      }
    });
  }
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
    expect(css).toContain("--p-eggplant: #FEC2FB;");
    expect(css).toContain("--c-accent: #4C5FD5;");
    for (const color of NOTE_COLORS) expect(css).toContain(`[data-color="${color}"]`);
    expect(css).not.toMatch(/https?:\/\//);
  });
  it("tokens.rs 含 20 色纸面 / 色点常量与 note_paper() / note_dot()", () => {
    const rs = readFileSync(resolve(dist, "tokens.rs"), "utf8");
    for (const name of ["NOTE_PAPER_LIGHT", "NOTE_PAPER_DARK", "NOTE_DOT_LIGHT", "NOTE_DOT_DARK"]) {
      expect(rs).toContain(`pub const ${name}: [Rgb; 20]`);
    }
    expect(rs).toContain("pub fn note_paper(name: &str, dark: bool) -> Rgb");
    expect(rs).toContain("pub fn note_dot(name: &str, dark: bool) -> Rgb");
    // src-tauri 按枚举名查表，20 个名字都得在（查不到会回落成 graphite）
    for (const color of NOTE_COLORS) expect(rs, color).toContain(`"${color}"`);
    expect(rs).toContain("Rgb { r: 253, g: 251, b: 206 }, // citron");
    expect(rs).toContain("Rgb { r: 254, g: 194, b: 251 }, // eggplant");
  });
});
