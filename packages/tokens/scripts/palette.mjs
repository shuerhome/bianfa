#!/usr/bin/env node
// 便笺 10 色调色板推导（推导过程留在仓库里，供以后调整）。
//
//   node scripts/palette.mjs           打印候选 hex、WCAG 对比度、OKLab ΔE
//   node scripts/palette.mjs --write   顺带写回 src/tokens.json 的 note.light / note.dark
//
// 设计意图（设计负责人给定，见 P 任务）：
//   ① 纸要非常浅、彩度低（Windows 便笺那种粉彩），不能又深又艳；
//   ② 墨是「近中性的深灰黑」，只留一丝色相，不是「橄榄黑」那种带色的黑；
//   ③ 身份色由 dot 承担（取色器色块 / 同步点），它才是饱和的那一个。
//
// 数值目标（OKLCH）：
//   light  paper L 0.965–0.978 / C 0.028–0.055（暖黄绿 ≤0.058），ink L 0.245–0.265 / C 0.010–0.016，
//          ink2 L 0.505–0.525 / C 0.018–0.028，line L 0.895–0.915 / C ≈ paper×1.4，
//          dot L 0.58–0.64 / C 0.135–0.185（graphite 例外 L 0.52 / C ≤0.01）。
//   dark   paper L 0.245–0.275 / C 0.020–0.036，ink L 0.895–0.915 / C ≤0.012，
//          ink2 L 0.70–0.72 / C ≤0.022，line L 0.335–0.355，dot L 0.66–0.72 / C 0.11–0.15。
//   dim    paper：C×0.55、L ±0.006（亮色 +、暗色 −）；ink：L ±0.02。
//
// 两个硬约束会压过上面的名义区间，脚本按这个优先级求解：
//   (1) 验收门禁：light.paper 相对亮度 ≥ 0.86、dot 对 paper/白（暗色：canvas）≥ 3:1；
//   (2) 10 色可区分：相邻色相的 paper 在 OKLab 里 ΔE 目标 0.020。
// sRGB 在「相对亮度 ≥ 0.86」这一档对红/珊瑚/蓝/紫的彩度封得很死（见 --report 的色域表），
// 所以 light.paper 的 L 由「在给定相对亮度下取最大彩度」反解，落点会略低于 0.965；
// 这是为了让这些色在极浅处还能看出颜色，而不是一张白纸。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcPath = resolve(root, "src/tokens.json");
const src = JSON.parse(readFileSync(srcPath, "utf8"));

// ── sRGB ↔ OKLab（手写，无第三方依赖） ──
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** 线性 sRGB [0,1]³ → OKLab */
function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → 线性 sRGB（可能越界，越界即出色域） */
function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const oklchToOklab = (L, C, hDeg) => {
  const h = (hDeg * Math.PI) / 180;
  return [L, C * Math.cos(h), C * Math.sin(h)];
};
const oklabToOklch = ([L, a, b]) => {
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
};

const inGamut = ([r, g, b], eps = 1e-6) =>
  r >= -eps && r <= 1 + eps && g >= -eps && g <= 1 + eps && b >= -eps && b <= 1 + eps;

/** 固定 L/h，二分出仍在 sRGB 色域内的最大彩度（上限 cap） */
function maxChroma(L, hDeg, cap = 0.4) {
  if (inGamut(oklabToLinear(oklchToOklab(L, cap, hDeg)))) return cap;
  let lo = 0;
  let hi = cap;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklabToLinear(oklchToOklab(L, mid, hDeg)))) lo = mid;
    else hi = mid;
  }
  return lo;
}

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");
const toHex = ([r, g, b]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const fromHex = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgb255ToOklab = ([r, g, b]) =>
  linearToOklab([srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)]);
