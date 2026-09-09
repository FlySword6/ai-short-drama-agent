-- 本地开发库初始化。挂载在 docker-entrypoint-initdb.d，仅数据卷首次创建时执行；
-- 已有卷不会重放（需要重放就跑 npm run dev:reset）。
--
-- pg_trgm 是迁移 017_hybrid_asset_search.sql 的硬前置：迁移器被刻意设计成无权
-- 自建扩展（生产要求 DBA 预装，保持发布账号最小权限），缺了它整条迁移链会在 017
-- 处 fail-closed 停住。dev 库在建卷这一刻由 initdb 超级用户装好，与生产"DBA 预装"
-- 的位置一一对应。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- vNext 本地开发也使用与生产相同的独立登录边界。这里只写一次性 dev 占位
-- 凭据；正式环境的独立连接串由部署密钥系统提供。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vnext_app') THEN
    CREATE ROLE vnext_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vnext_runtime') THEN
    CREATE ROLE vnext_runtime LOGIN NOINHERIT PASSWORD 'dev-only-vnext-password-not-a-secret';
  END IF;
  GRANT vnext_app TO vnext_runtime;
END
$$;
