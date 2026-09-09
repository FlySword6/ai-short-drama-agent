# EDIT 提交与存储合同(2026-07-23 冻结,可执行)

回应 generation contract gaps #4。原则:**EDIT 是一种生成任务,不是新流程**——
复用 estimate → quote confirm → submit 与全部付费红线,不另建旁路端点。

## 请求形状(扩展现有生成请求,不新增端点)

生成请求增加可选 `edit_spec`;带 `edit_spec` 的请求即 EDIT 任务:

```jsonc
{
  // …既有生成请求字段(model/tier_id/prompt 等)…
  "edit_spec": {
    "base_media_result_id": "<uuid>",       // 基底版本,必须是本 shot 的已确认产物
    "locked_dimensions": ["duration", "…"],  // 锁定维度,默认=十维全锁
    "changes": [                             // 唯一新增白名单:只有出现在这里的维度允许变化
      { "dimension": "lighting", "instruction": "整体压暗为夜戏,保留人物轮廓光" }
    ]
  }
}
```

- **十维枚举(真源=前端 ir-compiler.ts 的 EDIT_DIMENSIONS,双端共享镜像纪律)**:
  `duration | composition | camera_motion | subject_trajectory | scene | lighting |
  grading | aspect | audio | imperfections`;
- 校验:locked ∪ changes 覆盖十维、二者交集为空、changes 至少 1 条(0 条=纯复述,422);
  base_media_result 必须存在、属于本 shot、非 mock;
- 基底不可变:confirm 时刻把 base 凝固为参考快照 v2 条目(usage_mode=edit_base,
  含 url+content_hash),retry 按快照合同校验。

## 存储(migration 014,Fable 落编号)

`generation_requests` 加两列,不建新表:

```sql
ALTER TABLE generation_requests
  ADD COLUMN edit_spec jsonb,                    -- 上述 edit_spec 全量(含编译产物,见下)
  ADD COLUMN base_media_result_id uuid REFERENCES media_results(id);
```

- `edit_spec.compiled` 子字段存编译产物(提交 Provider 的最终 prose/参数),
  与用户声明同存——结构化声明是真源,prose 是产物,复跑可审计;
- 索引:`base_media_result_id` 建普通索引(查"某版本被编辑过几次");
- 旧行 edit_spec 为 NULL=普通生成,语义不变。

## 计价与红线

- EDIT 按所选能力档计价(与普通生成同档同价,无特殊价);
- 估价→人工确认→提交,一次点击一个任务,禁止跳过确认——逐字不变。
