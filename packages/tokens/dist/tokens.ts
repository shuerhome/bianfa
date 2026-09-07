// 自动生成（pnpm -F @bianfa/tokens build），勿手改；来源 packages/tokens/src/tokens.json
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
  "fuchsia"
] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];
export type Theme = "light" | "dark";
export const THEMES = ["light", "dark"] as const;
export type NoteRole = "paper" | "ink" | "ink2" | "line" | "dot" | "paperDim" | "inkDim";
export interface NotePalette {
  readonly paper: string;
  readonly ink: string;
  readonly ink2: string;
  readonly line: string;
  readonly dot: string;
  readonly paperDim: string;
  readonly inkDim: string;
}
export interface NoteColorInfo {
  readonly zh: string;
  readonly en: string;
  readonly hue: number;
  readonly shortcut: number;
}
export type SemanticName = "canvas" | "surface-1" | "surface-2" | "surface-3" | "overlay" | "hover" | "active" | "selected" | "text-1" | "text-2" | "text-3" | "text-disabled" | "text-on-accent" | "border-subtle" | "border" | "border-strong" | "accent" | "accent-hover" | "accent-active" | "accent-subtle" | "accent-border" | "danger" | "danger-hover" | "danger-active" | "danger-subtle" | "danger-border" | "success" | "success-subtle" | "warning" | "warning-subtle" | "info" | "focus" | "scrim" | "tooltip-bg" | "tooltip-text";
export const NOTE_COLOR_INFO: Readonly<Record<NoteColor, NoteColorInfo>> = {
  "graphite": {
    "zh": "石墨",
    "en": "Graphite",
    "hue": 96,
    "shortcut": 0
  },
  "rose": {
    "zh": "玫瑰",
    "en": "Rose",
    "hue": 358,
    "shortcut": 1
  },
  "coral": {
    "zh": "珊瑚",
    "en": "Coral",
    "hue": 28,
    "shortcut": 2
  },
  "amber": {
    "zh": "琥珀",
    "en": "Amber",
    "hue": 68,
    "shortcut": 3
  },
  "citron": {
    "zh": "柠檬",
    "en": "Citron",
    "hue": 105,
    "shortcut": 4
  },
  "fern": {
    "zh": "竹绿",
    "en": "Fern",
    "hue": 145,
    "shortcut": 5
  },
  "teal": {
    "zh": "松石",
    "en": "Teal",
    "hue": 188,
    "shortcut": 6
  },
  "azure": {
    "zh": "天青",
    "en": "Azure",
    "hue": 232,
    "shortcut": 7
  },
  "violet": {
    "zh": "紫罗兰",
    "en": "Violet",
    "hue": 288,
    "shortcut": 8
  },
  "fuchsia": {
    "zh": "品红",
    "en": "Fuchsia",
    "hue": 328,
    "shortcut": 9
  }
};
export const notePalette: Readonly<Record<Theme, Readonly<Record<NoteColor, NotePalette>>>> = {
  "light": {
    "graphite": {
      "paper": "#F6F5F1",
      "ink": "#24231F",
      "ink2": "#696762",
      "line": "#E1E0DA",
      "dot": "#6A6964",
      "paperDim": "#F7F7F5",
      "inkDim": "#292823"
    },
    "rose": {
      "paper": "#FFEFF4",
      "ink": "#282023",
      "ink2": "#736267",
      "line": "#EFD9DF",
      "dot": "#DC518A",
      "paperDim": "#FCF3F5",
      "inkDim": "#2D2528"
    },
    "coral": {
      "paper": "#FFECE9",
      "ink": "#292120",
      "ink2": "#746360",
      "line": "#F3D9D5",
      "dot": "#D94A3F",
      "paperDim": "#FBF0EF",
      "inkDim": "#2E2524"
    },
    "amber": {
      "paper": "#FFEEDC",
      "ink": "#27221C",
      "ink2": "#716559",
      "line": "#F3DBC2",
      "dot": "#C37900",
      "paperDim": "#FBF1E7",
      "inkDim": "#2C2721"
    },
    "citron": {
      "paper": "#FDFBCE",
      "ink": "#24231C",
      "ink2": "#696859",
      "line": "#E7E3A4",
      "dot": "#999001",
      "paperDim": "#FDFBE3",
      "inkDim": "#282821"
    },
    "fern": {
      "paper": "#DEFFDE",
      "ink": "#1F251F",
      "ink2": "#606B5F",
      "line": "#C0EEC0",
      "dot": "#1A9C31",
      "paperDim": "#EAFCEA",
      "inkDim": "#242923"
    },
    "teal": {
      "paper": "#C9FFF9",
      "ink": "#1C2524",
      "ink2": "#596C6A",
      "line": "#A3F1E9",
      "dot": "#009D94",
      "paperDim": "#DEFBF8",
      "inkDim": "#202A29"
    },
    "azure": {
      "paper": "#E0F4FF",
      "ink": "#1D2428",
      "ink2": "#5B6A73",
      "line": "#C9E5F4",
      "dot": "#0094C7",
      "paperDim": "#EAF4FA",
      "inkDim": "#21292D"
    },
    "violet": {
      "paper": "#F0EFFF",
      "ink": "#222229",
      "ink2": "#666675",
      "line": "#DEDDF3",
      "dot": "#8771EE",
      "paperDim": "#F2F2FB",
      "inkDim": "#27272E"
    },
    "fuchsia": {
      "paper": "#FFEAFD",
      "ink": "#262126",
      "ink2": "#6F636E",
      "line": "#F2D5F0",
      "dot": "#B952B7",
      "paperDim": "#FBF0FA",
      "inkDim": "#2B252B"
    }
  },
  "dark": {
    "graphite": {
      "paper": "#252421",
      "ink": "#E1E0DA",
      "ink2": "#A3A19C",
      "line": "#3A3935",
      "dot": "#9D9B96",
      "paperDim": "#232321",
      "inkDim": "#DAD9D3"
    },
    "rose": {
      "paper": "#342027",
      "ink": "#E6DDDF",
      "ink2": "#AD9DA2",
      "line": "#4D2F39",
      "dot": "#DB6A95",
      "paperDim": "#2D2225",
      "inkDim": "#DFD6D9"
    },
    "coral": {
      "paper": "#331E1B",
      "ink": "#E6DDDC",
      "ink2": "#AE9D9A",
      "line": "#4F302C",
      "dot": "#EE786B",
      "paperDim": "#2B201E",
      "inkDim": "#DFD7D6"
    },
    "amber": {
      "paper": "#2F2112",
      "ink": "#E4DFD9",
      "ink2": "#AA9F94",
      "line": "#49351E",
      "dot": "#DF8F22",
      "paperDim": "#292119",
      "inkDim": "#DED8D2"
    },
    "citron": {
      "paper": "#272511",
      "ink": "#E0E0D9",
      "ink2": "#A3A294",
      "line": "#3D3B1D",
      "dot": "#B3A91A",
      "paperDim": "#242319",
      "inkDim": "#DAD9D2"
    },
    "fern": {
      "paper": "#1A291A",
      "ink": "#DCE1DB",
      "ink2": "#9AA59A",
      "line": "#29402A",
      "dot": "#57B15D",
      "paperDim": "#1D251D",
      "inkDim": "#D5DBD5"
    },
    "teal": {
      "paper": "#0D2A28",
      "ink": "#D9E2E1",
      "ink2": "#94A6A4",
      "line": "#15413E",
      "dot": "#01BDB3",
      "paperDim": "#182625",
      "inkDim": "#D2DBDA"
    },
    "azure": {
      "paper": "#122732",
      "ink": "#D9E1E5",
      "ink2": "#96A4AC",
      "line": "#1D3E4E",
      "dot": "#00B3F0",
      "paperDim": "#1A242A",
      "inkDim": "#D3DADE"
    },
    "violet": {
      "paper": "#232234",
      "ink": "#DFDFE6",
      "ink2": "#A0A0AE",
      "line": "#383550",
      "dot": "#9D90F7",
      "paperDim": "#22222C",
      "inkDim": "#D8D8DF"
    },
    "fuchsia": {
      "paper": "#2D1E2C",
      "ink": "#E4DDE3",
      "ink2": "#A99DA8",
      "line": "#473045",
      "dot": "#D37ED0",
      "paperDim": "#282028",
      "inkDim": "#DDD7DD"
    }
  }
};
export const semantic: Readonly<Record<Theme, Readonly<Record<SemanticName, string>>>> = {
  "light": {
    "canvas": "#FCFCFB",
    "surface-1": "#FCFCFB",
    "surface-2": "#F8F8F6",
    "surface-3": "#F1F1EE",
    "overlay": "#FFFFFF",
    "hover": "#F1F1EE",
    "active": "#E9E9E5",
    "selected": "#EFF2FD",
    "text-1": "#1B1B18",
    "text-2": "#5C5C55",
    "text-3": "#6E6E64",
    "text-disabled": "#8C8C84",
    "text-on-accent": "#FFFFFF",
    "border-subtle": "#E2E2DD",
    "border": "#D3D3CD",
    "border-strong": "#B4B4AC",
    "accent": "#4C5FD5",
    "accent-hover": "#4353C4",
    "accent-active": "#3B49AF",
    "accent-subtle": "#EFF2FD",
    "accent-border": "#C3CCF6",
    "danger": "#C0362C",
    "danger-hover": "#A82D24",
    "danger-active": "#902620",
    "danger-subtle": "#FBEDEB",
    "danger-border": "#F0C4BF",
    "success": "#17784A",
    "success-subtle": "#E8F5ED",
    "warning": "#8A5A00",
    "warning-subtle": "#FCF3E0",
    "info": "#0A66A8",
    "focus": "#4C5FD5",
    "scrim": "rgba(24,24,20,.32)",
    "tooltip-bg": "#2E2E2A",
    "tooltip-text": "#FCFCFB"
  },
  "dark": {
    "canvas": "#131312",
    "surface-1": "#1A1A18",
    "surface-2": "#201F1D",
    "surface-3": "#272623",
    "overlay": "#232220",
    "hover": "rgba(255,255,255,.045)",
    "active": "rgba(255,255,255,.075)",
    "selected": "#1E2233",
    "text-1": "#EDEDEA",
    "text-2": "#A3A299",
    "text-3": "#96958B",
    "text-disabled": "#6E6D66",
    "text-on-accent": "#131312",
    "border-subtle": "rgba(255,255,255,.06)",
    "border": "rgba(255,255,255,.10)",
    "border-strong": "rgba(255,255,255,.16)",
    "accent": "#8E9BF5",
    "accent-hover": "#A2ADF8",
    "accent-active": "#7A88EC",
    "accent-subtle": "#1E2233",
    "accent-border": "#3A4270",
    "danger": "#F0736A",
    "danger-hover": "#F48A82",
    "danger-active": "#E55F55",
    "danger-subtle": "#2B1E1C",
    "danger-border": "#5C302C",
    "success": "#4DBE86",
    "success-subtle": "#16271F",
    "warning": "#D9A22E",
    "warning-subtle": "#2A2317",
    "info": "#5FB2E8",
    "focus": "#8E9BF5",
    "scrim": "rgba(0,0,0,.56)",
    "tooltip-bg": "#3A3A34",
    "tooltip-text": "#EDEDEA"
  }
};
export const shadow: Readonly<Record<Theme, Readonly<Record<"1" | "2" | "3" | "window", string>>>> = {
  "light": {
    "1": "0 1px 1px -.5px rgba(24,24,20,.10), 0 1px 2px -1px rgba(24,24,20,.06)",
    "2": "0 1px 1px -.5px rgba(24,24,20,.10), 0 3px 6px -2px rgba(24,24,20,.07), 0 8px 16px -8px rgba(24,24,20,.08)",
    "3": "0 1px 1px -.5px rgba(24,24,20,.11), 0 6px 12px -4px rgba(24,24,20,.09), 0 20px 40px -16px rgba(24,24,20,.16)",
    "window": "0 0 0 1px var(--note-line, var(--c-border)), 0 1px 1px -.5px rgba(24,24,20,.12), 0 6px 12px -4px rgba(24,24,20,.10), 0 20px 40px -16px rgba(24,24,20,.18)"
  },
  "dark": {
    "1": "0 1px 2px rgba(0,0,0,.34)",
    "2": "0 1px 2px rgba(0,0,0,.36), 0 4px 10px -4px rgba(0,0,0,.44)",
    "3": "0 2px 4px rgba(0,0,0,.40), 0 16px 32px -12px rgba(0,0,0,.60)",
    "window": "inset 0 1px 0 rgba(255,255,255,.07), 0 0 0 1px var(--note-line, var(--c-border)), 0 2px 4px rgba(0,0,0,.42), 0 16px 36px -12px rgba(0,0,0,.66)"
  }
};
export const tokens = {
  "gray": {
    "0": "#FFFFFF",
    "25": "#FCFCFB",
    "50": "#F8F8F6",
    "100": "#F1F1EE",
    "150": "#E9E9E5",
    "200": "#E2E2DD",
    "300": "#D3D3CD",
    "400": "#B4B4AC",
    "500": "#8C8C84",
    "550": "#6E6E64",
    "600": "#5C5C55",
    "700": "#4A4A44",
    "800": "#2E2E2A",
    "900": "#1B1B18",
    "950": "#111110"
  },
  "font": {
    "sans": "\"BF Punct\", -apple-system, BlinkMacSystemFont, \"Segoe UI Variable Text\", \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", \"Noto Sans SC\", \"Hiragino Sans GB\", Arial, sans-serif",
    "mono": "ui-monospace, \"SF Mono\", Menlo, \"Cascadia Mono\", Consolas, \"Sarasa Mono SC\", monospace"
  },
  "fontSize": {
    "2xs": "0.6875rem",
    "xs": "0.75rem",
    "sm": "0.8125rem",
    "md": "0.875rem",
    "lg": "0.9375rem",
    "xl": "1.0625rem",
    "2xl": "1.25rem",
    "3xl": "1.5rem",
    "4xl": "2rem"
  },
  "lineHeight": {
    "snug": "1.45",
    "cjk": "1.62",
    "body": "1.70",
    "loose": "1.85",
    "title": "1.4",
    "display": "1.35",
    "flush": "1.2"
  },
  "letterSpacing": {
    "tight": "-0.011em",
    "none": "0",
    "caps": "0.06em"
  },
  "fontWeight": {
    "normal": "400",
    "medium": "500",
    "strong": "600"
  },
  "uiScale": {
    "default": "1",
    "steps": [
      0.9,
      1,
      1.15,
      1.3
    ]
  },
  "spacing": {
    "1": "2px",
    "2": "4px",
    "3": "6px",
    "4": "8px",
    "5": "12px",
    "6": "16px",
    "7": "20px",
    "8": "24px",
    "9": "32px",
    "10": "40px",
    "11": "48px",
    "12": "64px"
  },
  "radius": {
    "xs": "3px",
    "sm": "5px",
    "md": "7px",
    "lg": "10px",
    "full": "999px",
    "window": "10px"
  },
  "border": {
    "hair": "1px"
  },
  "control": {
    "sm": "24px",
    "md": "28px",
    "lg": "32px"
  },
  "z": {
    "content": "0",
    "sticky": "10",
    "float": "20",
    "menu": "30",
    "command": "40",
    "modal": "50",
    "toast": "60",
    "drag": "70",
    "resize": "100"
  },
  "geometry": {
    "note-titlebar-h": "max(28px, 1.75rem)",
    "note-toolbar-h": "max(32px, 2rem)",
    "note-toolbar-h-static": "40px",
    "caption-btn-h": "var(--note-titlebar-h)",
    "caption-btn-w": "clamp(36px, 2.5rem, 56px)",
    "note-pad-x": "14px",
    "note-body-floor": "calc(var(--note-titlebar-h) + 24px + 95px)"
  },
  "duration": {
    "1": "90ms",
    "2": "140ms",
    "3": "200ms",
    "4": "300ms",
    "5": "360ms"
  },
  "delay": {
    "ack": "200ms",
    "selection": "180ms",
    "tooltip-in": "500ms",
    "tooltip-out": "100ms",
    "toolbar-blur": "200ms",
    "toolbar-leave": "800ms",
    "sync-show": "300ms"
  },
  "ease": {
    "out": "cubic-bezier(.16, 1, .3, 1)",
    "in": "cubic-bezier(.3, 0, .8, .15)",
    "in-out": "cubic-bezier(.65, 0, .35, 1)",
    "spring": "cubic-bezier(.34, 1.30, .52, 1)",
    "spring-linear": "linear(0, .164, .470, .746, .931, 1.026, 1.057, 1.053, 1.037, 1.020, 1.007, 1, 1)"
  },
  "contrastGates": {
    "$comment": "specs/06 §1.6 对类阈值；test/contrast.test.ts 据此计算",
    "note-ink": 10,
    "note-ink2": 4.5,
    "note-mark-sel": 4.5,
    "note-dot": 3,
    "focus-ring": 3,
    "body-text": 4.5,
    "tertiary-text": 4.5,
    "on-accent": 4.5,
    "semantic-text": 4.5,
    "tooltip": 4.5
  }
} as const;
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
  if (!m) throw new Error(`hexToRgb: 不是 #RRGGBB: ${hex}`);
  const n = Number.parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
