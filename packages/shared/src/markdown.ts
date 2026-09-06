// Markdown 边界（规格 02 §4 / §6.10）：导出、LLM 边界、导入。基于 @tiptap/markdown 的 MarkdownManager，
// headless 可用（不需要 Editor / DOM）。降级规则：`**b**` `*i*` `<u>u</u>` `~~s~~` `- ` `- [ ] / - [x] `
// `[t](url)` `![alt](attachments/<hash>.<ext>)` `#` ``` 。
import { MarkdownManager } from "@tiptap/markdown";
import { Node as PMNode } from "@tiptap/pm/model";
import { createEditorExtensions, getSchemaV1 } from "./editor/schema.js";
import { EMPTY_PM_DOC, type PMJson } from "./projector.js";

export interface MarkdownExportOptions {
  /** image 节点的 `![alt](…)` 路径；默认 `bianfa://att/<id>`。导出 zip 传 `attachments/<hash>.<ext>` */
  attachmentPath?: (attachmentId: string) => string;
}

export interface MarkdownImportOptions {
  /**
   * 把 `![alt](src)` 的 src 解析成 attachmentId；返回 null 则该图片退化成字面文本。
   * 默认只识别 `bianfa://att/<id>`。
   */
  resolveImage?: (src: string, alt: string) => string | null;
}

interface ManagerOptions {
  markdownPath?: (attachmentId: string) => string;
  resolveMarkdownSrc?: (src: string, alt: string) => string | null;
}

function createManager(options: ManagerOptions): MarkdownManager {
  const image: ManagerOptions = {};
  if (options.markdownPath) image.markdownPath = options.markdownPath;
  if (options.resolveMarkdownSrc) image.resolveMarkdownSrc = options.resolveMarkdownSrc;
  return new MarkdownManager({
    extensions: createEditorExtensions({ collaboration: false, image }),
    indentation: { style: "space", size: 2 },
  });
}

let defaultManager: MarkdownManager | null = null;
function getDefaultManager(): MarkdownManager {
  if (!defaultManager) defaultManager = createManager({});
  return defaultManager;
}

/** PM JSON → Markdown */
export function pmJsonToMarkdown(json: PMJson, options: MarkdownExportOptions = {}): string {
  const manager = options.attachmentPath
    ? createManager({ markdownPath: options.attachmentPath })
    : getDefaultManager();
  return manager.serialize(json);
}

const isBlockJson = (node: PMJson, blockTypes: ReadonlySet<string>): boolean =>
  typeof node.type === "string" && blockTypes.has(node.type);

/**
 * 规整 MarkdownManager 的输出：
 * - 顶层永远是 `{ type: 'doc', content: [...] }`；
 * - 文本块里混进的块级节点（如行内位置的图片）提升到同级，前后文本各自成段；
 * - 丢掉空文本节点。
 */
export function normalizePmJson(json: PMJson): PMJson {
  const schema = getSchemaV1();
  const blockTypes = new Set(
    Object.values(schema.nodes)
      .filter((t) => t.isBlock)
      .map((t) => t.name),
  );
  const textblockTypes = new Set(
    Object.values(schema.nodes)
      .filter((t) => t.isTextblock)
      .map((t) => t.name),
  );

  const normalizeInline = (nodes: PMJson[]): PMJson[] =>
    nodes.filter((n) => !(n.type === "text" && (n.text ?? "") === ""));

  const normalizeBlock = (node: PMJson): PMJson[] => {
    if (typeof node.type === "string" && textblockTypes.has(node.type)) {
      const inline = node.content ?? [];
      if (!inline.some((n) => isBlockJson(n, blockTypes))) {
        return [{ ...node, content: normalizeInline(inline) }];
      }
      const out: PMJson[] = [];
      let run: PMJson[] = [];
      const flush = () => {
        const cleaned = normalizeInline(run);
        if (cleaned.length > 0) out.push({ ...node, content: cleaned });
        run = [];
      };
      for (const child of inline) {
        if (isBlockJson(child, blockTypes)) {
          flush();
          out.push(...normalizeBlock(child));
        } else run.push(child);
      }
      flush();
      return out;
    }
    if (node.content) {
      return [{ ...node, content: node.content.flatMap(normalizeBlock) }];
    }
    return [node];
  };

  const content = (json.content ?? []).flatMap(normalizeBlock);
  return { type: "doc", content };
}

/** Markdown → PM JSON（schema v1 校验，非法结构抛错） */
export function markdownToPmJson(markdown: string, options: MarkdownImportOptions = {}): PMJson {
  const manager = options.resolveImage
    ? createManager({ resolveMarkdownSrc: options.resolveImage })
    : getDefaultManager();
  const parsed = normalizePmJson(manager.parse(markdown) as PMJson);
  if (parsed.content?.length === 0) return { ...EMPTY_PM_DOC, content: [] };
  PMNode.fromJSON(getSchemaV1(), parsed).check();
  return parsed;
}

/** 一行文字里可能被当成块级语法的前缀，转义成字面量（导入纯文本行时用） */
export function escapeBlockSyntax(line: string): string {
  return line
    .replace(/^(\s*)([-+*#>|])/, "$1\\$2")
    .replace(/^(\s*\d+)([.)])(\s)/, "$1\\$2$3")
    .replace(/^(\s*)(```|~~~)/, "$1\\$2")
    .replace(/^(\s*)(---+|\*\*\*+|___+)\s*$/, "$1\\$2");
}

/**
 * 把「每行一段、只含行内标记」的文本（原版便笺导出的 markdown 形态）解析成 PM JSON：
 * 每个 `\n` 都是段落边界，空行 = 空段落；行首的块级语法按字面量处理。
 */
export function inlineLinesToPmJson(text: string, options: MarkdownImportOptions = {}): PMJson {
  const content: PMJson[] = [];
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.replace(/^[ \t]+/, "");
    if (line.trim().length === 0) {
      content.push({ type: "paragraph" });
      continue;
    }
    const parsed = markdownToPmJson(escapeBlockSyntax(line), options);
    const blocks = parsed.content ?? [];
    if (blocks.length === 0) content.push({ type: "paragraph", content: [{ type: "text", text: line }] });
    else content.push(...blocks);
  }
  return { type: "doc", content };
}
