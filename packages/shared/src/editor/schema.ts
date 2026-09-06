// Tiptap 3 schema v1（规格 02 §4）。必须能在 Node 里 headless 使用：本文件只组装扩展与 schema，
// 不创建 Editor、不触碰 DOM。桌面端在此基础上追加 Collaboration（document, field: BODY_FIELD）等
// 需要 Y.Doc / 视图的扩展。
import { getSchema, type MarkdownParseHelpers, type MarkdownToken } from "@tiptap/core";
import { Link } from "@tiptap/extension-link";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import { Underline } from "@tiptap/extension-underline";
import { UniqueID } from "@tiptap/extension-unique-id";
import type { Schema } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { StarterKit } from "@tiptap/starter-kit";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { nanoid } from "nanoid";
import { Image, type ImageOptions } from "./image.js";

export { SCHEMA_VERSION } from "./version.js";
export { ATTACHMENT_SRC_PREFIX, attachmentIdFromSrc, attachmentSrc, Image, type ImageAttrs } from "./image.js";

/** taskItem.attrs.id 的生成器：nanoid(10)（规格 02 §1.6 / §3） */
export const TASK_ITEM_ID_ATTR = "id";
export const TASK_ITEM_ID_LENGTH = 10;
export const generateTaskItemId = (): string => nanoid(TASK_ITEM_ID_LENGTH);

/** 链接只允许这三种协议（规格 02 §4） */
export const LINK_PROTOCOLS = ["http", "https", "mailto"] as const;
const LINK_SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

export function isAllowedLinkHref(href: string | null | undefined): boolean {
  if (typeof href !== "string") return false;
  const trimmed = href.trim();
  const match = LINK_SCHEME_RE.exec(trimmed);
  if (!match?.[1]) return false;
  const scheme = match[1].toLowerCase();
  if (!(LINK_PROTOCOLS as readonly string[]).includes(scheme)) return false;
  if (scheme === "mailto") return trimmed.length > "mailto:".length;
  return /^https?:\/\/[^\s/?#]+/i.test(trimmed);
}

/** 与 @tiptap/extension-collaboration 的 isChangeOrigin 等价：远端（y-sync 回放）事务为 true */
export function isRemoteTransaction(tr: Transaction): boolean {
  const meta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return meta?.isChangeOrigin === true;
}

const UNDERLINE_OPEN = "<u>";
const UNDERLINE_CLOSE = "</u>";

/**
 * 下划线的 Markdown 形态按规格 §6.10 用 `<u>…</u>`（Tiptap 默认的 `++…++` 不是通用 Markdown）。
 * 自定义 tokenizer 在 marked 内置 html tokenizer 之前运行，因此 headless（无 DOMParser）也能解析。
 */
const UnderlineHtml = Underline.extend({
  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    return helpers.applyMark("underline", helpers.parseInline(token.tokens ?? []));
  },
  renderMarkdown(node, helpers) {
    return `${UNDERLINE_OPEN}${helpers.renderChildren(node)}${UNDERLINE_CLOSE}`;
  },
  markdownTokenizer: {
    name: "underline",
    level: "inline",
    start: (src: string) => src.indexOf(UNDERLINE_OPEN),
    tokenize: (src: string, _tokens: MarkdownToken[], lexer) => {
      const match = /^<u>([\s\S]+?)<\/u>/.exec(src);
      if (!match || match[1] === undefined) return undefined;
      return {
        type: "underline",
        raw: match[0],
        text: match[1],
        tokens: lexer.inlineTokens(match[1]),
      };
    },
  },
});

export interface EditorExtensionsOptions {
  /**
   * true（默认）：协同模式——关闭 StarterKit 的 undoRedo（由 Y.UndoManager 接管），
   * UniqueID 跳过远端事务。false：独立编辑器 / headless。
   */
  collaboration?: boolean;
  /** 透传给 image 节点：Markdown 导出路径与导入解析 */
  image?: Partial<Pick<ImageOptions, "markdownPath" | "resolveMarkdownSrc">>;
}

/**
 * Schema v1 扩展列表。节点：doc/paragraph/text/hardBreak/heading(1-3)/bulletList/orderedList/listItem/
 * taskList/taskItem(checked,id)/image/codeBlock/blockquote/horizontalRule；标记：bold/italic/underline/strike/code/link。
 */
export function createEditorExtensions(options: EditorExtensionsOptions = {}) {
  const collaboration = options.collaboration ?? true;
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // 协同下用 Y.UndoManager（y-tiptap 的 yUndoPlugin），StarterKit 自带的历史必须关
      undoRedo: collaboration ? false : {},
      // 下面三项我们单独配置，避免重复注册
      underline: false,
      link: false,
    }),
    UnderlineHtml,
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: "https",
      isAllowedUri: (url) => isAllowedLinkHref(url),
      shouldAutoLink: (url) => isAllowedLinkHref(url),
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure(options.image ?? {}),
    UniqueID.configure({
      attributeName: TASK_ITEM_ID_ATTR,
      types: ["taskItem"],
      generateID: () => generateTaskItemId(),
      filterTransaction: collaboration ? (tr) => !isRemoteTransaction(tr) : null,
    }),
  ];
}

let cachedSchema: Schema | null = null;

/** schema v1 的 ProseMirror Schema（进程内缓存；headless 可用） */
export function getSchemaV1(): Schema {
  if (!cachedSchema) cachedSchema = getSchema(createEditorExtensions({ collaboration: false }));
  return cachedSchema;
}
