// 对象存储（Cloudflare R2，S3 兼容）：只在 api 进程签 presigned URL（PUT 15 min / GET 5 min / 导出 24 h），
// worker 用同一客户端做 GC 删除与导出上传。R2 env 缺失 → createObjectStorage 返回 null → 附件功能 503 attachments_disabled。
// 本地/测试用 LocalObjectStorage（落盘到目录，URL 为 file: 路径），仅供导出任务与单测，不对外签发。
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { R2Config } from "../http/env.js";

export const PRESIGN_PUT_SECONDS = 15 * 60;
export const PRESIGN_GET_SECONDS = 5 * 60;
export const PRESIGN_EXPORT_SECONDS = 24 * 60 * 60;

export interface ObjectStat {
  size: number;
  etag?: string | undefined;
}

export interface ObjectStorage {
  readonly kind: "r2" | "local";
  presignPut(
    key: string,
    opts: { contentType: string; contentLength: number; expiresIn?: number },
  ): Promise<string>;
  presignGet(key: string, opts?: { expiresIn?: number; downloadName?: string }): Promise<string>;
  head(key: string): Promise<ObjectStat | null>;
  /** 读前 n 字节（magic bytes 校验） */
  readHead(key: string, bytes: number): Promise<Buffer | null>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string, limit?: number): Promise<{ key: string; size: number; lastModified: Date | null }[]>;
}

/** attachments.storage_key：'ws/<workspace_id>/blake3/<hex[0:2]>/<hex[2:4]>/<hex>'（规格 02 §1.5） */
export function attachmentStorageKey(workspaceId: string, hashHex: string): string {
  const h = hashHex.toLowerCase();
  return `ws/${workspaceId}/blake3/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`;
}

export function exportStorageKey(userId: string, jobId: string): string {
  return `exports/${userId}/${jobId}.zip`;
}

export function createR2Storage(cfg: R2Config, bucket: string = cfg.bucket): ObjectStorage {
  const client = new S3Client({
    region: "auto",
    endpoint: cfg.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  const toBuffer = async (body: unknown): Promise<Buffer> => {
    const b = body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (b?.transformToByteArray) return Buffer.from(await b.transformToByteArray());
    return Buffer.alloc(0);
  };
  return {
    kind: "r2",
    presignPut: (key, opts) =>
      getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: opts.contentType,
          ContentLength: opts.contentLength,
        }),
        { expiresIn: opts.expiresIn ?? PRESIGN_PUT_SECONDS },
      ),
    presignGet: (key, opts = {}) =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(opts.downloadName
            ? {
                ResponseContentDisposition: `attachment; filename="${opts.downloadName.replace(/["\r\n]/g, "")}"`,
              }
            : {}),
        }),
        { expiresIn: opts.expiresIn ?? PRESIGN_GET_SECONDS },
      ),
    async head(key) {
      try {
        const r = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: r.ContentLength ?? 0, etag: r.ETag };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async readHead(key, bytes) {
      try {
        const r = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${bytes - 1}` }),
        );
        return toBuffer(r.Body);
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async list(prefix, limit = 1000) {
      const out: { key: string; size: number; lastModified: Date | null }[] = [];
      let token: string | undefined;
      do {
        const r = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
            MaxKeys: Math.min(1000, limit - out.length),
          }),
        );
        for (const o of r.Contents ?? []) {
          if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified ?? null });
        }
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token && out.length < limit);
      return out;
    },
  };
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

/** 本地目录实现（开发 / 测试 / R2 缺失时的导出落盘）；URL 为 file:// 路径，仅用于本机验证 */
export function createLocalStorage(root: string): ObjectStorage {
  const path = (key: string) => join(root, key.replace(/[^A-Za-z0-9_./-]/g, "_"));
  return {
    kind: "local",
    async presignPut(key) {
      return `file://${path(key)}`;
    },
    async presignGet(key) {
      return `file://${path(key)}`;
    },
    async head(key) {
      try {
        const s = await stat(path(key));
        return { size: s.size };
      } catch {
        return null;
      }
    },
    async readHead(key, bytes) {
      try {
        const buf = await readFile(path(key));
        return buf.subarray(0, bytes);
      } catch {
        return null;
      }
    },
    async put(key, body) {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, body);
    },
    async delete(key) {
      await rm(path(key), { force: true });
    },
    async list() {
      return [];
    },
  };
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 允许的图片 magic bytes（规格 04 §7.10：infer 校验；这里内置 4 种） */
export function sniffImageMime(head: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  if (
    head.length >= 8 &&
    head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (
    head.length >= 6 &&
    (head.subarray(0, 6).toString("ascii") === "GIF87a" || head.subarray(0, 6).toString("ascii") === "GIF89a")
  )
    return "image/gif";
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString("ascii") === "RIFF" &&
    head.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return null;
}
