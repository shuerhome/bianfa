// 便笺 20 色枚举（规格 02 §5）。枚举名 = 存储值 = token 后缀；数组顺序 = 取色器与快捷键顺序。
// API/IPC 只传枚举名，不传 hex；hex 由 design tokens 生成，与本文件无关。
//
// 为什么是「10 色相 × 2 浓淡档」而不是 20 个并列的浅色：
// 极浅的纸（相对亮度 ≥ 0.86）在 sRGB 里能用的彩度非常有限，10 张浅纸已经把相邻色相的
// OKLab ΔE 压到 0.014 左右，再往里塞第 11 张浅纸就只是"另一张白纸"。所以第二档走"更深、
// 彩度 2–3 倍"的浓纸：墨还是同一支近中性的黑，对比度门禁一条不放松，但一眼能分出是另一档。
import { z } from "zod";

/** 浅色档：Windows 便笺那种粉彩纸，顺序即 Ctrl/⌘+数字 的顺序 */
export const PALE_NOTE_COLORS = [
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
] as const;

/** 浓色档：同样 10 个色相（墨灰例外，见 hue 注释），纸更深、彩度更高 */
export const DEEP_NOTE_COLORS = [
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
] as const;

export const NOTE_COLORS = [...PALE_NOTE_COLORS, ...DEEP_NOTE_COLORS] as const;

export type NoteColor = (typeof NOTE_COLORS)[number];

export const NOTE_COLOR_TIERS = ["pale", "deep"] as const;
export type NoteColorTier = (typeof NOTE_COLOR_TIERS)[number];

export interface NoteColorInfo {
  /** 中文名，与 `色:` 搜索前缀及 popover 文案逐字一致 */
  readonly zh: string;
  readonly en: string;
  /** OKLCH 色相 */
  readonly hue: number;
  /** 浓淡档 */
  readonly tier: NoteColorTier;
  /** 同档内序号 0–9。浅档 0 = Ctrl/⌘+Shift+0、1–9 = Ctrl/⌘+1…9；浓档 1–9 = Ctrl/⌘+Shift+1…9，0 无快捷键 */
  readonly slot: number;
}

export const NOTE_COLOR_INFO: Readonly<Record<NoteColor, NoteColorInfo>> = {
  graphite: { zh: "石墨", en: "Graphite", hue: 96, tier: "pale", slot: 0 },
  rose: { zh: "玫瑰", en: "Rose", hue: 358, tier: "pale", slot: 1 },
  coral: { zh: "珊瑚", en: "Coral", hue: 28, tier: "pale", slot: 2 },
  amber: { zh: "琥珀", en: "Amber", hue: 68, tier: "pale", slot: 3 },
  citron: { zh: "柠檬", en: "Citron", hue: 105, tier: "pale", slot: 4 },
  fern: { zh: "竹绿", en: "Fern", hue: 145, tier: "pale", slot: 5 },
  teal: { zh: "松石", en: "Teal", hue: 188, tier: "pale", slot: 6 },
  azure: { zh: "天青", en: "Azure", hue: 232, tier: "pale", slot: 7 },
  violet: { zh: "紫罗兰", en: "Violet", hue: 288, tier: "pale", slot: 8 },
  fuchsia: { zh: "品红", en: "Fuchsia", hue: 328, tier: "pale", slot: 9 },
  // 墨灰的色相是 250（冷灰）而不是石墨的 96（暖灰）：两个中性色只差亮度会认错，
  // 一暖一冷才分得开，暗色主题里尤其明显。
  slate: { zh: "墨灰", en: "Slate", hue: 250, tier: "deep", slot: 0 },
  carmine: { zh: "胭脂", en: "Carmine", hue: 358, tier: "deep", slot: 1 },
  vermilion: { zh: "朱砂", en: "Vermilion", hue: 28, tier: "deep", slot: 2 },
  ochre: { zh: "秋香", en: "Ochre", hue: 68, tier: "deep", slot: 3 },
  olive: { zh: "橄榄", en: "Olive", hue: 105, tier: "deep", slot: 4 },
  pine: { zh: "松针", en: "Pine", hue: 145, tier: "deep", slot: 5 },
  peacock: { zh: "孔雀", en: "Peacock", hue: 188, tier: "deep", slot: 6 },
  indigo: { zh: "靛蓝", en: "Indigo", hue: 232, tier: "deep", slot: 7 },
  wisteria: { zh: "藤紫", en: "Wisteria", hue: 288, tier: "deep", slot: 8 },
  eggplant: { zh: "茄紫", en: "Eggplant", hue: 328, tier: "deep", slot: 9 },
};

/** 新建便笺默认色（规格 02 §5 / §6.1） */
export const DEFAULT_NOTE_COLOR: NoteColor = "graphite";

/** 原版便笺未知/空 Theme 的兜底色（原版默认黄） */
export const LEGACY_DEFAULT_COLOR: NoteColor = "citron";

/** 原版 7 色 → 浅色档。键为小写 Theme 名，与 tools/export_sticky_notes.py 的 THEME_MAP 逐项一致 */
export const LEGACY_THEME_TO_COLOR: Readonly<Record<string, NoteColor>> = {
  yellow: "citron",
  green: "fern",
  blue: "azure",
  purple: "violet",
  pink: "rose",
  gray: "graphite",
  grey: "graphite",
  charcoal: "graphite",
};

export const noteColorSchema = z.enum(NOTE_COLORS);

export function isNoteColor(value: unknown): value is NoteColor {
  return typeof value === "string" && (NOTE_COLORS as readonly string[]).includes(value);
}

/** 某一档的 10 个颜色，按 slot 升序（取色器一行一档就是照这个渲染） */
export function noteColorsByTier(tier: NoteColorTier): readonly NoteColor[] {
  return tier === "pale" ? PALE_NOTE_COLORS : DEEP_NOTE_COLORS;
}

/** 原版 Theme（大小写/前后空白不敏感）→ NoteColor；未知或空 → citron */
export function legacyThemeToColor(theme: string | null | undefined): NoteColor {
  const key = (theme ?? "").trim().toLowerCase();
  return LEGACY_THEME_TO_COLOR[key] ?? LEGACY_DEFAULT_COLOR;
}

/** 按中文名或英文名（大小写不敏感）反查枚举名；用于 `色:柠檬` 搜索前缀 */
export function noteColorByName(name: string): NoteColor | null {
  const needle = name.trim().toLowerCase();
  if (isNoteColor(needle)) return needle;
  for (const color of NOTE_COLORS) {
    const info = NOTE_COLOR_INFO[color];
    if (info.zh === needle || info.en.toLowerCase() === needle) return color;
  }
  return null;
}
