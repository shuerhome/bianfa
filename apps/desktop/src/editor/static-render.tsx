// 两级编辑器的「下级」：未聚焦窗口只渲染 bodyHtml（DOMPurify 清洗），零 JS 编辑器实例。
import DOMPurify, { type Config } from "dompurify";
import { useEffect, useRef } from "react";
import { hydrateAttachmentImages } from "./attachment-url.js";

const purifyConfig: Config = {
  ALLOWED_TAGS: [
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "s",
    "del",
    "code",
    "pre",
    "a",
    "ul",
    "ol",
    "li",
    "h1",
    "h2",
    "h3",
    "blockquote",
    "hr",
    "img",
    "label",
    "input",
    "span",
    "div",
  ],
  ALLOWED_ATTR: [
    "href",
    "class",
    "data-type",
    "data-checked",
    "data-attachment-id",
    "data-blurhash",
    "src",
    "alt",
    "width",
    "height",
    "type",
    "checked",
    "disabled",
    "rel",
    "target",
  ],
  ALLOWED_URI_REGEXP:
    /^(?:https?|mailto|bianfa|bianfa-att|asset):|^http:\/\/(?:bianfa-att|asset)\.localhost\//i,
};

export function sanitizeBodyHtml(html: string): string {
  return DOMPurify.sanitize(html, purifyConfig);
}

export interface StaticBodyProps {
  html: string;
  className?: string;
}

/** 静态正文：innerHTML 用清洗后的 html；挂载后把附件 src 换成本地 URL */
export function StaticBody({ html, className }: StaticBodyProps) {
  const ref = useRef<HTMLDivElement>(null);
  const safe = sanitizeBodyHtml(html);
  // biome-ignore lint/correctness/useExhaustiveDependencies: html 变化后需重新兑换附件 src
  useEffect(() => {
    const el = ref.current;
    if (el) void hydrateAttachmentImages(el);
  }, [safe]);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: 内容来自 static-renderer 并经 DOMPurify 白名单清洗
  return <div ref={ref} className={className} dangerouslySetInnerHTML={{ __html: safe }} />;
}
