# 结构化参考快照合同 v2(2026-07-23 冻结,可执行)

回应 generation contract gaps #3。现状快照 `{kind, url, role?}` 太薄:没有资产
身份、没有用法、retry 无法校验来源未变。本合同冻结新形状;**存量兼容:旧字段
保留可读,新写走 v2,不回填历史**。

## 快照条目形状(generation_requests.reference_snapshot jsonb 数组元素)

```jsonc
{
  "schema": 2,
  "media": { "type": "asset_media" | "media_result", "id": "<uuid>" },  // 二选一带类型,凝固身份
  "lane": "character|scene|prop|camera_motion|reference_video|audio",   // 控制包六道,来源可溯
  "usage_mode": "reference" | "first_frame" | "last_frame" | "edit_base",
  "scope": "image" | "video",            // 提交到哪条生成通道
  "url": "<解析时刻的 TOS 直链>",         // 提交即凝固,此后资产变动不影响本请求
  "content_hash": "<sha256,可得则填>"     // retry 校验用;拿不到留 null 并在回执说明
}
```

- `media.id + usage_mode + scope` 三元组在同一请求内唯一;
- 快照在 quote confirm 时刻生成并写入,**此后不可变**;
- 与控制包的关系:从控制包发起的生成,快照由控制包 refs 解析而来(lane 保留);
  快速通道(无控制包)生成的引用,lane 按资产类型推断或留 `reference_video`/对应道。

## retry 校验

- retry 复用原快照(不重新解析资产);content_hash 非空时,提交前重新拉取源做
  hash 比对,不一致 → 拒绝 retry 并提示"参考物已变更,请重新发起"(不静默换源);
- hash 为空的存量/降级条目:retry 仅按原 url 提交,行为与现状一致。

## Provider 组包(arkGenerationProvider)

- `usage_mode=reference` → Ark 全能参考主模式(图片与视频参考都在此,视频参考
  需 supports_input_video 能力位);
- `first_frame` / `last_frame` → 锚帧参数(降级模式,保留但不推荐);
- `edit_base` → EDIT 链的基底(见 EDIT 合同),普通生成中出现即 422;
- 校验规则扩展现有 reference/first_frame/last_frame+3D 禁止规则,不重写。