const labOfHex = (hex) => rgb255ToOklab(fromHex(hex));
const oklchOfHex = (hex) => oklabToOklch(labOfHex(hex));
const deltaE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** OKLCH → 最接近的 #RRGGBB：C 先 clamp 进色域，8bit 化后在 ±1 邻域里挑 OKLab 距离最小的 */
function oklchToHex(L, C, hDeg) {
  const c = Math.min(C, maxChroma(L, hDeg));
  const lab = oklchToOklab(L, c, hDeg);
  const base = oklabToLinear(lab).map((v) => Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255));
  let best = null;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dg = -1; dg <= 1; dg++) {
      for (let db = -1; db <= 1; db++) {
        const cand = [base[0] + dr, base[1] + dg, base[2] + db].map((v) => Math.min(255, Math.max(0, v)));
        const d = deltaE(rgb255ToOklab(cand), lab);
        if (!best || d < best.d) best = { d, rgb: cand };
      }
    }
  }
  return toHex(best.rgb);
}

// ── WCAG 2.x ──
const relLum = ([r, g, b]) =>
  0.2126 * srgbToLinear(r / 255) + 0.7152 * srgbToLinear(g / 255) + 0.0722 * srgbToLinear(b / 255);
const lumOf = (hex) => relLum(fromHex(hex));
const lumOfOklch = (L, C, h) => {
  const lin = oklabToLinear(oklchToOklab(L, C, h)).map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
};
function contrast(hexA, hexB) {
  const a = lumOf(hexA);
  const b = lumOf(hexB);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
const WHITE = "#FFFFFF";

// ── 目标表 ──
const SPEC = {
  light: {
    ink: { L: 0.255, C: 0.013 },
    ink2: { L: 0.515, C: 0.023 },
    line: { L: 0.905, ratio: 1.4 },
    dot: { Lmin: 0.58, Lmax: 0.64, C: 0.175, Cmax: 0.18 },
    dim: { paperL: +0.006, paperC: 0.55, inkL: +0.02 },
    // paper：自由变量是「相对亮度目标」，C 取该亮度下的色域上限（封顶 Ccap）
    paperY: { min: 0.872, max: 0.928, step: 0.004 },
    paperLmax: 0.978, // 名义 L 区间的上沿，不许再往白里飘
    paperLnominal: 0.97,
    paperLfree: 0.008, // 名义 L 的自由带，出带才罚
    paperCfloor: 0.018, // 每张纸都得看得出是有颜色的纸（红/珊瑚/蓝/紫受色域限制到不了 0.028）
    paperCcap: 0.055,
    paperCcapWarm: 0.058, // amber / citron 这条黄绿带
    graphite: { paperL: 0.97, paperC: 0.005, dotL: 0.52, dotC: 0.008, inkC: 0.008 },
  },
  dark: {
    ink: { L: 0.905, C: 0.01 },
    ink2: { L: 0.71, C: 0.02 },
    line: { L: 0.345, ratio: 1.4 },
    dot: { Lmin: 0.66, Lmax: 0.72, C: 0.14, Cmax: 0.147 },
    dim: { paperL: -0.006, paperC: 0.55, inkL: -0.02 },
    // paper：暗色域宽，C 直接取 0.034（在 0.020–0.036 内），自由变量是 L
    paperL: { min: 0.245, max: 0.275, step: 0.002 },
    paperLnominal: 0.26,
    paperLfree: 0.016,
    paperCfloor: 0.02,
    paperCcap: 0.034,
    paperCcapWarm: 0.034,
    graphite: { paperL: 0.26, paperC: 0.005, dotL: 0.69, dotC: 0.008, inkC: 0.008 },
  },
};
const PAPER_LUM_FLOOR = 0.86; // 验收断言：light.paper 相对亮度 ≥ 0.86
const DOT_GATE = 3.05; // WCAG 门禁 3，留一点余量给 hex 取整
const DELTA_E_TARGET = 0.02; // 相邻色相 paper 的可区分目标

const colors = src.noteColors;
const hueOf = (c) => src.noteColorInfo[c].hue;
const isWarm = (c) => c === "amber" || c === "citron";
const chromatic = colors.filter((c) => c !== "graphite");

/** light.paper 候选：给定相对亮度目标，反解「该亮度下彩度最大」的 (L, C) */
function lightPaperCandidate(color, yTarget) {
  const h = hueOf(color);
  const cap = isWarm(color) ? SPEC.light.paperCcapWarm : SPEC.light.paperCcap;
  let best = null;
  for (let L = SPEC.light.paperLmax; L >= 0.93; L -= 0.001) {
    if (lumOfOklch(L, 0, h) < yTarget) continue;
    const cm = Math.min(cap, maxChroma(L, h));
    let lo = 0;
    let hi = cm;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (lumOfOklch(L, mid, h) >= yTarget) lo = mid;
      else hi = mid;
    }
    if (!best || lo > best.C + 1e-5) best = { L, C: lo };
  }
  const hex = oklchToHex(best.L, best.C, h);
  return { ...best, hex, lab: labOfHex(hex) };
}

