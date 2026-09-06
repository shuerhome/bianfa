#!/usr/bin/env node
// 手写生成器（不依赖 Style Dictionary）：src/tokens.json → dist/tokens.css / tokens.ts(+.js/.d.ts) / tokens.rs
// 用法：pnpm -F @bianfa/tokens build。生成物提交进 git，src-tauri/build.rs 可直接 include!("tokens.rs")。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = JSON.parse(readFileSync(resolve(root, "src/tokens.json"), "utf8"));
const out = resolve(root, "dist");
mkdirSync(out, { recursive: true });

const HEX_RE = /^#[0-9A-F]{6}$/;
const COLOR_RE = /^(#[0-9A-F]{6}|rgba?\([^)]*\))$/;
const NOTE_ROLES = ["paper", "ink", "ink2", "line", "dot", "paperDim", "inkDim"];
const THEMES = ["light", "dark"];
const BANNER = "自动生成（pnpm -F @bianfa/tokens build），勿手改；来源 packages/tokens/src/tokens.json";

// ── 校验：10 色 × 2 主题 × 7 角色全是 6 位 hex；语义色是 hex 或 rgba ──
for (const theme of THEMES) {
  for (const color of src.noteColors) {
    const entry = src.note[theme]?.[color];
    if (!entry) throw new Error(`tokens.json: note.${theme}.${color} 缺失`);
    for (const role of NOTE_ROLES) {
      if (!HEX_RE.test(entry[role] ?? ""))
        throw new Error(`tokens.json: note.${theme}.${color}.${role} 不是 #RRGGBB`);
    }
  }
  for (const [name, value] of Object.entries(src.semantic[theme])) {
    if (name.startsWith("$")) continue;
    if (!COLOR_RE.test(value)) throw new Error(`tokens.json: semantic.${theme}.${name} 非法颜色 ${value}`);
  }
}
const semanticNames = Object.keys(src.semantic.light).filter((k) => !k.startsWith("$"));
for (const name of semanticNames) {
  if (!(name in src.semantic.dark)) throw new Error(`tokens.json: semantic.dark.${name} 缺失`);
}

const kebabRole = (role) => role.replace(/([A-Z])/g, "-$1").toLowerCase();
const lines = (arr, indent = "  ") => arr.map((l) => `${indent}${l}`).join("\n");

// ── tokens.css ──
function themeColorLines(theme) {
  const ls = [];
  for (const color of src.noteColors) {
    const entry = src.note[theme][color];
    ls.push(`--p-${color}: ${entry.paper};`);
    for (const role of NOTE_ROLES) {
      if (role === "paper") continue;
      ls.push(`--p-${color}-${kebabRole(role)}: ${entry[role]};`);
    }
  }
  for (const name of semanticNames) ls.push(`--c-${name}: ${src.semantic[theme][name]};`);
  for (const [k, v] of Object.entries(src.shadow[theme])) ls.push(`--sh-${k}: ${v};`);
  return ls;
}

function scaleLines() {
  const ls = [];
  for (const [k, v] of Object.entries(src.gray)) ls.push(`--p-w-${k}: ${v};`);
  ls.push(`--f-sans: ${src.font.sans};`, `--f-mono: ${src.font.mono};`);
  ls.push(`--ui-scale: ${src.uiScale.default};`);
  for (const [k, v] of Object.entries(src.fontSize)) ls.push(`--fs-${k}: ${v};`);
  for (const [k, v] of Object.entries(src.lineHeight)) ls.push(`--lh-${k}: ${v};`);
  for (const [k, v] of Object.entries(src.letterSpacing)) ls.push(`--ls-${k}: ${v};`);
  for (const [k, v] of Object.entries(src.fontWeight)) ls.push(`--fw-${k}: ${v};`);
  for (const [k, v] of Object.entries(src.spacing)) ls.push(`--sp-${k}: ${v};`);
  for (const [k, v] of Object.entries(src.radius)) ls.push(`--r-${k}: ${v};`);
  for (const [k, v] of Object.entries(src.border)) ls.push(`--bw-${k}: ${v};`);
  for (const [k, v] of Object.entries(src.control)) ls.push(`--h-ctl-${k}: ${v};`);
  for (const [k, v] of Object.entries(src.z)) ls.push(`--z-${k}: ${v};`);
  for (const [k, v] of Object.entries(src.geometry)) ls.push(`--${k}: ${v};`);
  for (const [k, v] of Object.entries(src.duration)) ls.push(`--dur-${k}: ${v};`);
  for (const [k, v] of Object.entries(src.delay)) ls.push(`--delay-${k}: ${v};`);
  for (const [k, v] of Object.entries(src.ease)) {
    if (k === "spring-linear") continue;
    ls.push(`--ease-${k}: ${v};`);
  }
  return ls;
}

const darkBody = lines([`color-scheme: dark;`, ...themeColorLines("dark")]);
const reduced = [
  ...Object.entries(src.reducedMotion.duration).map(([k, v]) => `--dur-${k}: ${v};`),
  ...Object.entries(src.reducedMotion.ease).map(([k, v]) => `--ease-${k}: ${v};`),
];
const dataColorBlocks = src.noteColors
  .map((color) =>
    [
      `[data-color="${color}"] {`,
      `  --note-paper: var(--p-${color});`,
      `  --note-ink: var(--p-${color}-ink);`,
      `  --note-ink2: var(--p-${color}-ink2);`,
      `  --note-line: var(--p-${color}-line);`,
      `  --note-dot: var(--p-${color}-dot);`,
      `  --note-paper-dim: var(--p-${color}-paper-dim);`,
      `  --note-ink-dim: var(--p-${color}-ink-dim);`,
      `}`,
    ].join("\n"),
  )
  .join("\n");
const derivedLines = Object.entries(src.derived)
  .filter(([k]) => !k.startsWith("$"))
  .map(([k, v]) => `--${k}: ${v};`);

const css = `/* ${BANNER} */
/* 三段式主题：① 裸 :root = 亮 ② prefers-color-scheme:dark 且未显式选亮 ③ [data-theme="dark"]；②③ 逐字相同 */
:root {
  color-scheme: light dark;
${lines(scaleLines())}
${lines(themeColorLines("light"))}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${lines(darkBody.split("\n"), "  ")}
  }
}
:root[data-theme="dark"] {
${darkBody}
}
/* L3：便笺色由 JS 写 data-color；组件只读 --note-* */
${dataColorBlocks}
[data-color] {
${lines(derivedLines)}
}
[data-color][data-focused="false"] {
  --note-paper: var(--note-paper-dim);
  --note-ink: var(--note-ink-dim);
}
/* reduced-motion：低两档 1ms、高三档 100ms（保留 crossfade）；--delay-* 不变 */
@media (prefers-reduced-motion: reduce) {
  :root:not([data-motion="full"]) {
${lines(reduced, "    ")}
  }
}
:root[data-motion="reduce"] {
${lines(reduced)}
}
@supports (transition-timing-function: linear(0, 1)) {
  :root {
    --ease-spring: ${src.ease["spring-linear"]};
  }
  @media (prefers-reduced-motion: reduce) {
    :root:not([data-motion="full"]) {
      --ease-spring: var(--ease-out);
    }
  }
  :root[data-motion="reduce"] {
    --ease-spring: var(--ease-out);
  }
}
`;
writeFileSync(resolve(out, "tokens.css"), css);

// ── tokens.ts / tokens.js / tokens.d.ts ──
const json = (v) => JSON.stringify(v, null, 2);
const pickSemantic = (theme) => Object.fromEntries(semanticNames.map((n) => [n, src.semantic[theme][n]]));
const scalar = {
  gray: src.gray,
  font: src.font,
  fontSize: src.fontSize,
  lineHeight: src.lineHeight,
  letterSpacing: src.letterSpacing,
  fontWeight: src.fontWeight,
  uiScale: src.uiScale,
  spacing: src.spacing,
  radius: src.radius,
  border: src.border,
  control: src.control,
  z: src.z,
  geometry: src.geometry,
  duration: src.duration,
  delay: src.delay,
  ease: src.ease,
  contrastGates: src.contrastGates,
};

const tsBody = `// ${BANNER}
export const NOTE_COLORS = ${json(src.noteColors)} as const;
export type NoteColor = (typeof NOTE_COLORS)[number];
export type Theme = "light" | "dark";
export const THEMES = ["light", "dark"] as const;
export type NoteRole = ${NOTE_ROLES.map((r) => `"${r}"`).join(" | ")};
export interface NotePalette {
${NOTE_ROLES.map((r) => `  readonly ${r}: string;`).join("\n")}
}
export interface NoteColorInfo {
  readonly zh: string;
  readonly en: string;
  readonly hue: number;
  readonly shortcut: number;
}
export type SemanticName = ${semanticNames.map((n) => `"${n}"`).join(" | ")};
export const NOTE_COLOR_INFO: Readonly<Record<NoteColor, NoteColorInfo>> = ${json(src.noteColorInfo)};
export const notePalette: Readonly<Record<Theme, Readonly<Record<NoteColor, NotePalette>>>> = ${json(src.note)};
export const semantic: Readonly<Record<Theme, Readonly<Record<SemanticName, string>>>> = ${json({
  light: pickSemantic("light"),
  dark: pickSemantic("dark"),
})};
export const shadow: Readonly<Record<Theme, Readonly<Record<"1" | "2" | "3" | "window", string>>>> = ${json(src.shadow)};
export const tokens = ${json(scalar)} as const;
export function isNoteColor(value: unknown): value is NoteColor {
  return typeof value === "string" && (NOTE_COLORS as readonly string[]).includes(value);
}
/** 便笺纸面色（= 窗口底色）；未知色名 → graphite */
export function notePaper(color: string, theme: Theme): string {
  const name: NoteColor = isNoteColor(color) ? color : "graphite";
  return notePalette[theme][name].paper;
}
/** #RRGGBB → [r, g, b] */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(\`hexToRgb: 不是 #RRGGBB: \${hex}\`);
  const n = Number.parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
`;
writeFileSync(resolve(out, "tokens.ts"), tsBody);
// .js：同一份数据的纯 JS 形态（NodeNext / vitest 可直接消费）
const jsBody = `// ${BANNER}
export const NOTE_COLORS = ${json(src.noteColors)};
export const THEMES = ["light", "dark"];
export const NOTE_COLOR_INFO = ${json(src.noteColorInfo)};
export const notePalette = ${json(src.note)};
export const semantic = ${json({ light: pickSemantic("light"), dark: pickSemantic("dark") })};
export const shadow = ${json(src.shadow)};
export const tokens = ${json(scalar)};
export function isNoteColor(value) {
  return typeof value === "string" && NOTE_COLORS.includes(value);
}
export function notePaper(color, theme) {
  const name = isNoteColor(color) ? color : "graphite";
  return notePalette[theme][name].paper;
}
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(\`hexToRgb: 不是 #RRGGBB: \${hex}\`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
`;
writeFileSync(resolve(out, "tokens.js"), jsBody);
// 值 → .d.ts 类型文本：字符串/数字按字面量，数组 → readonly (元素类型)[]
function toDts(value, indent = "") {
  if (Array.isArray(value)) {
    const inner = value.length > 0 ? toDts(value[0], indent) : "never";
    return `readonly ${inner}[]`;
  }
  if (value && typeof value === "object") {
    const next = `${indent}  `;
    const body = Object.entries(value)
      .map(
        ([k, v]) =>
          `${next}readonly ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${toDts(v, next)};`,
      )
      .join("\n");
    return `{\n${body}\n${indent}}`;
  }
  return JSON.stringify(value);
}
const dts = `// ${BANNER}
export declare const NOTE_COLORS: readonly ${json(src.noteColors).replace(/\n\s*/g, " ")};
export type NoteColor = (typeof NOTE_COLORS)[number];
export type Theme = "light" | "dark";
export declare const THEMES: readonly ["light", "dark"];
export type NoteRole = ${NOTE_ROLES.map((r) => `"${r}"`).join(" | ")};
export interface NotePalette {
${NOTE_ROLES.map((r) => `  readonly ${r}: string;`).join("\n")}
}
export interface NoteColorInfo {
  readonly zh: string;
  readonly en: string;
  readonly hue: number;
  readonly shortcut: number;
}
export type SemanticName = ${semanticNames.map((n) => `"${n}"`).join(" | ")};
export declare const NOTE_COLOR_INFO: Readonly<Record<NoteColor, NoteColorInfo>>;
export declare const notePalette: Readonly<Record<Theme, Readonly<Record<NoteColor, NotePalette>>>>;
export declare const semantic: Readonly<Record<Theme, Readonly<Record<SemanticName, string>>>>;
export declare const shadow: Readonly<Record<Theme, Readonly<Record<"1" | "2" | "3" | "window", string>>>>;
export declare const tokens: ${toDts(scalar)};
export declare function isNoteColor(value: unknown): value is NoteColor;
export declare function notePaper(color: string, theme: Theme): string;
export declare function hexToRgb(hex: string): [number, number, number];
`;
writeFileSync(resolve(out, "tokens.d.ts"), dts);

// ── tokens.rs ──
const rgb = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `Rgb { r: ${(n >> 16) & 255}, g: ${(n >> 8) & 255}, b: ${n & 255} }`;
};
const rsArray = (theme, role) =>
  src.noteColors.map((c) => `    ${rgb(src.note[theme][c][role])}, // ${c}`).join("\n");
