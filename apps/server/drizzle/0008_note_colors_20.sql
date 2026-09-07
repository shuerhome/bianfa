-- 0008：便笺调色板由 10 色扩到 20 色（10 个色相 × 浅/浓两档）。
-- 只放宽 CHECK 的取值集合，不改列、不改默认值、不动任何一行数据 —— 旧的 10 个枚举名原样保留，
-- 已有便笺的 color 全部仍在新集合里，所以这条迁移对存量数据是无操作的。
ALTER TABLE "notes" DROP CONSTRAINT IF EXISTS "notes_color_check";--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_color_check" CHECK ("notes"."color" IN ('graphite','rose','coral','amber','citron','fern','teal','azure','violet','fuchsia','slate','carmine','vermilion','ochre','olive','pine','peacock','indigo','wisteria','eggplant'));