function darkPaperCandidate(color, L) {
  const h = hueOf(color);
  const cap = isWarm(color) ? SPEC.dark.paperCcapWarm : SPEC.dark.paperCcap;
  const C = Math.min(cap, maxChroma(L, h));
  const hex = oklchToHex(L, C, h);
  return { L, C, hex, lab: labOfHex(hex) };
}

/** 相邻色相对（色轮上相隔 ≤60°，graphite 是中性色不参与） */
const adjacentPairs = [];
for (let i = 0; i < chromatic.length; i++) {
  for (let j = i + 1; j < chromatic.length; j++) {
    const dh = Math.abs(hueOf(chromatic[i]) - hueOf(chromatic[j]));
    if (Math.min(dh, 360 - dh) <= 60) adjacentPairs.push([chromatic[i], chromatic[j]]);
  }
}

/**
 * 坐标下降：在候选网格上挑每色的 paper，目标
 *   Σ min(相邻 ΔE, 0.020) 优先（达标即止，不无谓拉开），其次总彩度，最后惩罚亮度离散度。
 * 确定性：固定初值 + 固定遍历顺序，跑出来每次一样。
 */
function solvePapers(theme) {
  const nominal = SPEC[theme].paperLnominal;
  const free = SPEC[theme].paperLfree;
  const floor = SPEC[theme].paperCfloor;
  const grid = new Map();
  for (const color of chromatic) {
    let list = [];
    if (theme === "light") {
      const { min, max, step } = SPEC.light.paperY;
      for (let y = min; y <= max + 1e-9; y += step) list.push(lightPaperCandidate(color, y));
    } else {
      const { min, max, step } = SPEC.dark.paperL;
      for (let L = min; L <= max + 1e-9; L += step) list.push(darkPaperCandidate(color, L));
    }
    // 每张纸都要有颜色：彩度低于下限的候选丢掉；若该色相整条都够不到，就留彩度最高的那几个
    const kept = list.filter((c) => c.C >= floor - 1e-6);
    if (kept.length > 0) list = kept;
    else list = [list.reduce((a, b) => (b.C > a.C ? b : a))];
    grid.set(color, list);
  }
  const pick = new Map(chromatic.map((c) => [c, Math.floor(grid.get(c).length / 2)]));
  const score = () => {
    let s = 0;
    for (const [a, b] of adjacentPairs) {
      const d = deltaE(grid.get(a)[pick.get(a)].lab, grid.get(b)[pick.get(b)].lab);
      s += 12 * Math.min(d, DELTA_E_TARGET); // 达标即止，不为多拉 0.001 的可区分度牺牲颜色
    }
    const cs = chromatic.map((c) => grid.get(c)[pick.get(c)].C);
    const ls = chromatic.map((c) => grid.get(c)[pick.get(c)].lab[0]);
    s += 6 * cs.reduce((x, y) => x + y, 0); // 纸要有颜色
    s -= 1 * (Math.max(...ls) - Math.min(...ls)); // 十张纸要像同一叠纸
    s -= 1.5 * ls.reduce((x, l) => x + Math.max(0, Math.abs(l - nominal) - free), 0); // 出了名义 L 带才罚
    return s;
  };
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (const color of chromatic) {
      const cur = pick.get(color);
      let bestIdx = cur;
      let bestScore = score();
      for (let i = 0; i < grid.get(color).length; i++) {
        if (i === cur) continue;
        pick.set(color, i);
        const s = score();
        if (s > bestScore + 1e-9) {
          bestScore = s;
          bestIdx = i;
        }
      }
      pick.set(color, bestIdx);
      if (bestIdx !== cur) moved = true;
    }
    if (!moved) break;
  }
  const out = {};
  for (const color of chromatic) out[color] = grid.get(color)[pick.get(color)];
  const g = SPEC[theme].graphite;
  const gHex = oklchToHex(g.paperL, g.paperC, hueOf("graphite"));
  out.graphite = { L: g.paperL, C: g.paperC, hex: gHex, lab: labOfHex(gHex) };
  return out;
}

