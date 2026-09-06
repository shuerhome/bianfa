// 便笺 10 色枚举（规格 02 §5）。枚举名 = 存储值 = token 后缀；顺序 = 换色快捷键顺序。
// API/IPC 只传枚举名，不传 hex；hex 由 design tokens 生成，与本文件无关。
import { z } from "zod";

export const NOTE_COLORS = [
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

export type NoteColor = (typeof NOTE_COLORS)[number];

export interface NoteColorInfo {
  /** 中文名，与 `色:` 搜索前缀及 popover 文案逐字一致 */
  readonly zh: string;
  readonly en: string;
  /** OKLCH 色相 */
  readonly hue: number;
  /** 换色快捷键序号：0 = Ctrl/Cmd+Shift+0，1–9 = Ctrl/Cmd+1…9 */
  readonly shortcut: number;
}

export const NOTE_COLOR_INFO: Readonly<Record<NoteColor, NoteColorInfo>> = {
  graphite: { zh: "石墨", en: "Graphite", hue: 96, shortcut: 0 },
  rose: { zh: "玫瑰", en: "Rose", hue: 358, shortcut: 1 },
  coral: { zh: "珊瑚", en: "Coral", hue: 28, shortcut: 2 },
  amber: { zh: "琥珀", en: "Amber", hue: 68, shortcut: 3 },
  citron: { zh: "柠檬", en: "Citron", hue: 105, shortcut: 4 },
  fern: { zh: "竹绿", en: "Fern", hue: 145, shortcut: 5 },
  teal: { zh: "松石", en: "Teal", hue: 188, shortcut: 6 },
  azure: { zh: "天青", en: "Azure", hue: 232, shortcut: 7 },
  violet: { zh: "紫罗兰", en: "Violet", hue: 288, shortcut: 8 },
  fuchsia: { zh: "品红", en: "Fuchsia", hue: 328, shortcut: 9 },
};

/** 新建便笺默认色（规格 02 §5 / §6.1） */
export const DEFAULT_NOTE_COLOR: NoteColor = "graphite";

/** 原版便笺未知/空 Theme 的兜底色（原版默认黄） */
export const LEGACY_DEFAULT_COLOR: NoteColor = "citron";

/** 原版 7 色 → 10 色。键为小写 Theme 名，与 tools/export_sticky_notes.py 的 THEME_MAP 逐项一致 */
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
