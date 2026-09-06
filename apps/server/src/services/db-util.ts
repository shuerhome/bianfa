// 原生 SQL 小工具：tx.execute(sql``) 的 rows 取型。所有 SQL 只用参数化（sql`` 模板自动绑定），禁止字符串拼接。
import { type SQL, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";

export async function rows<T extends Record<string, unknown>>(tx: Tx, query: SQL): Promise<T[]> {
  const r = (await tx.execute(query)) as unknown as { rows: T[] };
  return r.rows;
}

export async function one<T extends Record<string, unknown>>(tx: Tx, query: SQL): Promise<T | undefined> {
  return (await rows<T>(tx, query))[0];
}

/** PG 的 bigint/numeric 以字符串返回；统一转 number（lsn / seq / 计数在 2^53 内） */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  if (typeof v === "bigint") return Number(v);
  return 0;
}

/** node-postgres 经 drizzle 时 timestamptz 以字符串返回；统一转 Date */
export function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string" && v.length > 0) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * PG 数组参数：drizzle 的 sql`` 会把 JS 数组展开成 ($1, $2) 列表，不能直接 `= ANY(${arr}::uuid[])`；
 * 这里按 PG 数组字面量（元素双引号包裹并转义）作为单个参数传入，调用方在其后加 ::uuid[] / ::text[] / ::bigint[]。
 */
export function pgArray(values: readonly (string | number)[]): SQL {
  const literal = `{${values.map((v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
  return sql`${literal}`;
}

export function iso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return new Date(v).toISOString();
  return null;
}