/** dot：在 L 区间内挑「对 paper 与对白（暗色：对 canvas）都 ≥ 3.05」且彩度最大的一档 */
function solveDot(theme, color, paperHex) {
  const s = SPEC[theme].dot;
  const h = hueOf(color);
  const second = theme === "light" ? WHITE : src.semantic.dark.canvas;
  if (color === "graphite") return oklchToHex(SPEC[theme].graphite.dotL, SPEC[theme].graphite.dotC, h);
  let best = null;
  for (let L = s.Lmax; L >= s.Lmin - 1e-9; L -= 0.002) {
    const cap = Math.min(s.Cmax, maxChroma(L, h));
    for (const C of [Math.min(s.C, cap), cap]) {
      const hex = oklchToHex(L, C, h);
      if (contrast(hex, paperHex) < DOT_GATE || contrast(hex, second) < DOT_GATE) continue;
      const actual = oklchOfHex(hex).C;
      if (!best || actual > best.actual + 1e-4) best = { hex, actual };
    }
  }
  if (!best) throw new Error(`${theme}.${color}.dot：L 区间内无解`);
  return best.hex;
}

function buildTheme(theme) {
  const S = SPEC[theme];
  const papers = solvePapers(theme);
  const out = {};
  for (const color of colors) {
    const h = hueOf(color);
    const paper = papers[color];
    const paperC = oklchOfHex(paper.hex).C;
    const inkC = color === "graphite" ? S.graphite.inkC : S.ink.C;
    const ink2C = color === "graphite" ? S.graphite.inkC : S.ink2.C;
    out[color] = {
      paper: paper.hex,
      ink: oklchToHex(S.ink.L, inkC, h),
      ink2: oklchToHex(S.ink2.L, ink2C, h),
      line: oklchToHex(S.line.L, paperC * S.line.ratio, h),
      dot: solveDot(theme, color, paper.hex),
      paperDim: oklchToHex(paper.L + S.dim.paperL, paper.C * S.dim.paperC, h),
      inkDim: oklchToHex(S.ink.L + S.dim.inkL, inkC, h),
    };
  }
  return out;
}

const next = { light: buildTheme("light"), dark: buildTheme("dark") };

