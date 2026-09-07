// 自动生成（pnpm -F @bianfa/tokens build），勿手改；来源 packages/tokens/src/tokens.json
export declare const NOTE_COLORS: readonly [ "graphite", "rose", "coral", "amber", "citron", "fern", "teal", "azure", "violet", "fuchsia", "slate", "carmine", "vermilion", "ochre", "olive", "pine", "peacock", "indigo", "wisteria", "eggplant" ];
export type NoteColor = (typeof NOTE_COLORS)[number];
export type Theme = "light" | "dark";
export declare const THEMES: readonly ["light", "dark"];
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
  /** 浓淡档：pale = 浅纸，deep = 浓纸（同一组色相各有一份） */
  readonly tier: "pale" | "deep";
  /** 档内序号 0–9（换色快捷键由 tier + slot 推导） */
  readonly slot: number;
}
export type SemanticName = "canvas" | "surface-1" | "surface-2" | "surface-3" | "overlay" | "hover" | "active" | "selected" | "text-1" | "text-2" | "text-3" | "text-disabled" | "text-on-accent" | "border-subtle" | "border" | "border-strong" | "accent" | "accent-hover" | "accent-active" | "accent-subtle" | "accent-border" | "danger" | "danger-hover" | "danger-active" | "danger-subtle" | "danger-border" | "success" | "success-subtle" | "warning" | "warning-subtle" | "info" | "focus" | "scrim" | "tooltip-bg" | "tooltip-text";
export declare const NOTE_COLOR_INFO: Readonly<Record<NoteColor, NoteColorInfo>>;
export declare const notePalette: Readonly<Record<Theme, Readonly<Record<NoteColor, NotePalette>>>>;
export declare const semantic: Readonly<Record<Theme, Readonly<Record<SemanticName, string>>>>;
export declare const shadow: Readonly<Record<Theme, Readonly<Record<"1" | "2" | "3" | "window", string>>>>;
export declare const tokens: {
  readonly gray: {
    readonly "0": "#FFFFFF";
    readonly "25": "#FCFCFB";
    readonly "50": "#F8F8F6";
    readonly "100": "#F1F1EE";
    readonly "150": "#E9E9E5";
    readonly "200": "#E2E2DD";
    readonly "300": "#D3D3CD";
    readonly "400": "#B4B4AC";
    readonly "500": "#8C8C84";
    readonly "550": "#6E6E64";
    readonly "600": "#5C5C55";
    readonly "700": "#4A4A44";
    readonly "800": "#2E2E2A";
    readonly "900": "#1B1B18";
    readonly "950": "#111110";
  };
  readonly font: {
    readonly sans: "\"BF Punct\", -apple-system, BlinkMacSystemFont, \"Segoe UI Variable Text\", \"Segoe UI\", \"PingFang SC\", \"Microsoft YaHei UI\", \"Microsoft YaHei\", \"Noto Sans SC\", \"Hiragino Sans GB\", Arial, sans-serif";
    readonly mono: "ui-monospace, \"SF Mono\", Menlo, \"Cascadia Mono\", Consolas, \"Sarasa Mono SC\", monospace";
  };
  readonly fontSize: {
    readonly "2xs": "0.6875rem";
    readonly xs: "0.75rem";
    readonly sm: "0.8125rem";
    readonly md: "0.875rem";
    readonly lg: "0.9375rem";
    readonly xl: "1.0625rem";
    readonly "2xl": "1.25rem";
    readonly "3xl": "1.5rem";
    readonly "4xl": "2rem";
  };
  readonly lineHeight: {
    readonly snug: "1.45";
    readonly cjk: "1.62";
    readonly body: "1.70";
    readonly loose: "1.85";
    readonly title: "1.4";
    readonly display: "1.35";
    readonly flush: "1.2";
  };
  readonly letterSpacing: {
    readonly tight: "-0.011em";
    readonly none: "0";
    readonly caps: "0.06em";
  };
  readonly fontWeight: {
    readonly normal: "400";
    readonly medium: "500";
    readonly strong: "600";
  };
  readonly uiScale: {
    readonly default: "1";
    readonly steps: readonly 0.9[];
  };
  readonly spacing: {
    readonly "1": "2px";
    readonly "2": "4px";
    readonly "3": "6px";
    readonly "4": "8px";
    readonly "5": "12px";
    readonly "6": "16px";
    readonly "7": "20px";
    readonly "8": "24px";
    readonly "9": "32px";
    readonly "10": "40px";
    readonly "11": "48px";
    readonly "12": "64px";
  };
  readonly radius: {
    readonly xs: "3px";
    readonly sm: "5px";
    readonly md: "7px";
    readonly lg: "10px";
    readonly full: "999px";
    readonly window: "10px";
  };
  readonly border: {
    readonly hair: "1px";
  };
  readonly control: {
    readonly sm: "24px";
    readonly md: "28px";
    readonly lg: "32px";
  };
  readonly z: {
    readonly content: "0";
    readonly sticky: "10";
    readonly float: "20";
    readonly menu: "30";
    readonly command: "40";
    readonly modal: "50";
    readonly toast: "60";
    readonly drag: "70";
    readonly resize: "100";
  };
  readonly geometry: {
    readonly "note-titlebar-h": "max(28px, 1.75rem)";
    readonly "note-toolbar-h": "max(32px, 2rem)";
    readonly "note-toolbar-h-static": "40px";
    readonly "caption-btn-h": "var(--note-titlebar-h)";
    readonly "caption-btn-w": "clamp(36px, 2.5rem, 56px)";
    readonly "note-pad-x": "14px";
    readonly "note-body-floor": "calc(var(--note-titlebar-h) + 24px + 95px)";
  };
  readonly duration: {
    readonly "1": "90ms";
    readonly "2": "140ms";
    readonly "3": "200ms";
    readonly "4": "300ms";
    readonly "5": "360ms";
  };
  readonly delay: {
    readonly ack: "200ms";
    readonly selection: "180ms";
    readonly "tooltip-in": "500ms";
    readonly "tooltip-out": "100ms";
    readonly "toolbar-blur": "200ms";
    readonly "toolbar-leave": "800ms";
    readonly "sync-show": "300ms";
  };
  readonly ease: {
    readonly out: "cubic-bezier(.16, 1, .3, 1)";
    readonly in: "cubic-bezier(.3, 0, .8, .15)";
    readonly "in-out": "cubic-bezier(.65, 0, .35, 1)";
    readonly spring: "cubic-bezier(.34, 1.30, .52, 1)";
    readonly "spring-linear": "linear(0, .164, .470, .746, .931, 1.026, 1.057, 1.053, 1.037, 1.020, 1.007, 1, 1)";
  };
  readonly contrastGates: {
    readonly $comment: "specs/06 §1.6 对类阈值；test/contrast.test.ts 据此计算";
    readonly "note-ink": 10;
    readonly "note-ink2": 4.5;
    readonly "note-mark-sel": 4.5;
    readonly "note-dot": 3;
    readonly "focus-ring": 3;
    readonly "body-text": 4.5;
    readonly "tertiary-text": 4.5;
    readonly "on-accent": 4.5;
    readonly "semantic-text": 4.5;
    readonly tooltip: 4.5;
  };
};
export declare function isNoteColor(value: unknown): value is NoteColor;
export declare function notePaper(color: string, theme: Theme): string;
export declare function hexToRgb(hex: string): [number, number, number];
