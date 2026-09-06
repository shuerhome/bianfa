-- 0003：audit_log（规格 04 §4.2 R10）、member.status/removed_at（04 §4.2）、effective_note_permission()（04 §5.2）、
--       authz_revoked NOTIFY 辅助函数（04 §5.4 / 08 X4）。主代理手写；后续迁移由各实现代理追加（0004 auth、0005 domain、0006 sync）。
CREATE TABLE IF NOT EXISTS audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  org_id text,
  actor_type text NOT NULL DEFAULT 'user',
  actor_id text,
  actor_ip inet,
  actor_device_id uuid,
  actor_ua text,
  action text NOT NULL,
  target_type text,
  target_id text,
  outcome text NOT NULL DEFAULT 'success',
  before jsonb,
  after jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  CONSTRAINT audit_log_actor_type_check CHECK (actor_type IN ('user','system')),
  CONSTRAINT audit_log_outcome_check CHECK (outcome IN ('success','denied','error'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_at_brin ON audit_log USING brin (at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_org_at_idx ON audit_log (org_id, at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_actor_at_idx ON audit_log (actor_id, at DESC);
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_log TO bianfa_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_log FROM bianfa_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_log TO bianfa_worker;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO bianfa_app, bianfa_worker;
--> statement-breakpoint
ALTER TABLE member ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE member ADD COLUMN IF NOT EXISTS removed_at timestamptz;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_status_check') THEN
    ALTER TABLE member ADD CONSTRAINT member_status_check CHECK (status IN ('active','suspended','removed'));
  END IF;
END $$;
--> statement-breakpoint
-- 便笺有效权限（04 §5.2 判定表；R18 补 org owner/admin 分支）。返回 NULL = 不可见（404）。
-- 只依赖表数据，SECURITY INVOKER；调用方为 bianfa_app 时受 RLS 约束，为 bianfa_worker / 超级用户时直接算。
CREATE OR REPLACE FUNCTION effective_note_permission(p_user text, p_note uuid)
RETURNS note_perm
LANGUAGE sql STABLE
AS $$
  WITH n AS (
    SELECT notes.id, notes.workspace_id, notes.created_by, w.kind, w.org_id, w.team_id, w.owner_user_id, w.default_note_perm
    FROM notes JOIN workspaces w ON w.id = notes.workspace_id
    WHERE notes.id = p_note
  ),
  cand AS (
    SELECT 'manager'::note_perm AS perm FROM n WHERE n.created_by = p_user OR n.owner_user_id = p_user
    UNION ALL
    SELECT n.default_note_perm FROM n
      JOIN member m ON m."organizationId" = n.org_id AND m."userId" = p_user AND m.status = 'active'
      WHERE n.kind = 'team'
        AND (n.team_id IS NULL OR EXISTS (SELECT 1 FROM "teamMember" tm WHERE tm."teamId" = n.team_id AND tm."userId" = p_user))
    UNION ALL
    SELECT 'manager'::note_perm FROM n
      JOIN member m ON m."organizationId" = n.org_id AND m."userId" = p_user AND m.status = 'active'
      WHERE n.kind = 'team' AND m.role IN ('owner','admin')
    UNION ALL
    SELECT s.perm FROM n JOIN shares s ON s.note_id = n.id
      WHERE s.grantee_kind = 'user' AND s.grantee_user_id = p_user
        AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
  )
  SELECT perm FROM cand ORDER BY perm DESC LIMIT 1;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION effective_note_permission(text, uuid) TO bianfa_app, bianfa_worker;
--> statement-breakpoint
-- 写事务末尾调用：SELECT notify_authz_revoked(user_id, scope, id)；payload {user_id, scope, id}
CREATE OR REPLACE FUNCTION notify_authz_revoked(p_user text, p_scope text, p_id text)
RETURNS void
LANGUAGE sql VOLATILE
AS $$
  SELECT pg_notify('authz_revoked', json_build_object('user_id', p_user, 'scope', p_scope, 'id', p_id)::text);
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION notify_authz_revoked(text, text, text) TO bianfa_app, bianfa_worker;
