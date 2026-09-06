-- =============================================================================
-- 0002 · uuidv7 默认值（仅 PG ≥ 18）+ INCLUDE 索引 + RLS + 显式授权（custom migration）
-- -----------------------------------------------------------------------------
-- * uuidv7()：PG 18 内置，本地 PG16 没有 → 按 server_version_num 条件 SET DEFAULT。服务端代码永远自己生成 UUIDv7
--   （src/db/ids.ts），DEFAULT 只是直建时的兜底（规格 02 §0）。
-- * notes_list_idx：INCLUDE 子句 drizzle 表达不了（规格 02 §1.3 Q1 列表索引）。
-- * RLS（规格 02 §1.8）：兜底不是主授权。上下文 = 事务内 set_config('app.user_id', $1, true)；
--   策略读 NULLIF(current_setting('app.user_id', true), '')（未设置 / 事务结束后为空串 → NULL → 零行，fail-closed）。
--   app.user_id 是 text，与 "user".id 直接比较，不做 ::uuid。策略里不调用 PL/pgSQL 函数。
--   策略 TO bianfa_app（成员角色同样适用）；bianfa_worker BYPASSRLS；超级用户天然绕过。
--   ENABLE + FORCE：bianfa_app 不是表 owner，ENABLE 已生效，FORCE 是对非超级用户 owner 的加固。
--   WITH CHECK 重复 USING 的表达式（规格要求，不用 true）。
--   注意递归：notes 的策略引用 shares，所以 shares 的策略不能再引用 notes（PG 会报 infinite recursion），
--   shares 只按 grantee_user_id / created_by 判定 —— 工作区 owner 列出他人建的共享行需经应用层 authorize() 或 worker 角色。
-- * 授权：0000 的 ALTER DEFAULT PRIVILEGES 已覆盖后建对象；这里对当前 schema 内全部表/序列再显式 GRANT 一次（幂等）。
-- =============================================================================
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 180000 THEN
    EXECUTE 'ALTER TABLE workspaces ALTER COLUMN id SET DEFAULT uuidv7()';
    EXECUTE 'ALTER TABLE shares ALTER COLUMN id SET DEFAULT uuidv7()';
  END IF;
END
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notes_list_idx ON notes (workspace_id, pinned DESC, updated_at DESC)
  INCLUDE (title_cache, color) WHERE deleted_at IS NULL;
--> statement-breakpoint
-- ---------------------------------------------------------------- workspaces
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS workspaces_access ON workspaces;
--> statement-breakpoint
CREATE POLICY workspaces_access ON workspaces FOR ALL TO bianfa_app
USING (
  workspaces.owner_user_id = NULLIF(current_setting('app.user_id', true), '')
  OR (workspaces.kind = 'team'
      AND EXISTS (SELECT 1 FROM member m
                   WHERE m."organizationId" = workspaces.org_id
                     AND m."userId" = NULLIF(current_setting('app.user_id', true), ''))
      AND (workspaces.team_id IS NULL
           OR EXISTS (SELECT 1 FROM "teamMember" tm
                       WHERE tm."teamId" = workspaces.team_id
                         AND tm."userId" = NULLIF(current_setting('app.user_id', true), ''))))
)
WITH CHECK (
  workspaces.owner_user_id = NULLIF(current_setting('app.user_id', true), '')
  OR (workspaces.kind = 'team'
      AND EXISTS (SELECT 1 FROM member m
                   WHERE m."organizationId" = workspaces.org_id
                     AND m."userId" = NULLIF(current_setting('app.user_id', true), ''))
      AND (workspaces.team_id IS NULL
           OR EXISTS (SELECT 1 FROM "teamMember" tm
                       WHERE tm."teamId" = workspaces.team_id
                         AND tm."userId" = NULLIF(current_setting('app.user_id', true), ''))))
);
--> statement-breakpoint
-- ---------------------------------------------------------------- notes
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS notes_access ON notes;
--> statement-breakpoint
CREATE POLICY notes_access ON notes FOR ALL TO bianfa_app
USING (
  EXISTS (SELECT 1 FROM workspaces w
           WHERE w.id = notes.workspace_id
             AND w.owner_user_id = NULLIF(current_setting('app.user_id', true), ''))
  OR EXISTS (SELECT 1 FROM workspaces w
              JOIN member m ON m."organizationId" = w.org_id
             WHERE w.id = notes.workspace_id AND w.kind = 'team'
               AND m."userId" = NULLIF(current_setting('app.user_id', true), '')
               AND (w.team_id IS NULL
                    OR EXISTS (SELECT 1 FROM "teamMember" tm
                                WHERE tm."teamId" = w.team_id
                                  AND tm."userId" = NULLIF(current_setting('app.user_id', true), ''))))
  OR EXISTS (SELECT 1 FROM shares s
              WHERE s.note_id = notes.id AND s.grantee_kind = 'user'
                AND s.grantee_user_id = NULLIF(current_setting('app.user_id', true), '')
                AND s.revoked_at IS NULL
                AND (s.expires_at IS NULL OR s.expires_at > now()))
)
WITH CHECK (
  EXISTS (SELECT 1 FROM workspaces w
           WHERE w.id = notes.workspace_id
             AND w.owner_user_id = NULLIF(current_setting('app.user_id', true), ''))
  OR EXISTS (SELECT 1 FROM workspaces w
              JOIN member m ON m."organizationId" = w.org_id
             WHERE w.id = notes.workspace_id AND w.kind = 'team'
               AND m."userId" = NULLIF(current_setting('app.user_id', true), '')
               AND (w.team_id IS NULL
                    OR EXISTS (SELECT 1 FROM "teamMember" tm
                                WHERE tm."teamId" = w.team_id
                                  AND tm."userId" = NULLIF(current_setting('app.user_id', true), ''))))
  OR EXISTS (SELECT 1 FROM shares s
              WHERE s.note_id = notes.id AND s.grantee_kind = 'user'
                AND s.grantee_user_id = NULLIF(current_setting('app.user_id', true), '')
                AND s.revoked_at IS NULL
                AND (s.expires_at IS NULL OR s.expires_at > now()))
);
--> statement-breakpoint
-- ---------------------------------------------------------------- 子表：可见性跟随 notes（子查询本身受 notes 策略约束）
ALTER TABLE note_updates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE note_updates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS note_updates_access ON note_updates;
--> statement-breakpoint
CREATE POLICY note_updates_access ON note_updates FOR ALL TO bianfa_app
  USING (EXISTS (SELECT 1 FROM notes n WHERE n.id = note_updates.note_id))
  WITH CHECK (EXISTS (SELECT 1 FROM notes n WHERE n.id = note_updates.note_id));
