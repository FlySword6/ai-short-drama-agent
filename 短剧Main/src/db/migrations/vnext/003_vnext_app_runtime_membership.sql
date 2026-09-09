-- 运行时隔离(issue #345 复审 P1):vNext 的真实运行连接使用独立登录身份，
-- 再显式 SET ROLE vnext_app。共享迁移/主应用登录身份不能永久成为
-- vnext_app/vnext_owner 成员；PG14 的角色成员资格会按登录角色原有 INHERIT
-- 语义自动生效，不能靠修改全局 rolinherit 来隔离一条连接。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vnext_owner') THEN
    CREATE ROLE vnext_owner NOLOGIN NOINHERIT;
  END IF;
  EXECUTE format('GRANT vnext_owner TO %I', current_user);
END
$$;

-- Assistant 的主会话仍属于主 schema；这里只保存 session -> vNext project
-- 的产品上下文，不对主 schema 建跨边界外键。运行时解析上下文与画布读写都经
-- vnext_app 连接，避免把 vNext project id 塞进旧 projects 外键。
CREATE TABLE IF NOT EXISTS vnext.agent_session_contexts (
  session_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES vnext.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vnext_agent_session_contexts_user_project_idx
  ON vnext.agent_session_contexts(user_id, project_id);

GRANT SELECT, INSERT, UPDATE ON vnext.agent_session_contexts TO vnext_app;

-- PostgreSQL 要求新表 owner 对所在 schema 有 CREATE；先给 NOLOGIN owner
-- 最小必要权限，随后 schema 本身也转给它。
GRANT CREATE ON SCHEMA vnext TO vnext_owner;

ALTER TABLE vnext.projects OWNER TO vnext_owner;
ALTER TABLE vnext.project_members OWNER TO vnext_owner;
ALTER TABLE vnext.graph_documents OWNER TO vnext_owner;
ALTER TABLE vnext.graph_revisions OWNER TO vnext_owner;
ALTER TABLE vnext.generation_telemetry_events OWNER TO vnext_owner;
ALTER TABLE vnext.agent_session_contexts OWNER TO vnext_owner;
ALTER FUNCTION vnext.prevent_graph_revision_mutation() OWNER TO vnext_owner;
ALTER SCHEMA vnext OWNER TO vnext_owner;

-- schema_migrations 故意仍由迁移登录身份持有，runner 可在 RESET ROLE 后记账；
-- 它只含版本/校验和，不是产品事实。主连接没有任何产品表权限。
DO $$
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA vnext TO %I', current_user);
END
$$;
GRANT SELECT, INSERT ON vnext.schema_migrations TO vnext_owner;
ALTER DEFAULT PRIVILEGES FOR ROLE vnext_owner IN SCHEMA vnext
  GRANT SELECT, INSERT, UPDATE ON TABLES TO vnext_app;

-- 003 只为转移对象所有权临时取得 owner 成员资格。迁移结束前撤销，确保共享
-- 登录身份无论原来是 INHERIT 还是 NOINHERIT，普通主连接都拿不到产品表权限。
DO $$
BEGIN
  EXECUTE format('REVOKE vnext_app FROM %I', current_user);
  EXECUTE format('REVOKE vnext_owner FROM %I', current_user);
END
$$;
