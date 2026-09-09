# AI 短剧平台本体论与数据架构骨架

- 起草:Fable,2026-07-27(S55 的架构输入;sol 细化,林夕/董言直接使用)
- 依据:R43(DC 拍板:本体论要可扩展,2.5 生产模式前瞻)、DC 本体建模方法论图(数据流驱动的反馈回路)、八类 ontology 台账、S41 标签体系(别名与规范词同表)、R24 信息分离、creative-vocabulary-openness(创作词表不冻结)、bytehouse-governance.md、ByteHouse Skills 手册(feishu-captures/bytehouse-skills-guide-20260727.md)

## 一、四条设计原则

1. **数据流驱动的回路型本体**(DC 方法论图):本体不是静态字典,是被生产事件流持续更新、参与计算(检索/推理/约束生成)、被反馈修正的活结构。每类本体对象都要回答:谁的数据流喂它?它约束哪个计算?反馈从哪回来?
2. **枚举只冻不变量,词表全开放**:钱、权、产物状态机、审计、AIGC 标识义务=冻结层,改它走迁移+合同;一切创作语汇(资产职责/风格/拍法/情绪/运镜/标签)=词表层,加值=插行,永不改 schema。
3. **2.5 前瞻位**:为 50+ 多模态参考、定时场景与动作控制、多语言语音与唇形同步、30-180s 连续叙事、受控视频编辑预留结构位——**上限进配置,形态进对象,能力进档位**;2.5 发布日应只需要「加档位+开配置」,不需要动表。
4. **Agent-first**(R28):每个本体对象的读写都有 API 面;血缘与注释规范让官方 data-asset-analyzer / quality-inspector skill 直接可用,人机同源。

## 二、本体分层

| 层 | 内容 | 变更纪律 |
| --- | --- | --- |
| **L0 不变量** | 积分账本与 quote 状态机;账号/团队/角色/权限点;产物四态;审计留痕;AIGC 标识(evidence 机制/仅一份标识/编码规则) | 冻结:迁移+合同+Fable 裁决 |
| **L1 实体** | 项目/集/分镜(粗剪素材)/资产(**角色×造型二级**,素体与剥离维度见 R24)/产物(图/视频/音频)/生成任务/账户/邀请码 | 稳定可加:新实体走迁移评审 |
| **L2 词表** | 资产职责(八类起步)/风格/拍法/情绪/运镜/色卡/光影/摄影方案/标签(别名与规范词同表、规范词自指) | 全开放:插行即扩展,管理端可视化维护(R41 低代码同理) |
| **L3 关系与时态** | project_reference(引用=可用范围声明)/参考控制包(工作台就绪=生效绑定)/血缘链(资产→参考包→任务→产物→交付)/使用统计/信任窗口(expires_at,R26)/时间轴对象 | 关系表可加;时态字段(生效/过期/版本)是一等公民 |

**两层引用语义铁律不变**:项目引用管"能用什么",参考控制包管"这一镜用了什么"——L3 里是两张表,不合并。

## 三、2.5 前瞻位的五个设计决定

1. **参考槽位对象化**:`reference_sets`(参考控制包)+ `reference_items`(条目:media/asset 指针 + role + 序号 + 权重/备注)。**role 是词表**(first_frame/last_frame/reference_image/reference_video/reference_audio 起步);**数量上限是能力档位的配置字段**,不写死在 schema 或代码常量(今天 9/3/3,2.5 时改配置到 50+)。提示词「素材类型+序号」的序号=按 role 分组内的 item 顺序,由服务端编译时生成并与 content 数组绑定(序号绑定包的契约就定在这里)。
2. **时间轴对象化**:`timelines` + `timeline_segments`(起止时刻/段落文本/运镜指令/动作指令/场景锚点/对白与音效意图)。单镜提示词从 timeline 编译;**30-180s 连续叙事=跨镜 timeline 串联**(段落引用上一镜尾帧/return_last_frame 衔接)。定时场景与动作控制=segment 的结构化字段,不是提示词里的裸文本。
3. **声音是角色的维度**:角色资产挂 voice 绑定(voice_type/音色引用/多语言轨),唇形同步的输入=角色 voice + 台词轨;不做孤立"配音产物"本体。
4. **受控编辑对象化**:`edit_operations`(目标产物/选区描述/指令/参考条目/产出新版本),版本树上留痕——EDIT 十维与图片局部编辑共用此对象。
5. **模型能力经档位间接引用**:任何任务只引用 capability tier(档位),档位映射模型 ID+规格+价;2.5 上线=加档,任务与数据结构零改动。

## 四、OLTP / OLAP 分工(ByteHouse 域)

- **OLTP(RDS PostgreSQL,app schema)= 状态与交易真源**:上表(L0-L3)全部在此。
- **OLAP(ByteHouse,同一租户内的 dev/test/prod environment)= 分析与检索加速**。environment
  是隔离边界，数据库名不带环境后缀；S55 四域最终库归属待 Fable 按
  `docs/design/bytehouse-s55-domain-database-proposal-20260727.md` 裁定。林夕现用的
  dev `shortdrama_entity` 保留为资产实体域库，不自动承接四域表。四个域为：
  1. `events_*`:行为与生产事件流(迁移 011 events 为源,批/CDC 同步);
  2. `cost_*`:ai_call 与积分账本镜像(成本归因:任务→用户/项目/模型;R31 积分体系的分析面);
  3. `radar_*`:选题雷达快照(迁移 018 系);
  4. `asset_vec_*`:资产多模态向量域——**形态对齐火山 data_bp_imagerag 存量**(TOS 路径+角色-阶段粒度+向量列),embedding 统一 `doubao-embedding-vision-251215`(与官方 skills 默认一致,检索走 hybrid-search/multimodal-search skill 或 MCP)。
- 同步方向永远 OLTP→OLAP,ByteHouse 不回写业务库;分析结论回流走应用层(回路里的"反馈与学习"这条边)。

## 五、血缘与数据规范(林夕/董言直接用)

1. **命名**:承接 bytehouse-governance §2;表/列注释**必填中文**,注释即文档。
2. **每表登记四元组**:owner / 上游(源表或事件)/ 更新方式(批/CDC/手工)/ 保留策略(TTL/分区)。登记表在 `docs/contracts/bytehouse-table-registry.md`(S55 产出),data-asset-analyzer skill 依赖注释与登记做血缘图。
3. **质量口径**:每表显式声明主键/排序键;quality-inspector skill 的空值/重复检测作为例行体检项。
4. **权限**:建表统一由我们做(S55)。每 environment 的 `app` / `readonly` 账号、最小
   grant 与 KMS 存放位置必须以实际回读为准；在此之前不把旧账号名或全库权限写成既成事实。
   **不许出现“方便调试”的宽权限账号**，产品 Agent 仍经应用 API 二次鉴权。

## 六、S55 执行边界(sol 细化清单)

1. 四域全部表的 DDL(含注释/主键/排序键/分区与 TTL)+ 字段字典;
2. `bytehouse-table-registry.md` 血缘登记表(模板+首批登记);
3. 三 environment 初始化执行：当前 provision 的 `--apply` / `--verify` 均 hard-stop；
   仅在 Fable 批准域库 manifest、sol 完成 KMS/应用账号交接、endpoint allowlist 通过且
   Fable 明确批准当次动作后，才实现新的受控 apply 与逐 environment strict 回读；
4. 与林夕/董言的对接文档(连接方式/账号/可用 skills 清单/建表申请流程=提需求给我们,不自建);
5. 不做:业务库(OLTP)任何改动;向量数据灌入(归 S52 后续与检索迁移线);Milvus 相关(归 S54)。
