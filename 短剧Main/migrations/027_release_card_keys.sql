-- 版本计划两份真源合一(S31):release_section 卡片补稳定对齐键 card_key。
-- 真源依据:任务包 kimi-goal-s31-plan-truth-sync-20260726(2026-07-26 巡检
-- 抓到文档与库分叉:拿标题当主键导致机械比对失效)。对齐规则:card_key
-- 缺省回填为卡片 id——022/024 播种的 id 本来就是 slug,与
-- docs/design/version-plan.md 的 <!-- card:... --> 锚点一一对应。
-- acceptance(验收标准)本迁移不填:字段可空,由 Fable 后续逐张填,
-- 机制见 src/modules/config-entries/types.ts 的 releaseCardPayloadSchema。
--
-- 前向迁移:由 `npm run db:migrate` 显式执行;应用启动不自动执行迁移。
-- 幂等:WHERE 守卫只在仍有卡片缺 card_key 时动手,重放命中 0 行 no-op;
-- 已有 card_key 的卡片(运营在管理界面写过,或 sync 工具追加过)逐卡保留,
-- 不覆盖。卡片顺序按 ordinality 原样保留。
--
-- 回滚口径:card_key/acceptance 在 zod 校验里均为 optional,旧代码读写
-- 不受影响,字段可保留;确需回滚由 DBA 手工重建 cards 数组摘除 card_key。

UPDATE {{schema}}.config_entries AS entry
SET payload = jsonb_set(
  entry.payload,
  '{cards}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN card.value ? 'card_key' THEN card.value
        ELSE card.value || jsonb_build_object('card_key', card.value ->> 'id')
      END
      ORDER BY card.ordinality
    )
    FROM jsonb_array_elements(entry.payload -> 'cards') WITH ORDINALITY AS card(value, ordinality)
  ),
  false
)
WHERE entry.kind = 'release_section'
  AND jsonb_typeof(entry.payload -> 'cards') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(entry.payload -> 'cards') AS missing(value)
    WHERE NOT (missing.value ? 'card_key')
  );