// ── 报告 ──
const f = (n, d = 3) => n.toFixed(d);
for (const theme of ["light", "dark"]) {
  const second = theme === "light" ? WHITE : src.semantic.dark.canvas;
  console.log(`\n=== ${theme} ===`);
  console.log(
    "color     paper   L/C/Y             ink     L/C         dot     L/C         | ink:pp ink2:pp dot:pp dot:2nd dim:dim",
  );
  for (const color of colors) {
    const p = next[theme][color];
    const P = oklchOfHex(p.paper);
    const I = oklchOfHex(p.ink);
    const D = oklchOfHex(p.dot);
    console.log(
      `${color.padEnd(9)} ${p.paper} ${f(P.L)}/${f(P.C)}/${f(lumOf(p.paper))} ` +
        `${p.ink} ${f(I.L)}/${f(I.C)} ${p.dot} ${f(D.L)}/${f(D.C)} |` +
        `${f(contrast(p.ink, p.paper), 2).padStart(6)}` +
        `${f(contrast(p.ink2, p.paper), 2).padStart(8)}` +
        `${f(contrast(p.dot, p.paper), 2).padStart(7)}` +
        `${f(contrast(p.dot, second), 2).padStart(8)}` +
        `${f(contrast(p.inkDim, p.paperDim), 2).padStart(8)}`,
    );
  }
  const lums = colors.map((c) => lumOf(next[theme][c].paper));
  console.log(
    `paper 相对亮度 ${f(Math.min(...lums), 4)} … ${f(Math.max(...lums), 4)}` +
      `${theme === "light" ? `（门槛 ≥ ${PAPER_LUM_FLOOR}）` : "（门槛 ≤ 0.075）"}；` +
      `ink 最大彩度 ${f(Math.max(...colors.map((c) => oklchOfHex(next[theme][c].ink).C)), 4)}（门槛 ≤ 0.02）`,
  );
  let worst = { d: Number.POSITIVE_INFINITY };
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const d = deltaE(labOfHex(next[theme][colors[i]].paper), labOfHex(next[theme][colors[j]].paper));
      if (d < worst.d) worst = { d, a: colors[i], b: colors[j] };
    }
  }
  console.log(`paper ΔE 全局最小 ${f(worst.d, 4)}（${worst.a}/${worst.b}）`);
  const adj = adjacentPairs
    .map(([a, b]) => ({
      pair: `${a}/${b}`,
      d: deltaE(labOfHex(next[theme][a].paper), labOfHex(next[theme][b].paper)),
    }))
    .sort((x, y) => x.d - y.d);
  console.log(`相邻色相 paper ΔE：${adj.map((x) => `${x.pair} ${f(x.d, 4)}`).join("，")}`);
  const miss = adj.filter((x) => x.d < DELTA_E_TARGET);
  if (miss.length > 0)
    console.log(
      `⚠ 未达 ΔE ${DELTA_E_TARGET} 的相邻对：${miss.map((x) => `${x.pair} ${f(x.d, 4)}`).join("，")}` +
        `（色相只隔 30° 且 sRGB 在「相对亮度 ≥ ${PAPER_LUM_FLOOR}」处彩度封顶；` +
        `再拉开只能把其中一色推成近乎纯白，与「同一叠纸」的观感相悖，故止于此，身份区分交给 dot）`,
    );
}

if (process.argv.includes("--write")) {
  // 逐行改写 note 块里的 hex（不整份 JSON.stringify，免得把 tokens.json 其余部分的排版洗掉）
  const text = readFileSync(srcPath, "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === '"note": {');
  if (start < 0) throw new Error("tokens.json: 找不到 note 块");
  let depth = 0;
  let theme = null;
  let color = null;
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth === 0 && i > start) {
      end = i;
      break;
    }
    const open = /^\s*"([A-Za-z]+)": \{\s*$/.exec(line);
    if (open) {
      if (depth === 2) theme = open[1];
      else if (depth === 3) color = open[1];
      continue;
    }
    const role = /^(\s*"([A-Za-z0-9]+)": ")#[0-9A-Fa-f]{6}(",?)$/.exec(line);
    if (role && theme && color) {
      const value = next[theme]?.[color]?.[role[2]];
      if (!value) throw new Error(`tokens.json: note.${theme}.${color}.${role[2]} 不在推导结果里`);
      lines[i] = `${role[1]}${value}${role[3]}`;
    }
  }
  if (end < 0) throw new Error("tokens.json: note 块没闭合");
  const out = lines.join("\n");
  const parsed = JSON.parse(out);
  if (JSON.stringify(parsed.note) !== JSON.stringify(next))
    throw new Error("tokens.json: 写回结果与推导结果不一致");
  writeFileSync(srcPath, out);
  console.log(`\n已写回 ${srcPath}（只覆盖 note.light / note.dark 的 hex）`);
}
