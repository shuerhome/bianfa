// 自定义 image 节点（规格 02 §3 附件引用 / 01 S1）：Y.Doc 只存 attachmentId，
// attrs = { attachmentId, w, h, blurhash, alt }。渲染 src 一律 `bianfa://att/<id>`，
// 由客户端自定义协议 / 服务端 5 min 签名 URL 兑换；绝不写 base64 data URI、绝不写 blob://hash。
import {
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownToken,
  mergeAttributes,
  Node,
} from "@tiptap/core";

export const ATTACHMENT_SRC_PREFIX = "bianfa://att/";

export function attachmentSrc(attachmentId: string): string {
  return `${ATTACHMENT_SRC_PREFIX}${attachmentId}`;
}

/** `bianfa://att/<id>` → id；其它任何形式 → null */
export function attachmentIdFromSrc(src: string | null | undefined): string | null {
  if (typeof src !== "string" || !src.startsWith(ATTACHMENT_SRC_PREFIX)) return null;
  const id = src.slice(ATTACHMENT_SRC_PREFIX.length);
  return id.length > 0 && !/[/?#\s]/.test(id) ? id : null;
}

export interface ImageAttrs {
  attachmentId: string | null;
  w: number | null;
  h: number | null;
  blurhash: string | null;
  alt: string | null;
}

export interface ImageOptions {
  HTMLAttributes: Record<string, unknown>;
  /**
   * Markdown 序列化时 `![alt](…)` 的路径；默认 `bianfa://att/<id>`。
   * 导出 zip 时传 `(id) => "attachments/<hash>.<ext>"`。
   */
  markdownPath: (attachmentId: string) => string;
  /**
   * Markdown 解析时把 `![alt](src)` 的 src 解析成 attachmentId；返回 null 表示不识别，
   * 该图片退化为字面文本 `![alt](src)`。默认只识别 `bianfa://att/<id>`。
   */
  resolveMarkdownSrc: (src: string, alt: string) => string | null;
}

const toPositiveInt = (value: string | null): number | null => {
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

type AttrElement = {
  getAttribute(name: string): string | null;
};

export const Image = Node.create<ImageOptions>({
  name: "image",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
      markdownPath: attachmentSrc,
      resolveMarkdownSrc: (src) => attachmentIdFromSrc(src),
    };
  },

  addAttributes() {
    return {
      attachmentId: {
        default: null,
        rendered: false,
        parseHTML: (element: AttrElement) =>
          element.getAttribute("data-attachment-id") ?? attachmentIdFromSrc(element.getAttribute("src")),
      },
      w: { default: null, rendered: false, parseHTML: (el: AttrElement) => toPositiveInt(el.getAttribute("width")) },
      h: { default: null, rendered: false, parseHTML: (el: AttrElement) => toPositiveInt(el.getAttribute("height")) },
      blurhash: { default: null, rendered: false, parseHTML: (el: AttrElement) => el.getAttribute("data-blurhash") },
      alt: { default: null, rendered: false, parseHTML: (el: AttrElement) => el.getAttribute("alt") },
    };
  },

  parseHTML() {
    return [{ tag: "img[data-attachment-id]" }, { tag: `img[src^="${ATTACHMENT_SRC_PREFIX}"]` }];
  },

  renderHTML({ node }) {
    const attrs = node.attrs as ImageAttrs;
    const rendered: Record<string, string | number> = {};
    if (attrs.attachmentId) {
      rendered.src = attachmentSrc(attrs.attachmentId);
      rendered["data-attachment-id"] = attrs.attachmentId;
    }
    if (attrs.w) rendered.width = attrs.w;
    if (attrs.h) rendered.height = attrs.h;
    if (attrs.blurhash) rendered["data-blurhash"] = attrs.blurhash;
    if (attrs.alt !== null && attrs.alt !== undefined) rendered.alt = attrs.alt;
    return ["img", mergeAttributes(this.options.HTMLAttributes, rendered)];
  },

  // 纯文本投影里 image 为空串（规格 02 §3 projector）
  renderText() {
    return "";
  },

  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers) {
    const src = typeof token.href === "string" ? token.href : "";
    const alt = typeof token.text === "string" ? token.text : "";
    const attachmentId = src ? this.options.resolveMarkdownSrc(src, alt) : null;
    if (!attachmentId) return helpers.createTextNode(token.raw ?? `![${alt}](${src})`);
    return helpers.createNode("image", {
      attachmentId,
      w: null,
      h: null,
      blurhash: null,
      alt: alt || null,
    } satisfies ImageAttrs);
  },

  renderMarkdown(node: JSONContent) {
    const attrs = (node.attrs ?? {}) as Partial<ImageAttrs>;
    if (!attrs.attachmentId) return "";
    const alt = (attrs.alt ?? "").replace(/[[\]]/g, "\\$&");
    return `![${alt}](${this.options.markdownPath(attrs.attachmentId)})`;
  },
});
