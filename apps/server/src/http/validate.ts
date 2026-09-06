// zod 校验（规格 04 §7.3）：所有 body/query/param 走 .strict()；失败 → 400 { error:'validation_error', issues }。
// 硬限：limit ≤ 500、批量 ≤ 200、标题 ≤ 200、评论 ≤ 4000、UUID 必须 v7、email 小写归一化。
import { zValidator } from "@hono/zod-validator";
import type { Env, MiddlewareHandler, ValidationTargets } from "hono";
import { z } from "zod";

export const LIMITS = {
  listMax: 500,
  batchMax: 200,
  titleMax: 200,
  commentMax: 4000,
  bodyBytesMax: 256 * 1024,
  workspaceNameMax: 80,
  jsonBodyMax: 512 * 1024,
} as const;

/** UUIDv7（客户端生成的一切业务 id） */
export const uuidV7 = z.uuidv7();
/** Better Auth 生成的 id（text；规格 04 R2 说是 uuidv7，但不硬校验格式，避免与占位实现冲突） */
export const authId = z.string().min(1).max(64);
export const emailLower = z
  .string()
  .trim()
  .max(254)
  .transform((s) => s.toLowerCase())
  .pipe(z.email());
export const isoDateTime = z.iso.datetime({ offset: true });
export const listLimit = z.coerce.number().int().min(1).max(LIMITS.listMax).default(100);
export const notePerm = z.enum(["viewer", "commenter", "editor", "manager"]);
export const noteColor = z.enum([
  "graphite",
  "rose",
  "coral",
  "amber",
  "citron",
  "fern",
  "teal",
  "azure",
  "violet",
  "fuchsia",
]);
export const zMode = z.union([z.literal(0), z.literal(1), z.literal(2)]);

type Target = keyof ValidationTargets;

/** zValidator 包装：统一 400 形状；schema 必须是 z.object(...).strict() 之类 */
export function validate<
  T extends z.ZodType,
  Tg extends Target,
  E extends Env = Env,
  P extends string = string,
>(target: Tg, schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.map(String).join("."),
        message: i.message,
        code: i.code,
      }));
      return c.json({ error: "validation_error", issues, server_time: Date.now() }, 400);
    }
    return undefined;
  }) as unknown as MiddlewareHandler<
    E,
    P,
    { in: { [K in Tg]: z.input<T> }; out: { [K in Tg]: z.output<T> } }
  >;
}
