-- 总管理员及其团队不受套餐限制：把单文件大小的 CHECK 从 10 MB 放宽到 200 MB。
--
-- 为什么必须动库：单文件上限有两道闸门 —— 应用层（routes/attachments.ts 按工作区判定，
-- 普通用户仍是 10 MB）和这条 CHECK。应用层放开了，插入 attachments 行时照样会被 CHECK 拒掉。
--
-- 为什么是 200 MB 而不是「无限」：桌面端上传是 `std::fs::read(&path)` —— 整个文件读进内存再 PUT
-- （apps/desktop/src-tauri/src/app/attachments.rs）。200 MB 的峰值内存约 400 MB（读一份 + HTTP 客户端
-- 再拷一份），桌面端扛得住；再往上就该把客户端改成流式上传，而不是继续调大这个数。
-- 另外 S3/R2 单次预签名 PUT 的协议上限是 5 GiB，超过必须走分片上传。
--
-- 这条 CHECK 现在是**绝对天花板**（防脏数据），不是套餐策略；谁能用多大由应用层按
-- isUnlimitedWorkspace 决定。放宽 CHECK 不会让普通用户传更大的文件。
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_byte_size_check;--> statement-breakpoint
ALTER TABLE attachments ADD CONSTRAINT attachments_byte_size_check CHECK (byte_size > 0 AND byte_size <= 209715200);