const rs = `// ${BANNER}
// 供 src-tauri 用 include!() 引入：托盘角标、窗口 background_color（alpha 恒 255）。
// 用法：#[allow(dead_code)] mod tokens { include!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/tokens/dist/tokens.rs")); }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const fn to_array(self) -> [u8; 3] {
        [self.r, self.g, self.b]
    }
    pub const fn to_rgba(self) -> [u8; 4] {
        [self.r, self.g, self.b, 255]
    }
}

/// 10 色枚举名，顺序 = 换色快捷键顺序（0 = Ctrl/Cmd+Shift+0，1..9 = Ctrl/Cmd+1..9）
pub const NOTE_COLORS: [&str; ${src.noteColors.length}] = [${src.noteColors.map((c) => `"${c}"`).join(", ")}];
pub const DEFAULT_NOTE_COLOR: &str = "graphite";

pub const NOTE_PAPER_LIGHT: [Rgb; ${src.noteColors.length}] = [
${rsArray("light", "paper")}
];
pub const NOTE_PAPER_DARK: [Rgb; ${src.noteColors.length}] = [
${rsArray("dark", "paper")}
];
pub const NOTE_DOT_LIGHT: [Rgb; ${src.noteColors.length}] = [
${rsArray("light", "dot")}
];
pub const NOTE_DOT_DARK: [Rgb; ${src.noteColors.length}] = [
${rsArray("dark", "dot")}
];

pub const CANVAS_LIGHT: Rgb = ${rgb(src.semantic.light.canvas)};
pub const CANVAS_DARK: Rgb = ${rgb(src.semantic.dark.canvas)};
pub const SURFACE_1_LIGHT: Rgb = ${rgb(src.semantic.light["surface-1"])};
pub const SURFACE_1_DARK: Rgb = ${rgb(src.semantic.dark["surface-1"])};
pub const ACCENT_LIGHT: Rgb = ${rgb(src.semantic.light.accent)};
pub const ACCENT_DARK: Rgb = ${rgb(src.semantic.dark.accent)};
pub const WARNING_LIGHT: Rgb = ${rgb(src.semantic.light.warning)};
pub const WARNING_DARK: Rgb = ${rgb(src.semantic.dark.warning)};
pub const DANGER_LIGHT: Rgb = ${rgb(src.semantic.light.danger)};
pub const DANGER_DARK: Rgb = ${rgb(src.semantic.dark.danger)};

/// 色名 → 序号；未知 → None
pub fn note_color_index(name: &str) -> Option<usize> {
    NOTE_COLORS.iter().position(|c| *c == name)
}

/// 便笺纸面色（= 窗口底色）。未知色名按 graphite。
pub fn note_paper(name: &str, dark: bool) -> Rgb {
    let i = note_color_index(name).unwrap_or(0);
    if dark { NOTE_PAPER_DARK[i] } else { NOTE_PAPER_LIGHT[i] }
}

/// 便笺色点（托盘「最近」项的色标）。未知色名按 graphite。
pub fn note_dot(name: &str, dark: bool) -> Rgb {
    let i = note_color_index(name).unwrap_or(0);
    if dark { NOTE_DOT_DARK[i] } else { NOTE_DOT_LIGHT[i] }
}

pub fn canvas(dark: bool) -> Rgb {
    if dark { CANVAS_DARK } else { CANVAS_LIGHT }
}
`;
writeFileSync(resolve(out, "tokens.rs"), rs);

console.log(`tokens: wrote dist/tokens.css (${css.length} B), tokens.ts, tokens.js, tokens.d.ts, tokens.rs`);
