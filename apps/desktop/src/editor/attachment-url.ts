// attachmentId → 本地可显示 URL（attachment_local_url：macOS bianfa-att://localhost/<id>，Windows http://bianfa-att.localhost/<id>）。
// 投影里的 bodyHtml 与 PM JSON 永远只存 bianfa://att/<id>，显示前在这里兑换。
import { attachmentIdFromSrc } from "@bianfa/shared";
import { useEffect, useState } from "react";
import { attachmentLocalUrl } from "../ipc/commands.js";

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

export function resolveAttachmentUrl(id: string): Promise<string> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(id);
  if (pending) return pending;
  const p = attachmentLocalUrl(id)
    .then(({ url }) => {
      cache.set(id, url);
      inflight.delete(id);
      return url;
    })
    .catch((err) => {
      inflight.delete(id);
      throw err;
    });
  inflight.set(id, p);
  return p;
}

export function useAttachmentUrl(id: string | null): string | null {
  const [url, setUrl] = useState<string | null>(id ? (cache.get(id) ?? null) : null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    resolveAttachmentUrl(id)
      .then((u) => alive && setUrl(u))
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
    };
  }, [id]);
  return url;
}

/** 静态 bodyHtml 挂载后：把 <img data-attachment-id> 的 src 换成本地 URL */
export async function hydrateAttachmentImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll<HTMLImageElement>("img[data-attachment-id], img[src^='bianfa://att/']"));
  await Promise.all(
    imgs.map(async (img) => {
      const id = img.dataset.attachmentId ?? attachmentIdFromSrc(img.getAttribute("src"));
      if (!id) return;
      try {
        const url = await resolveAttachmentUrl(id);
        if (img.isConnected) img.src = url;
      } catch {
        img.alt = img.alt || id;
      }
    }),
  );
}
