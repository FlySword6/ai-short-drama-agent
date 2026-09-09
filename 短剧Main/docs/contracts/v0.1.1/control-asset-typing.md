# 控制资产类型化合同（0.2.0 · E1/E2/E3 与 G1/G2 的共同真源）

状态：定稿（Fable 2026-07-22，吸收 DC 两次指正：全能参考多模态、首尾帧范式边缘化）。
上游：docs/proposals/control-package-model.md 第二节；本文件为实现级合同，冲突以本文为准。

## 1. 字段定义（migration 012，编号集成人落位）

```sql
ALTER TABLE assets ADD COLUMN role varchar(32);        -- 可空
ALTER TABLE assets ADD COLUMN usage_mode varchar(16);  -- 可空
```

### role 六枚举（上传/入库强制单选；存量可空待补录）

| 值 | 中文 | 主媒介期待 | 说明 |
| --- | --- | --- | --- |
| `character_identity` | 角色身份 | image | 面部/全身设定，身份不变项的来源 |
| `scene` | 场景 | image | 环境/置景参考 |
| `prop` | 道具 | image | 道具外观与状态 |
| `motion` | 动作参考 | **video 为主** | 表演/动作节奏参考 |
| `camera_storyboard` | 镜头故事板 | image/video | 分镜板、运镜参考（运镜以 video 为主） |
| `style_env` | 风格环境 | image | 色调/光线/材质风格 |

### usage_mode 三枚举（生成引用时生效）

| 值 | 地位 | 约束 |
| --- | --- | --- |
| `reference` | **主模式（一等公民）** | image、video 均可；全能参考集合驱动是现行范式 |
| `first_frame` | 锚帧（可选高级项） | 仅 image；特殊场景：指定从某分镜图起拍 |
| `last_frame` | 锚帧（可选高级项） | 仅 image；特殊场景：精确接续 |

## 2. 校验矩阵（生成提交层，Sol E2）

按「资产 media_kind × usage_mode」二维判定，违规一律 `422 control_asset_invalid_usage`，
message 用人话（示例见 §4）：

| media_kind \ usage_mode | reference | first_frame / last_frame |
| --- | --- | --- |
| image | ✅ | ✅ |
| video | ✅（动作/运镜参考） | ❌「视频不能作锚帧，请改为参考」 |
| model_3d（3D 素模） | ❌「3D 素模不能直接进生成，请先出图」 | ❌ 同左 |
| audio | ❌（声音桥是 0.3.0 契约字段，不进参考集） | ❌ |

- 向后兼容：`usage_mode IS NULL` 的存量资产按 `reference` 处理。
- 锚帧数量：first_frame / last_frame 各至多 1 个；参考集数量上限沿用现行 provider 限制。

## 3. API 形状

- 资产创建/更新（既有端点入参扩展，非破坏）：`role`（六枚举或缺省）、
  `usage_mode`（三枚举或缺省）。上传 UI 强制选 role；API 层不强制（CLI/批量导入放行）。
- 生成提交 references 结构（替代裸 id 数组，旧形状兼容期内继续接受并按 reference 解释）：

```json
{
  "references": [
    { "media_id": "…", "usage_mode": "reference" },
    { "media_id": "…", "usage_mode": "first_frame" }
  ]
}
```

- 响应错误码：`control_asset_invalid_usage`（422）、`control_asset_role_required`
  （422，仅 UI 声明强制的入口使用）。

## 4. 文案（Kimi G1/G2 直用）

- 视频作锚帧被拒：「视频不能固定首尾帧，把它放进参考集，模型会理解动作与运镜。」
- 3D 素模进生成被拒：「3D 素模不能直接生成视频，先在导演台出分镜图。」
- role 未选：「先告诉片场这件资产是什么：角色、场景、道具、动作、镜头板还是风格。」

## 5. UI 权重（G2 约束重申）

生成面板默认 UI = 参考集（按 role 分组的图片/视频混排），没有别的；锚帧折叠进
「高级」，展开才可见。不给遗留范式一等席位。

## 6. 测试要求

- E2：校验矩阵全格覆盖（路由测试）+ 存量 NULL 兼容 + 锚帧数量上限。
- E3：provider 透传检查——`reference_media_ids` 组包对 video 资产的路径检查入回执；
  1 积分级全能参考真冒烟（含 ≥1 视频参考）由 Fable 发起，红线照旧。
- G1/G2：role 强制选择的 UI 测试 + 面板分区源码级断言（模式照 asset-center.test.ts）。
