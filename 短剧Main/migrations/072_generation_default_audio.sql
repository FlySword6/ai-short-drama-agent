-- 071：Lite 音频资产生成配置（2026-08-18 用户裁定 A）。
-- generation-defaults 合同从 image/video 扩到 audio：媒体类型 CHECK 加入 'audio'，
-- 模式 CHECK 加入 'text_to_speech'（音频 TTS = 文本+音色直接合成，无参考素材概念）。
-- 前向迁移：由 `npm run db:migrate` 显式执行；应用启动不应自动执行迁移。
-- 全部语句幂等，可安全重放（DROP/ADD CONSTRAINT IF NOT EXISTS 语义）。

ALTER TABLE {{schema}}.generation_default_strategies
  DROP CONSTRAINT IF EXISTS generation_default_strategies_media_kind_check;

ALTER TABLE {{schema}}.generation_default_strategies
  ADD CONSTRAINT generation_default_strategies_media_kind_check
  CHECK (media_kind IN ('image', 'video', 'audio'));

ALTER TABLE {{schema}}.generation_default_strategies
  DROP CONSTRAINT IF EXISTS generation_default_strategies_mode_check;

ALTER TABLE {{schema}}.generation_default_strategies
  ADD CONSTRAINT generation_default_strategies_mode_check
  CHECK (mode IN ('direct_reference', 'material_to_prompt', 'text_to_speech'));