--> statement-breakpoint
ALTER TABLE note_snapshots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE note_snapshots FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS note_snapshots_access ON note_snapshots;
--> statement-breakpoint
CREATE POLICY note_snapshots_access ON note_snapshots FOR ALL TO bianfa_app
  USING (EXISTS (SELECT 1 FROM notes n WHERE n.id = note_snapshots.note_id))
  WITH CHECK (EXISTS (SELECT 1 FROM notes n WHERE n.id = note_snapshots.note_id));
--> statement-breakpoint
ALTER TABLE checklist_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE checklist_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS checklist_items_access ON checklist_items;
--> statement-breakpoint
CREATE POLICY checklist_items_access ON checklist_items FOR ALL TO bianfa_app
  USING (EXISTS (SELECT 1 FROM notes n WHERE n.id = checklist_items.note_id))
  WITH CHECK (EXISTS (SELECT 1 FROM notes n WHERE n.id = checklist_items.note_id));
--> statement-breakpoint
ALTER TABLE attachment_refs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE attachment_refs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS attachment_refs_access ON attachment_refs;
--> statement-breakpoint
CREATE POLICY attachment_refs_access ON attachment_refs FOR ALL TO bianfa_app
  USING (EXISTS (SELECT 1 FROM notes n WHERE n.id = attachment_refs.note_id))
  WITH CHECK (EXISTS (SELECT 1 FROM notes n WHERE n.id = attachment_refs.note_id));
--> statement-breakpoint
-- ---------------------------------------------------------------- attachments：按 workspace_id 走 workspaces 的 owner/member 判定
--（workspaces 自身的策略已做该判定，子查询受其约束）
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS attachments_access ON attachments;
--> statement-breakpoint
CREATE POLICY attachments_access ON attachments FOR ALL TO bianfa_app
  USING (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = attachments.workspace_id))
  WITH CHECK (EXISTS (SELECT 1 FROM workspaces w WHERE w.id = attachments.workspace_id));
--> statement-breakpoint
-- ---------------------------------------------------------------- shares：不能引用 notes（递归），按受让人 / 创建者判定
ALTER TABLE shares ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE shares FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS shares_access ON shares;
--> statement-breakpoint
CREATE POLICY shares_access ON shares FOR ALL TO bianfa_app
  USING (shares.grantee_user_id = NULLIF(current_setting('app.user_id', true), '')
         OR shares.created_by = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (shares.grantee_user_id = NULLIF(current_setting('app.user_id', true), '')
              OR shares.created_by = NULLIF(current_setting('app.user_id', true), ''));
--> statement-breakpoint
-- ---------------------------------------------------------------- note_pins：只看自己的钉放，且便笺必须对自己可见
ALTER TABLE note_pins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE note_pins FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS note_pins_access ON note_pins;
--> statement-breakpoint
CREATE POLICY note_pins_access ON note_pins FOR ALL TO bianfa_app
  USING (note_pins.user_id = NULLIF(current_setting('app.user_id', true), '')
         AND EXISTS (SELECT 1 FROM notes n WHERE n.id = note_pins.note_id))
  WITH CHECK (note_pins.user_id = NULLIF(current_setting('app.user_id', true), '')
              AND EXISTS (SELECT 1 FROM notes n WHERE n.id = note_pins.note_id));
--> statement-breakpoint
-- ---------------------------------------------------------------- 显式授权（幂等；覆盖 0001 建的全部表与 global_lsn）
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bianfa_app, bianfa_worker;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bianfa_app, bianfa_worker;
