# 控制包与参考栏契约(0.2.x · Sol 实现 / Kimi mock 依据)

状态:定稿(Fable 2026-07-22,依据 DC 三项拍板)。命名收口:**控制包(control_package)**
=一个粗剪素材的参考准备容器,内含六条**参考栏**(代码字段名 lane);「控制板
(control_board)」保留提案原义=多格图像类控制资产(故事板/动作板),是参考栏里挂的
**东西**,不是容器——两个概念勿混。

**修订 v2,2026-07-24(Fable,依据 DC 范式拍板,替代同日早前的"六扩七"方案)**:
lane 不再是 schema 枚举,改为**开放词表**——`reference_lane_vocabulary` 表
(id/display_name/domain[实体·风格·媒介]/sort/active)播种七条(character/
scene/prop/lighting/camera_motion/reference_video/audio),`control_package_refs.lane`
改 FK 指向词表;**新参考栏(色卡/深度图/姿势/构图/节奏…)=一行 INSERT,
零迁移零合同修订**。判据与全库分类见 docs/design/creative-vocabulary-openness.md
(约束保护钱/权/数据完整性;词表承载创作探索)。下文 013 原文保留作历史;
lighting 承载 role=style_env 的裁决不变(条 8/条 9 根因)。迁移排后端专线,
存量 refs 为零无搬迁。

## 一、实体(migration 013,编号集成人落位)

```sql
CREATE TABLE {{schema}}.control_packages (
  id uuid PRIMARY KEY,
  shot_id uuid NOT NULL REFERENCES {{schema}}.shots(id),   -- 粗剪素材(现 shots 层),一对一
  ready_marked_by uuid REFERENCES {{schema}}.users(id),    -- 人工就绪:谁标的
  ready_marked_at timestamptz,                             -- 何时标的;NULL=未标记(可撤销=置 NULL)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE {{schema}}.control_package_refs (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES {{schema}}.control_packages(id) ON DELETE CASCADE,
  lane varchar(24) NOT NULL,          -- character/scene/prop/camera_motion/reference_video/audio
  asset_media_id uuid REFERENCES {{schema}}.asset_media(id),
  media_result_id uuid REFERENCES {{schema}}.media_results(id),
  note varchar(512),                  -- 该参考物在此包内的用途备注(可空)
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (lane IN ('character','scene','prop','camera_motion','reference_video','audio')),
  CHECK ((asset_media_id IS NULL) <> (media_result_id IS NULL))  -- 二选一:库存资产或生成产物
);
```

- 六 lane 枚举与 context 仓 spec-set-package-reference-lanes-v1 对齐;中文名:角色/场景/
  道具/运镜/参考视频/音频。
- **推荐要素**不落库:预置文本按 lane 由前端常量承载(与 role 词表同源),0.3.x 若要
  项目级定制再表化——先不建表。
- 就绪是**人工标记非机器门禁**:没有任何字段约束"栏目满了才能标就绪"。

## 二、API(路径冻结,响应走统一 success 包)

- `GET  /api/v1/shots/:shot_id/control-package` —— 取(不存在则返回空包结构,不 404);
- `PUT  /api/v1/shots/:shot_id/control-package/ready` —— body `{ready: true|false}`,
  标记/撤销就绪,记 who/when(取当前用户);
- `POST /api/v1/shots/:shot_id/control-package/refs` —— body `{lane, asset_media_id?
  | media_result_id?, note?}`,挂参考物;重复挂同一对象幂等返回既有;
- `DELETE /api/v1/control-package-refs/:ref_id` —— 摘除;
- 响应形状(snake_case):包 `{id, shot_id, ready:{marked_by, marked_by_name, marked_at}
  | null, lanes: {character: [ref...], scene: [...], ...}}`;ref
  `{id, lane, kind:"asset"|"generated", media_id, thumbnail_url, storage_url, note, sort_order}`。

### 生产引用审核门禁

- `asset_media_id` 指向通用资产时，只有当前 `asset_entities.status='approved'` 可以写入
  `control_package_refs`；`automatic_review`、`pending_review`、`rejected` 及未知状态一律
  失败关闭，返回 `422 unprocessable_entity`。
- 422 的 `error.message` 必须点名资产并给出中文当前状态，供调用端直接展示；拒绝事务不得
  留下控制包引用。个人资产不走通用资产审核，仍按所有者或项目精确引用权限校验。
- 普通成员只有在项目已有该精确 media/variant 引用时才获得未过审通用资产的点名 422；
  仅凭 UUID 探测未公开待审资产仍返回 404 且不附带资产详情，平台管理员不受此隐藏规则限制。
- 审核事实必须在写控制包引用的同一 PostgreSQL 事务内加共享行锁，避免审核状态在检查与
  INSERT 之间变化。控制包中的既有引用不是永久授权；进入生成报价、建单、重试和 Worker
  付费提交前仍须按当前资产状态复核。

## 三、两条任务创建流程

1. **生成单个粗剪素材**(控制通道):现有生成提交端点扩展——请求带
   `control_package_id`(可空;快速通道不带,**永久合法**),带包时后端把包内 refs 按
   媒介与 usage_mode 组入参考(槽位映射按 structured-script-ir.md §四);
2. **一键生成本集**:`POST /api/v1/episodes/:episode_id/generate-ready` ——
   对该集所有 `ready_marked_at IS NOT NULL` 的粗剪素材**依序**走批量估价→**一次人工
   确认**(batch-estimate 既有语义)→逐项创建任务;逐项失败如实报数
   (`{succeeded: n, failed: m, failures: [{shot_id, reason}]}`),不半成功当全成功。
3. 两条流程的红线不变:估价→费用清单→人工一次确认→创建。

## 四、@ 艾特序列化(结构化剧本合同 §四的应用面)

文字描述中的 @ 引用**序列化为 `{{asset_id}}` 内联占位**(编译器既有语法,见
ir-compiler 合同):前端 @ 选择器插入的是稳定 asset_id 占位,显示层渲染为 @资产名 chip;
`@图像N/@视频N` 只出现在编译产物,**绝不进 IR、不进文字描述存储**。参考包组包时
slots 由编译器分配——前端不手拼 @N。

## 五、Kimi mock 约定

后端就位前按本契约形状 mock(空包结构/挂摘/就绪标记/两条流程的响应);字段名以本文为准,
不自造。Sol 实现做好后替换 fetch 层即可。
