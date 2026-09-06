// image 节点视图：src 经 attachment_local_url 兑换；未就绪时按 w/h 比例占位（不解 blurhash，零依赖）。
import type { ImageAttrs } from "@bianfa/shared";
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { useAttachmentUrl } from "./attachment-url.js";

export function ImageView({ node, selected }: ReactNodeViewProps) {
  const attrs = node.attrs as ImageAttrs;
  const url = useAttachmentUrl(attrs.attachmentId);
  const ratio = attrs.w && attrs.h ? `${attrs.w} / ${attrs.h}` : undefined;
  return (
    <NodeViewWrapper className={selected ? "bf-image bf-image--selected" : "bf-image"} data-drag-handle>
      {url ? (
        <img src={url} alt={attrs.alt ?? ""} width={attrs.w ?? undefined} height={attrs.h ?? undefined} draggable={false} />
      ) : (
        <span className="bf-image__placeholder" style={ratio ? { aspectRatio: ratio } : undefined} aria-hidden="true" />
      )}
    </NodeViewWrapper>
  );
}
