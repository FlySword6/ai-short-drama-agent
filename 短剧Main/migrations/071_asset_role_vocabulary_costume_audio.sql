-- v8（docs/lite-oneclick-generate-episode.md v0.5，2026-08-18）：
-- 确认事务把资产候选物化扩到五类（角色/场景/道具/服装/音频）。
-- asset_entities.role 外键指向 asset_role_vocabulary，而 020 只种了三类
-- entity（character_identity/scene/prop）——costume/audio 落库即撞外键，
-- 确认事务整体回滚：一键生成本集的 auto-confirm 失败回落人工确认。
-- 补齐两个 entity 域 id，与 assetKind 同名（repository.materializeAssetCandidates
-- 的 role 口径：character→character_identity，其余 role=assetKind）。
-- 全部语句幂等，可安全重放（ON CONFLICT DO NOTHING）。

INSERT INTO {{schema}}.asset_role_vocabulary (id, display_name, domain, pick_kind, sort) VALUES
  ('costume', '服装', 'entity', NULL, 4),
  ('audio', '音频', 'entity', NULL, 5)
ON CONFLICT (id) DO NOTHING;
