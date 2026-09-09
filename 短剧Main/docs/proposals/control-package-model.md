# 控制包生产模型（提案 · V0.1.2 → V0.2 主菜）

状态：已部分落地(2026-07-22):control_package 容器实体进 0.2.x(契约 control-package-and-lanes.md);**命名收口:control_package=参考准备容器(六参考栏),control_board=多格图像控制资产(本提案原义),两概念并存勿混**。其余(连续性契约并入结构化剧本 IR/分段编排)按路线图排期。原文:提案待 DC 拍板。输入源：Dario 2026-07-21 V1.0 生产逻辑陈述、
seedance2-all-reference-multishot-drama skill 实操流程（outputs/pi-skills-adapted/）、
LibTV 预设体系（W6-B 已在做前端）。落位后取代「一条分镜＝一张分镜图＝一个视频任务」旧模型。

## 一、核心论断

生产链是：**多模态导演意图 → 全能参考控制包 → 视频模型理解与执行**。
生图模型的产物不只是"漂亮图片"，而是机器可读的导演工作文件（九宫格、箭头、
色块、面板顺序都是控制信号）。"分镜"一词拆成三层，不再一一对应：

| 层 | 含义 | 数据承载（演进路径） |
| --- | --- | --- |
| 镜头设计 shot_design | 这段要发生什么：表演/动作/构图/运镜意图 | 现有 shots 表（script_text/director_prompt 续用，无破坏） |
| 控制板 control_board | 意图的视觉表达：故事板/动作板/角色板/镜头参考 | 新表 control_boards（多板可属一个镜头设计，一板可控多镜头） |
| 生成片段 generation_segment | 一次视频生成的产出与其多个候选 | 现有 generation_requests/media_results + 新增 segment 编排字段 |

## 二、控制资产类型化（seedance2 借鉴 1/2）

assets 与 control_boards 增加两个强制字段：

- `role`：character_identity / scene / prop / motion / camera_storyboard / style_env
  ——单一职责，上传/生成入库时强制选择，取代无约束"参考图"。
- `usage_mode`：reference / first_frame / last_frame
  ——生成管线按此校验，防止控制输入被误当起止帧（曾实撞：3D 素模误喂 i2v）。

## 三、连续性契约（seedance2 借鉴 4，V0.2 核心件）

每个生成批次前置一份结构化契约，**同时是生成输入和验收依据**（一次填写两处复用）：
画幅/时长/帧率/音轨、身份不变项（角色特征清单）、场景光线、道具状态、
分段交接状态（动作状态+道具位置+声音桥）。承载：新表 continuity_contracts，
生成请求引用 contract_id；验收清单从同一契约渲染。

## 四、分段编排与失败隔离（seedance2 借鉴 5/6）

长成片按固定时长强制分段（15 秒/段，1 分钟=四段），段间靠交接状态衔接而非
首尾帧硬接续。任务队列做分段幂等：先出一段验证 → 通过后批量 → 失败只重做
失败段，已通过段与契约冻结。付费红线不变：每段仍是估价→人工确认→提交。

## 五、两道验收门（seedance2 借鉴 7）

- 资产门：身份/道具/光线一致性（控制资产入包前）；
- 视频门：连续性/剪辑动机/音画层级/无水印畸变（片段入连播前）。
结构化检查项由连续性契约渲染，不做"看着还行"式笼统验收。

## 六、能力档位诚实标注（seedance2 借鉴 3）

真实生成视频 / 可执行资产包 / 静态图运镜降级，三档在产品内可见标签互不冒充
——与既有"不把 mock 当云端结果"纪律一致，做成 UI 标签而非口头约定。

## 七、排片对齐

版本号对齐 docs/goals/2026-07-22-version-roadmap-v012-v100.md（semver）：原「V0.1.2」=0.2.0，原「V0.2」=0.3.0，原「V1.0」=1.0.0。

- **V0.1.2（拍摄中）**：控制资产字段（role/usage_mode 两列迁移+上传选择 UI）、
  LibTV 预设+宫格切分（W6-B 在途）、生成引用按 usage_mode 校验。
- **V0.2（已定档）**：control_boards 表+工作台控制板层、连续性契约+两道验收门、
  分段编排+失败隔离、Pi 组包（对话式把控制材料组装为全能参考包——排片表
  「对话式拆分镜」的实体）。
- **V1.0（概念）**：动作参考视频/镜头参考视频入库、跨项目风格记忆接控制包。

## 八、数据演进草案（提案级，实施时由集成人落迁移号）

```sql
ALTER TABLE assets ADD COLUMN role varchar(32);        -- 六类控制职责
ALTER TABLE assets ADD COLUMN usage_mode varchar(16);  -- reference/first_frame/last_frame
CREATE TABLE control_boards (id, shot_id nullable, board_kind, media_result_id,
  panel_layout, annotations jsonb, ...);               -- 一板可控多镜头故 shot_id 可空
CREATE TABLE continuity_contracts (id, project_id, episode_id, spec jsonb, frozen_at, ...);
-- generation_requests 增 contract_id、segment_no、segment_group_id
```

风险与边界：V0.1.1 不动现有表行为（新增列可空）；分段幂等复用现有
client_idempotency_key 语义扩展；契约冻结与资产冻结引入"版本引用不可变"
约束，实施时与 Sol 数据真源统一方案对齐。
