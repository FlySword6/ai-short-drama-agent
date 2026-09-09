# 设计原则:创作词表开放性(2026-07-24,DC 拍板范式)

DC 原话要义:AI 短剧生产是探索中的新方向,不是自然科学标准范式;我们做的
是**参考控制包**,色卡/深度图这类新参考物会不断出现,不能拿程序枚举那套
冻结创作词汇,把路走窄。

## 判据:什么该硬,什么该软

| 层 | 判据 | 处置 |
| --- | --- | --- |
| **系统不变量** | 状态机、钱、权限、协议——错了会丢钱/越权/坏数据 | 硬枚举(CHECK 保留):报价 previewed→confirmed→rejected、任务 status/phase、审核状态机、persistence_status、actual_cost_status、visibility、chat role、active/archived |
| **创作词汇** | 描述"参考物是什么/给谁用"——每周都可能冒新的 | **开放词表**(registry 表播种+可增,拆 CHECK):参考栏 lane、资产 role;genre 已是动态聚合(S14,正确先例) |
| **模型能力相关** | usage_mode、参考注入 mode、参数、时长/分辨率 | **能力档承载**(参数即数据,已是正确先例):新用法=登记新档,不改 schema |
| **介质** | media_kind(image/video/audio…)——深植计费/worker/能力档分流,低频结构性 | 受控扩展(保留 CHECK,但**本次迁移一并加 'audio'**——声音工坊一期马上撞线,7 处 CHECK 一次清) |
| **关系与约束**(2026-07-26 补) | 谁能指向谁(角色-场景-服装-集-镜-控制包)、jsonb 字段的结构契约——错了会产生无法解释的图和无法校验的数据 | **受控 + 可自动校验**:关系类型进 relation_vocabulary 并声明 Domain/Range;jsonb 在写入层强制校验(zod),不只在 TS 类型上声明。**注意与"分类"分开**:关系本身是硬的,被关联对象叫什么名字是软的 |

一句话:**约束保护钱、权、数据完整性;词表承载创作探索。**

## 全库冻结点分类(2026-07-24 实扫 migrations/)

误冻结、需开放:
- `013 control_package_refs.lane` 六枚举——改 `reference_lane_vocabulary`
  词表表(id/display_name/domain[实体·风格·媒介]/sort/active),播种七条
  (character/scene/prop/lighting/camera_motion/reference_video/audio 栏),
  refs.lane 改 FK;**新参考栏=一行 INSERT,零迁移零合同修订**(色卡、
  深度图、姿势、构图、节奏……随到随加);
- `012 shot_media.role` 六枚举——同理 `asset_role_vocabulary` 词表;
- `usage_mode (reference/first_frame/last_frame)`——保留三态 CHECK 但注明:
  新注入方式(深度图控制、色卡约束)**先落能力档的档位参数**,确需新
  usage_mode 时按受控扩展走(它映射模型 API 形状,不是纯创作词汇)。

保持硬(不变量,别动):
001 报价/任务/产物状态机、007 审核状态机、006 审计状态、visibility、
chat role、项目/资产生命周期、008/005 的 mode(能力档辖区)。

受控扩展(本次顺手做):
media_kind 7 处 CHECK 加 'audio'(001×3/005/007/008×2),为声音工坊
一期铺路;计费/能力档/worker 的 audio 适配随声音工坊包走,schema 先行。

## 裁决记录(S15 审计遗留 5 条,Fable 2026-07-24)

1. **LANE_PICK_KIND→进词表**:选择器 kind 过滤是词条的**功能语义**,进
   词表字段 `pick_kind`(后端词表迁移带上这列;前端 S17 改读词条字段)。
   **LANE_FLASH_CLASS→留界面默认**:高亮是纯装饰,新词条无高亮的降级
   可接受,不进词表(避免词表膨胀成样式表)。
2. **媒介页签→登记制成立**:新媒介=新管线+新合同+新计费,是受控扩展
   不是词表;但硬编码要收敛为单一 `MEDIA_REGISTRY` 登记文件(集中声明
   页签/图标/生成入口)。实现挂在声音工坊前端包(audio 上新正好首用)。
3. **PROJECT_GENRES→词表播种项,不算违例**:genre 数据侧已开放(动态
   聚合+自定义记忆),六个常用项定性为播种建议;后端词表迁移顺手建
   `genre_suggestions`(或复用统一 vocabulary 机制),前端换源即可。
4. **EDIT_DIMENSIONS 十维→创作词汇定性成立,0.3.0 处理**:维度词表化+
   IR 版本号承载兼容(它在编译器协议面,不能裸改);排 0.3.0 链 rebase
   之后的 IR 包,现在不动。
5. **usage_mode→维持既有裁决**(本文第二节):三态 CHECK 保留,新注入
   方式先落能力档,确需新 usage_mode 走受控扩展。

## 实施切分

- **后端专线·词表迁移包**(替代原"六扩七"微包):上述两张词表表+
  refs/shot_media 改 FK+media_kind 加 audio,一个迁移完成;存量 refs
  为零、shot_media.role 存量值全在播种词表内,无数据搬迁;schema.ts/
  类型同步;词表 CRUD 接口(管理员增词条,普通读)留最小实现。
- **前端排查包**(Kimi):全栈"走窄点"排查——前端 hardcode 的分类/
  分组/词表逐个找出来,对照本文分类表标注[应词表驱动/应能力档驱动/
  确是不变量],出清单;参考栏分组/icon/文案改词表元数据驱动。
- **0.3.0 IR 层**(排查包一并看):EDIT_DIMENSIONS 十维、槽位类型等
  编译器冻结面,按同一判据复审,结论进排查报告,改动排 0.3.0 包。
- 合同层:control-package-and-lanes.md 修订 v2(词表化,撤回今日早些
  时候的"六扩七"枚举方案);本文进 platform-ontology.md 引用(约束
  通则新增一条:R9 创作词表不冻结)。
