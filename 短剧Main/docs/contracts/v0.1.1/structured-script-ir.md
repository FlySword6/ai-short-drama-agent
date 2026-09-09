# 结构化剧本合同（IR · 0.3.0 正式版）

状态：定稿（Fable 2026-07-22）。代码真源：`frontend/shortdrama-rag-demo/src/ir-compiler.ts`
（类型与编译语义）+ `ir-compiler.test.ts`（黄金样本）。本合同定语义与不变量；字段级形状
以代码类型为准，两者冲突时**先改合同再改代码**，不许静默漂移。
上游依据：docs/validation/v0.1.1-w9-seedance25-workbench-audit-synthesis.md（四轮审计裁决）。

## 一、核心不变量（违反任一条即架构缺陷）

1. **结构化剧本（IR）是唯一真源；prose 是编译产物**。禁止手写/手改 prose 后存储；任何
   编辑必须落回 IR 再重编译。IR 没有"自由文本约束尾"字段——约束尾只能推导（见 §五）。
2. **创作层主键=稳定 asset_id**；`@图像N`/`@视频N` 由编译器按资产数组序分配（图片视频
   独立计数），只存在于产物、不回写 IR、不持久化。增删资产后重编译，引用自动前移。
3. **编译器是纯函数**：同 IR 必同输出；不发网络、不读环境；编译零副作用（IR 序列化
   前后全等）。
4. **每段 prose 可回源**：`ProvenanceEntry{segment, source[], text}`，segment 唯一、
   source 路径必须在 IR 上可解析、`prose === segments.join("\n")`。
5. **双语法平行**：GENERATE（生成）与 EDIT（锁定-增量）是两套骨架不是子集关系。
   EDIT 默认全锁：十维度（EDIT_DIMENSIONS 固定序）未声明即锁定；`base` 必须是已注册
   的 video 资产。

## 二、类型 schema（权威定义在代码,此处列合同要点）

- `PromptAsset`：id(主键)/media(image|video)/role(七类:character/scene/prop/composition/
  motion/pacing/endcard)/label(显示层)/alias(编译为 @别名)/description(可含 {{asset_id}}
  内联引用)/lock(三态:full|partial{inherit,override}|dimension)/scope(global|{shots[]})。
  注：编译器 role 七类是 prose 侧词表；资产库 role 六类（control-asset-typing.md）是
  库存侧词表——映射关系:character_identity→character、camera_storyboard→composition、
  style_env→pacing 或 scene 视用途,由组包层换算,两侧各自冻结不强行统一。
- `GenerateIR`：kind:"generate" + meta(title/beats[]/genre/duration_s/logline?) +
  assets[] + global{style 必填,camera?/physics?/audio?} + shots[] + brand?。
- `PromptShot`：id/start_s/end_s 必填；theme/camera{framing,angle}/position/action/
  script(经 parseShotScript 确定性拆分)/performance/refs[]/sfx/vo/speed_ramp/acceptance 可选。
- `EditIR`：kind:"edit" + intent + base + assets[] + style? + fields?(十维三态:
  lock|override{value}|add{value}) + additions[](四要素:trigger/spatial_anchor/time_sync/
  physics 必填) + subject?/camera_inheritance?/audio?/output_notes?。
- `SpecClaim`：string 或 {text, verified?}——verified 仅供 UI 两档标注（已验证可控/官方
  推荐未验证），编译产物不受影响。
- `CompileResult`：{prose, provenance[], slots[]}；`SlotBinding`：{asset_id, token,
  alias?, media, role}。

## 三、骨架段序（以代码为准；对审计草案的两处扩展已采纳）

GENERATE：header → global_style → asset:{id}×N → global_camera? → global_physics? →
global_audio? → timeline → shot:{id}×N → brand? → constraint_tail。

EDIT：**edit_intent（草案未列,采纳为首段）** → edit_style? → edit_lock（锁定枚举+唯一
新增白名单）→ addition:{name}×N → **edit_delta_fields（覆写声明独立段,草案未列,采纳）**
→ edit_subject? → edit_camera（缺省自动继承句）→ edit_audio? → edit_techspec（规格
继承句强制追加）。

## 四、后端映射约定（Sol W9-D 实现依据）

1. **提交形状**：前端提交 `{ir, prose, slots}` 三件套——IR 为真源存档（jsonb）、prose 为
   产物快照（发给模型的原文,审计用）、slots 为槽位映射（组包 reference 数组的依据）。
   后端本版**不复译**（编译器在前端）；校验=IR schema 校验+slots.asset_id 与库存资产
   存在性/媒介一致性+EDIT base 引用快照冻结。复译一致性校验留 0.3.x（编译器抽 shared 包后）。
2. **组包**：slots 按 media 分流——image 进图片参考、video 进 `reference_video` 通道
   （E3 已铺）；usage_mode 语义沿 control-asset-typing.md（reference 主模式,锚帧仅 image）。
3. **引用快照**：EDIT 提交时对 base 及全部引用资产落版本快照,快照后不可变（与数据真源
   方案"版本引用不可变"对齐）。

## 五、约束尾推导规则（禁手写,编译器唯一实现）

来源字段：meta.duration_s/genre/beats、assets（角色计数与身份句）、global.style
（exclusions 排除句）、global.audio（声音基底/排除句）。头部与约束尾的 beats 复述同源
必然同步。规则细目以 `compileConstraintTail` 为准。

## 六、验收锚

编译器改动必须保持:14 单测全绿+双黄金样本（醉汉天台 GENERATE/火车破银幕 EDIT）逐字
对拍+槽位稳定性测试（删中间资产零漂移）+provenance 无悬空路径断言。
