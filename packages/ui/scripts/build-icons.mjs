#!/usr/bin/env node
// 从 lucide-static 抽取本应用用到的图标路径，生成 src/icons/sprite.generated.ts（构建期，不在运行时读文件）。
// 用法：pnpm -F @bianfa/ui build:icons。生成物提交进 git；`build` 本身不重新生成。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const lucideDir = dirname(require.resolve("lucide-static/package.json"));

/** 应用用到的 Lucide 图标名（kebab-case，= lucide-static/icons/<name>.svg） */
export const ICON_NAMES = [
  "archive-restore",
  "arrow-left",
  "arrow-up-down",
  "badge-check",
  "bold",
  "check",
  "chevron-down",
  "chevron-left",
  "chevron-right",
  "circle-alert",
  "clock",
  "cloud",
  "cloud-off",
  "code",
  "command",
  "copy",
  "database",
  "download",
  "ellipsis",
  "external-link",
  "eye",
  "file-down",
  "file-text",
  "file-up",
  "folder-open",
  "heading",
  "history",
  "image",
  "inbox",
  "info",
  "italic",
  "keyboard",
  "languages",
  "layout-grid",
  "layout-list",
  "link",
  "list",
  "list-checks",
  "list-todo",
  "lock",
  "log-in",
  "log-out",
  "minus",
  "monitor",
  "moon",
  "paintbrush",
  "palette",
  "pin",
  "pin-off",
  "plus",
  "quote",
  "refresh-cw",
  "rotate-ccw",
  "save",
  "search",
  "settings",
  "square",
  "square-check",
  "strikethrough",
  "sun",
  "trash-2",
  "triangle-alert",
  "underline",
  "upload",
  "user",
  "users",
  "wifi-off",
  "x",
];

const inner = (svg) => {
  const m = /<svg[^>]*>([\s\S]*?)<\/svg>/.exec(svg);
  if (!m) throw new Error("bad svg");
  return m[1]
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .replace(/> </g, "><")
    .trim();
};

const symbols = ICON_NAMES.map((name) => {
  const svg = readFileSync(resolve(lucideDir, "icons", `${name}.svg`), "utf8");
  return `  "${name}": ${JSON.stringify(inner(svg))},`;
});

const file = `// 自动生成：pnpm -F @bianfa/ui build:icons（lucide-static ${require("lucide-static/package.json").version}，ISC）。勿手改。
// viewBox 0 0 24 24；stroke=currentColor；stroke-width 1.5 由 <Icon> 统一设置。
export const ICON_PATHS = {
${symbols.join("\n")}
} as const;
export type IconName = keyof typeof ICON_PATHS;
export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];
`;
mkdirSync(resolve(here, "../src/icons"), { recursive: true });
writeFileSync(resolve(here, "../src/icons/sprite.generated.ts"), file);
console.log(`icons: ${ICON_NAMES.length} symbols → src/icons/sprite.generated.ts`);
