# DC 判决真源:生成界面域 V-01…V-32

状态:2026-07-27 首版,Fable 写。**这是判决台账,不是设计说明。**
判据(什么样的东西一看见就该打回)在 `docs/design/aesthetic-judgment.md`,
本文只回答一件事:**DC 到底说过什么、现在做到没有、谁在替我们盯着它别回退。**

## 为什么有这份文件

2026-07-27 DC 看 5173「生成图片」确认弹窗后发火:「这个生成界面我说过好多次了,一直没改」。
考古挖出 **32 条**历史意见:已修 9、部分修 4、从未修 16、**修过又丢(回归)3**。

最狠的一条不是没做,是**做过又被自己拆掉**:DC 07-22 说「生成图和视频的参数没法改」,
D3/W6 把参数做成可改的(`a2a3ae8`),S5 又以「去假可调」为由把参数控件全部下线(`ae93475`)——
没人发现原始诉求被反转,三个月后 DC 自己看见了。

**问题不在于没记录,记录多到 32 条都能挖出来;问题在于记录不在执行者的路径上。**
判决躺在项目工作区的考古文档里,写代码的人不会读。所以有了这份文件 + 会失败的测试。

## 维护规矩(硬规则,三条)

1. **收到 DC 关于界面的任何意见:登记收件箱(`docs/planning/orchestration.md` R 表)的同时,
   追加本文件一行。** 先写这一行,再写代码。两处都记,少一处都算没收到。
2. **每个前端包的回执(`docs/validation/*.md`)必须带一节「DC 判决对账」**,
   逐条列出本包碰过的文件所关联的 V 编号,每条三选一:**保持 / 改进 / 暂不动(+理由)**。
   Fable 验收先看这一节,缺了直接退回,不看截图。模板见文末。
3. **能机器判的判决必须进 `test/dc-verdicts.test.ts`**(仓库门禁同一套 `node:test`)。
   判不了的写「人工」,不许留空——留空等于没人盯。
   既有欠账用 `todo` 标注:**红的断言保留、原因写清楚**,门禁不被历史欠账挡住,但欠账在每次
   `npm test` 输出里都看得见。

4. **判决守卫的「期望值语义」只由 Fable 改**(2026-07-30 立,起因 K2V)。
   主线**可以**新增断言、**可以**把因新指示而失效的断言标 `todo` 并写明理由与新期望提案;
   **不可以**自行改写既有断言的语义去适配自己的新实现——**改实现的人同时改守卫期望,守卫就不再是独立检查**
   (S83 教训:守卫曾把假话断言成期望值)。语义改写随 Fable 的对账 commit 落进主干。
   K2V 属立规前的新情况,带 DC 依据、如实申报、变异 2 红复绿,**不追责**,那 41 行由 Fable 合流时逐条重对账。

配套约定:

- **状态会变,原话不变。** 判决行只增不改;状态列和守卫列由每个包在合流时更新。
- **V 编号一经分配不回收**,即使判决被 DC 本人推翻——改状态为「已推翻(+日期+出处)」。
- 本批 V-01…V-32 与考古报告 `outputs/gen-ui-verdict-archaeology-20260727.md` §1 的 G01…G32
  一一对应(V-nn = Gnn);V-33 未启用即被跳过,2026-07-28 起实际从 V-34 续号,后续新判决从 V-38 起号。

## 读表须知

- **`FE/` = `frontend/shortdrama-rag-demo/src/`**(关联文件列统一用这个前缀)。
- **出处**里的 `outputs/*.md` 在项目工作区,**不在本仓库内**(Fable 的原始意见记录与考古稿);
  仓库内的可追溯入口只有两个:`docs/planning/orchestration.md` 收件箱和本文件。
- **状态词表**:`已修` / `部分修` / `从未修` / `回归`(修过又丢) / `违反`(判据层面出现即打回) /
  `未达成`(目标性,不是一次能做完的)。
- **守卫列**写测试 ID(`文件 › 测试名前缀`)或 `人工` 或 `待建(包名)`。

---

## A. 模板与预设

| 编号 | DC 原话(节选) | 日期 | 出处 | 状态 | 守卫方式 | 关联文件 |
| --- | --- | --- | --- | --- | --- | --- |
| V-01 | 「libtv 的图像处理预设、宫格预设与程序自动拆分很有参考意义」 | 07-21 | dc-asks-sweep-20260724.md:81 | 已修 | `FE/w6-presets.test.ts`(14 预设齐全性) | `FE/image-presets.ts`、`FE/components/grid-split-modal.tsx` |
| V-02 | 六类控制材料定义:「角色板…／故事板:用九宫格、十二格、二十五宫格等表达时间顺序、动作节拍…／动作板:用连续姿势、线条、箭头和文字说明动作轨迹／动作参考视频／镜头参考视频／风格与环境参考」 | 07-21 08:36 | dc-intake-merged-20260726.md:54 | 部分修(词表七组齐;缺「动作板」模板与十二格) | 待建(P-C) | `FE/lane-vocabulary.ts`、`FE/image-presets.ts` |
| V-03 | 「模版可以按类别分一下,总之打开时方便快速找到自己想要的」 | 07-23 05:10 | dc-intake-archaeology-0724.md:315 | 部分修(生图模板已分两组;**3D 导演台模板至今无分类**) | 待建(第三优先) | `FE/components/director/templates.ts` |
| V-04 | 「宫格切分后还得到最外层的资产中心去把切分后的分镜引入到项目里,这个逻辑不对」 | 07-21 09:16 | dc-intake-merged-20260726.md:63 | 已修 | `test/dc-verdicts.test.ts › V-04` ✅ | `FE/components/grid-split-modal.tsx` |
| V-05 | (判据层)14 张模板卡占了确认弹窗大半屏,把提示词和参考集挤出首屏 | 07-27 现状 | 本次截图 + `docs/design/aesthetic-judgment.md`:59 否决清单 #1 | 违反 | 待建(P-A);人工:交付前对 AESTH 第三节自查 | `FE/pages/workbench-page.tsx` |

## B. 参数与生成依据

| 编号 | DC 原话(节选) | 日期 | 出处 | 状态 | 守卫方式 | 关联文件 |
| --- | --- | --- | --- | --- | --- | --- |
| V-06 | 「生成图和视频的参数没法改。」 | 07-22 12:24 | dc-intake-archaeology-0724.md:263 | ✅ 已修(S66 R59 维度化:废整档叉乘列表,比例/清晰度/时长/数量/音频各是独立维度,值域全来自 active 档,选值按 resolveDimensionPick 反查切档) | `test/dc-verdicts.test.ts › V-06/V-07` ✅(S66 摘 todo 转真门禁) | `FE/capability-tiers.ts`、`FE/generation-dimensions.ts`、`FE/pages/workbench-page.tsx` |
| V-07 | (回归带出的功能 bug)模板承诺的画幅静默失效:5 张模板要 `1:1`/`21:9`,唯一 active 图片档是 `16:9` | 07-27 现状 | 由 V-06 回归带出 | ✅ 已修(S66:画幅在值域内→选中模板即按维度反查切档;不在值域→presetRatioNote 明示变形警示,「只预填提示词」文案清除) | 同 V-06(一条断言覆盖两行) | `FE/image-presets.ts`、`FE/capability-tiers.ts` |
| V-08 | 「生成依据是功能,功能就要尊重视频 API(seedance2.0)的文档,尊重他们支持的部分。」 | 07-24 17:03 | dc-intake-archaeology-early-and-recent.md:93 | 从未修 | 待建(P-E,依赖 S48) | `FE/pages/workbench-page.tsx`、`FE/capability-tiers.ts` |
| V-09 | 「便宜的低帧低分辨率模型可以用来快速出参考运镜和动作效果…减少贵模型的抽卡失败率」 | 07-22 08:38 | dc-intake-archaeology-0724.md:230 | 从未修 | 待建(P-E) | `FE/pages/workbench-page.tsx` |

## C. 提示词

| 编号 | DC 原话(节选) | 日期 | 出处 | 状态 | 守卫方式 | 关联文件 |
| --- | --- | --- | --- | --- | --- | --- |
| V-10 | 「粗剪素材提示词要自动包含背景信息、角色描述、场景描述等**像写论文一样的详细提示词**,不要让人自己去输入,留给人自定义输入的部分是补充需求和信息。所以提示词部分分为**固定的自动填充和补充部分**。这是 context engineering。」 | 07-24 17:03(07-21 已说过一次) | dc-intake-merged-20260726.md:60 | 从未修 | 待建(P-B) | `FE/pages/workbench-page.tsx` |
| V-11 | 「生图生视频你当做一个 context engineering 就行,我们平台就是要**简化人脑对于 context 的思考难度和管控难度**,尽量让使用者舒服、高效。」 | 07-24 11:45 | dc-intake-archaeology-early-and-recent.md:72 | 从未修(至今没写进任何产品原则文档) | 人工(P-A 信息架构评审) | `FE/pages/workbench-page.tsx`、`PRODUCT.md` |
| V-12 | 「文字描述会包含多个分镜、多个图片,那是一整段的文字描述,**不应该直接生成提示词草稿**,这个逻辑不对」 | 07-24 11:45 | dc-intake-archaeology-early-and-recent.md:67 | 从未修 | 待建(P-B) | `FE/pages/workbench-page.tsx`(`draftPromptFromScript`) |
| V-13 | 「生图页卡,提示词的 AI 优化**没有真的调用 AI 接口**。文字描述的生成提示词草稿也不是真的调用 AI…先用 doubao-seed-2.1-turbo 吧」 | 07-27(R17③) | `docs/planning/orchestration.md`:59 | 从未修(真接口 `/ai/prompt-draft` 存在,工作台两个触点没接) | 待建(P-B) | `FE/pages/workbench-page.tsx`、`FE/api.ts` |
| V-14 | 「提示词里引用的参考没有缩略图」 | 07-22 12:24 | dc-asks-sweep-20260724.md:129 | 从未修 | 待建(P-B) | `FE/components/mention-input.tsx`、`FE/prompt-mentions.ts` |

## D. 参考集

| 编号 | DC 原话(节选) | 日期 | 出处 | 状态 | 守卫方式 | 关联文件 |
| --- | --- | --- | --- | --- | --- | --- |
| V-15 | 「生成粗剪素材时,参考控制包的逻辑有问题,拿了项目匹配的资产,而不是工作台准备好就绪好的参考控制。**已匹配资产只是草稿和候选**,工作台的才是进入参考控制包的多模态全能参考」 | 07-23 10:58 | dc-intake-archaeology-0724.md:412 | ✅ 已修(S9-17) | `test/dc-verdicts.test.ts › V-15` ✅ + `FE/s9-generation.test.ts`(S9-17 行为层) | `FE/pages/workbench-page.tsx` |
| V-16 | 「工作台里,**说过很多遍的参考控制包分类分区,别每个都搞一行,没有类别和 domain 感**。光影、色彩等参考类别也没见你放上去,我之前说的都白说了吗?」 | 07-24 11:45 | dc-intake-archaeology-early-and-recent.md:70 | 🔴 回归(工作台面板有三域分区;**确认弹窗没有**,`LANE_DOMAINS` 在 workbench-page.tsx 一次都没被引用) | 待建(F2:`groupControlPackReferences` 输出必须两层) | `FE/pages/workbench-page.tsx`、`FE/components/reference-lanes.tsx` |
| V-17 | 「工作台的角色场景道具是实体参考控制。**还需要光影、色卡、摄影等抽象参考控制**」 | 07-23 08:58 | dc-intake-archaeology-0724.md:383 | 部分修(只有「光影」一组;摄影方案、负面约束集不存在) | 待建(P-C) | `FE/lane-vocabulary.ts` |
| V-18 | 「档位读取失败…**工作台还是没有色卡**」(同一件事 DC 第 4 次提) | 07-27(R17①) | `docs/planning/orchestration.md`:57 | 从未修 | 同 V-17 | `FE/lane-vocabulary.ts` |
| V-19 | 「本剧资产还待审核呢,**怎么工作台就能用了**?这个逻辑有 bug」 | 07-24 17:19 | dc-intake-archaeology-early-and-recent.md:96 | ✅ 已修(#28):通用资产只有 approved 能进控制包和生成生产链;报价后降审状态在建单、重试、Worker provider 前继续拦截 | `tests/reference-review-gate-db.test.ts` 真 PostgreSQL 14:common 四态+个人免审+HTTP 422+状态漂移 | `src/modules/control-packages/repository.ts`、`src/modules/generation/repository.ts` |
| V-20 | 「这个工作台参考栏设计有待商榷,太难用太抽象了」/「(音频/3D导演台/图片/视频)这个页面组合很好理解,反倒是参考栏搞的乱糟糟的」 | 07-22 10:21 | dc-intake-archaeology-0724.md:244 | 已修(重做为带 checklist 的分组面板;「参考栏」列为废弃词 X05) | 人工;待建(禁词扫描需先把注释与标识符口径定清) | `FE/components/reference-lanes.tsx` |
| V-21 | 生成页参考语义悬空:「当前引用」vs「@其他资产」,「其他资产」是相对谁的其他? | 07-27 走查 P1-4 | frontend-walkthrough-5173-20260727.md:57 | 从未修(已判待实现,随 S48 重构) | 待建(S48) | `FE/components/mention-input.tsx` |

## E. 生成按钮

| 编号 | DC 原话(节选) | 日期 | 出处 | 状态 | 守卫方式 | 关联文件 |
| --- | --- | --- | --- | --- | --- | --- |
| V-22 | 「一键生成本集属于 AI 自动化或者准备工作都做完了的选项和需求,**按钮出现的逻辑有问题**」 | 07-22 08:38 | dc-intake-archaeology-0724.md:221 | 已修(只对人工标记就绪的粗剪素材执行) | 待建 | `FE/pages/project-pages.tsx` |
| V-23 | 「一键生成本集和一键生成分镜图**弹出来的是一个界面**,还是刚才说的,逻辑有问题」 | 07-22 08:38 | dc-intake-archaeology-0724.md:222 | 部分修(素材级/集级已分两组件;**集级图片与视频仍共用一个抽屉**,只有标题在变) | 待建(第三优先) | `FE/pages/batch-generate-drawer.tsx` |
| V-24 | 集视图按钮堆砌:「第 1 集 / 本集视频未生成 / 一键生成本集(已就绪 1/3)/ 视频库 / 预览全集 / 3D 导演台 / 更多 / AI 批量生成 · 先估价后人工确认…」 | 07-22 12:24 | dc-intake-archaeology-0724.md:254 | 已修(唯一实心主按钮,其余降 ghost 或收进「更多」) | `test/dc-verdicts.test.ts › V-24` ✅ | `FE/pages/project-pages.tsx` |
| V-25 | 「工作台这两个 button 的功能和逻辑还有文本设计都很奇怪。你好好想想」 | 07-23 11:00 | dc-intake-archaeology-0724.md:413 | ✅ 已修(素材级唯一主按钮「生成视频」);**修法 07-30 更新**:抽屉内分段控件的做法被 DC 新指示 V-50「别弹窗」取代,抽屉整体退场——**换掉的是 Fable 设计的修法,不是 DC 判决本身** | `test/dc-verdicts.test.ts › V-25` ✅ + `FE/s9-generation.test.ts`(S9-18) | `FE/pages/workbench-page.tsx` |
| V-50 | 「**点这个直接生成别弹窗了**」(生成图标)+「生成完这张,点击生成按钮后,**下一张的准备工作和逻辑不够流畅**」 | 07-30 | DC 生成页九张标注截图(R104/R108) | ✅ 已修(07-30 DC 拍板 #12 三包全收,合流 2b3739e;「有确认图自动按图生成」语义增量 DC 已过目接受;守卫变异 Fable 亲手重跑真红复绿) | `test/dc-verdicts.test.ts › V-25`(抽屉退场后 #5 检查域改生成卡底条) | `FE/pages/workbench-page.tsx` |
| V-26 | 「『直接文生视频』把『直接』两个字去掉,整体用词要专业和行业惯用语」 | 07-22 12:24 | dc-asks-sweep-20260724.md:129 | ✅ 已修(字面残留已清,S73 挂真守卫并做变异验证) | `test/dc-verdicts.test.ts › V-26` ✅ + `FE/s17-dev-copy-guard.test.ts`(F3 全站禁词扫描) | `FE/pages/workbench-page.tsx` |

## F. 生成界面整体逻辑与审美

| 编号 | DC 原话(节选) | 日期 | 出处 | 状态 | 守卫方式 | 关联文件 |
| --- | --- | --- | --- | --- | --- | --- |
| V-27 | 「**我点进具体的生产界面,肯定要确定入参,然后生产,但界面的入参逻辑很奇怪**。你要是不知道图片视频音频怎么设计输入输出逻辑和界面排布还有功能,就直接抄 libTV 的」 | 07-24 11:45 | dc-intake-archaeology-early-and-recent.md:68 | 已修(S66:图片/视频节点复刻 libTV 三段式——编辑条在上、画布在中、生成卡在下;参数维度化 popover;⚡费用在发送键旁随参数联动) | `FE/s66-gen-node.test.ts`(三段顺序/功能位/底条断言) | `FE/pages/workbench-page.tsx`、`FE/components/gen-node-features.tsx`、`FE/components/gen-params-popover.tsx` |
| V-28 | libTV 全面对标,尤其「固定显示/默认隐藏/可收起/浮窗的设计不足,体验不如 libTV」(共 8 次) | 07-22 12:24 | dc-asks-sweep-20260724.md:129 | 部分修(S66:参数 popover 浮窗+编辑条固定显示+模板区可收起+灰显 tooltip;「固定显示/默认隐藏」体系的全面整理仍归 P-A) | 待建(P-A) | `FE/pages/workbench-page.tsx` |
| V-29 | 「在某个粗剪素材的工作台,左边是已匹配的素材原材料…图片视频音频3D导演台是具体生产参考控制包的地方,**都准备好,确认后,再生成粗剪素材**」 | 07-24 17:03 | dc-intake-archaeology-early-and-recent.md:91 | 已修(五标签页 + 参考控制包面板 + 确认抽屉,流程成立) | 待建 | `FE/pages/workbench-page.tsx` |
| V-30 | 「前端的用户体验和视觉效果还是有些问题…UI/UX 是否符合多年来各种网页和 app 建立起的大众认知和使用习惯…**能否有爽感**」 | 07-23 04:51 | dc-intake-archaeology-0724.md:273 | 未达成(走查自评「现在还不能」) | 人工(目标性判据,不能一次做完) | 全前端 |
| V-31 | 审美否决清单 #1「等宽卡片网格铺满整屏,信息密度均匀」= 出现即打回;#5「一屏多个 primary 按钮」 | 07-26 校准 | `docs/design/aesthetic-judgment.md`:59、63 | 违反(模板区 14 张等宽卡 + 模型区等宽卡 + 参考集缩略图网格,三层叠在一个 560px 抽屉里) | 部分覆盖:`test/dc-verdicts.test.ts › V-25`(**07-30 起 #5 检查域=生成卡底条唯一 primary**,确认抽屉已随 V-50 退场);#1 待建 | `FE/pages/workbench-page.tsx` |
| V-32 | 丽芬 21 条「生成图片参考她给的弹窗」→ 裁决:参考位设计融合,两段式估价与服务端提示词组装不变 | 07-27 | lifen-audit-r27-adjudication-20260727.md:23 | 未实现(裁决写的是 0.3.0 资产管线设计,弹窗没动) | 待建(并入 P-A) | `FE/pages/workbench-page.tsx` |
| V-34 | 「这个布局不奇怪吗?一大片空白?」(工作台粗剪素材页,控制包/图片/视频/音频/3D 导演台 tab 行之下整条空白带) | 07-28 | 5173 实测截图(本会话) | 未修 | 待建(并入布局优化包) | `FE/pages/workbench-page.tsx` |
| V-35 | 「这两个不是一样吗。。。」(提示词区「+参考/标记/风格」chips 与「套个模板(可选)」并存,风格与模板概念疑似重复) | 07-28 | 5173 实测截图(本会话) | 未修(Fable 初判:模板=预填提示词、风格若同为提示词注入则确属重复,应合并为一个入口;实现侧核对两者数据源后定) | 待建 | `FE/pages/workbench-page.tsx`、`FE/image-presets.ts` |
| V-36 | 「得分开选啊」(参数 popover 比例 16:9/清晰度 2K/数量 1 张仅为展示,不能逐项选择;R59 维度化选择的延续要求) | 07-28 | 5173 实测截图(本会话) | 未修(R59 已裁维度化,popover 只读=未做完或回归) | 待建(并入布局优化包,验收必须真点) | `FE/pages/workbench-page.tsx` |
| V-37 | 管理员账号默认 10 万积分(=1000 元)(「管理员默认10w积分(1k元)」) | 07-28 | 本会话 | 未修(规则待进 seed/bootstrap;dev 侧 admin 先行充值) | 待建(seed 断言) | `scripts/dev-seed.mts`、`scripts/bootstrap-production-admin.ts` |
| V-38 | 「通用资产是超管审核的,或者等董言这边的自动审核机制」——回应丽芬第 22 条「通用资产是否应该没有审核状态」 | 07-28 | 本会话 | ✅ 已收敛:通用资产提审/通过/拒绝仅平台 `admin`;项目 owner、指定审核人、资产所有者均返回 403 中文业务错误;个人资产继续免审 | `tests/review-cross-tenant-authz-db.test.ts` 真实会话→HTTP→PostgreSQL 负向/正向断言,并核验审核动作事实 | `src/modules/reviews/repository.ts`、`tests/review-cross-tenant-authz-db.test.ts` |
| V-39 | 合流权下放 heartbeat,带护栏(选项「下放,带护栏」;背景:07-28 夜 27 包积压,根因合流限主会话而主会话夜里无人唤醒) | 07-29 | 本会话选择题 | 已生效(护栏:一批≤5、merge-tree 预检、冲突即停退回主线、门禁红回滚整批、合流即回写三处、每轮巡检 commit) | `fable-handover.md` §3 + heartbeat SKILL.md ⑤ | `docs/planning/fable-handover.md` |
| V-40 | 豆包 seed-audio 真实冒烟批 50 次(供应商费用,音频链 100% 失败死结的钥匙) | 07-29 | 本会话选择题 | 未执行(sol 已备调用路径,授权已到,新 session 首件事) | 冒烟回执须带次数与费用实报 | `src/modules/audio/`(provider 层按 ADR-0002) |
| V-41 | sol 主线换新 session(旧 019fa7ec rollout 2.5GB,resume 变慢且曾双进程同写) | 07-29 | 本会话选择题 | 执行中(旧记录留档不删;新 id 落真源后旧 id 作废) | 真源 session 登记一致性 | `docs/planning/fable-handover.md` §5、heartbeat SKILL.md |
| V-42 | 合流冲突豁免口径:仅 import/依赖声明类单行机械并集可由合流者解并在 merge 说明写明,其余冲突一律退回主线(选项「补豁免,保留已解」;起因:K2F×K2T 一行 import 并集被安全分类器按严格读法拦下) | 07-29 | 本会话选择题 | 已生效(f4ccd80 保留) | 交接书 §3 + heartbeat SKILL.md ⑤ | `docs/planning/fable-handover.md` |
| V-43 | 「关于东方诗意,我的思路和想法也有问题,东方设计很难在工具上体现,还是用成熟设计系统,不追求个性化艺术。」「不搞东方审美了,或者能找到支持东方审美的成熟前端组件库和设计系统可以直接用,但我们不要自己手搓了」 | 07-29 | 设计讨论会话(R88) | 已生效(路线改判;S79 三页皮暂留待统一替换=Fable 拟、待 DC 确认) | 人工:R89 四页稿与后续设计包验收对照「成熟系统、不手搓」口径;否决清单与四词判据继续生效 | `docs/design/oriental-design-system.md`(已存档)、`FE/tokens.css` §3、`FE/s79-oriental.test.ts` |
| V-44 | 「kimi-main worktree 里新出的两版登录 HTML 稿 都不太行,不惊艳」 | 07-29 | 设计讨论会话(R88) | 已生效(a/b 双否,mockups 留档不删;登录页随 R89 双轨重出) | 人工:R89 四页稿验收 | `.worktrees/kimi-main/docs/design/mockups/01-login-a.html`、`01-login-b.html` |
| V-45 | 「用词就是界面上的开发词自造词等」(答 07-23「用词也有问题」挂账) | 07-29 | 设计讨论会话(R89);aesthetic-judgment.md §六已了结 | 部分修(守卫已在:X05 废词表+F3 全站禁词扫描;「等」=开放类别,词表随每次打回持续扩,不许只改当处) | `FE/s17-dev-copy-guard.test.ts`(BANNED_TOKENS) | 全前端文案 |
| V-46 | 「不要搞成复合档位,很反人性,档位指的是每个参数自己的档位」(批复 kimi composer 方案时重申) | 07-29 | 设计讨论会话(R90);R59/V-36 同源 | 部分修(S66 维度化已落;popover 逐项可选=V-36 载体 S83 在 rebase 队列;R89 四页稿的生成区 chip 必须一参数一 chip、值域来自 active 档) | 同 V-06/V-07 断言 + V-36 待建(S83 验收必须真点) | `FE/generation-dimensions.ts`、`FE/components/gen-params-popover.tsx` |
| V-47 | 「未注册也是要可以进入主页的,点注册登陆后,再弹窗登陆页,这好像才合理…这两版都不太行。」「kimi那边出了两版登录页我都不满意」 | 07-29 | 设计讨论会话(R91) | 已生效(登录 v2 a/b 双否;「登录整页」命题降格为弹窗组件,P1 重定义=游客首页+登录弹窗;认证形态改判默认推进待 DC 复核) | 人工:R89 四页稿验收(游客首页按转化型页面权重评) | `.worktrees/kimi-main/docs/design/mockups/02-login-{a,b}.html`、`FE/app.tsx`(未登录拦截逻辑,改码随重构包) |
| V-48 | 「你的风格确实比kimi高级,还是得暗色调」(两轨游客首页对比后拍板) | 07-29 | 设计讨论会话(R94) | 已生效(视觉语言=Fable 轨 01-visitor-home r4;token 基座=outputs/fable-mockups/DESIGN-TOKENS-v0.md;浅色方向终止;后三页赛 IA 不赛配色;**07-30 挂账解除**:「若 DC 拍换蓝需修订本条与 token」——DC 已拍留青(V-51),无需修订) | 人工:后续每页稿验收对照 v0 token 表;铺全站时转 tw.css 锁值断言 | `outputs/fable-mockups/01-visitor-home.html`、`outputs/fable-mockups/DESIGN-TOKENS-v0.md` |
| V-53 | 「AI 短剧平台的设计太复杂了,哪些低学历导演根本搞不明白用法,会觉得难用的」——目标用户=低学历导演,第一眼看不懂的功能就是难用 | 07-31 | 测试站截图标注(R128,个人资产审核徽标事件) | 判据已立(每个界面元素过「导演第一眼懂不懂」;个人资产审核徽标为首例违反:个人域不该有审核概念) | 人工:走查时以导演真实反应为准;原型验收每帧过本判据 | 全站 |
| V-52 | 「整体设计里,无边框会更高级,不想要一个一个套起来的割裂感」——层次靠明度/留白/暗纹分区,不靠描边框 | 07-31 | 设计线日志(R125,新中式方向讨论中) | **已立法生效**(07-31:token v0 §三修订「明度+留白优先,描边降为兜底三类,禁框套框」进 Theme 红线;00-04 五页去框收敛约 78 节点并验收通过;05 原型帧的对齐随壳×皮 R2 轮,见 R132) | 人工:新中式迭代稿逐帧验「有无套框割裂感」;立法修订后转 token 锁值 | `outputs/fable-mockups/DESIGN-TOKENS-v0.md`、Figma 4JDL0kKz1VxOUNKDqoyEAL |
| V-51 | 「我看了,还是青好」——UI accent 留薄荷青 #3FE0C5,不换品牌蓝;品牌蓝三变量(brand/blue·cyan·deep)只用于 logo/品牌触点 | 07-30 | 设计线交付回执(R117);Theme 页品牌色对照卡已标「已拍板存档」 | 已生效(Figma v2 全站 accent 收口:非进行中状态不用青,版本 chips 改中性,看板仅拍摄中留青——中途评审修正单 C 项实证) | 人工:铺全站时转 tw.css 锁值断言(与 V-48 同批);Figma 变量集合 Color 已绑 | Figma 4JDL0kKz1VxOUNKDqoyEAL(04 Theme)、`outputs/fable-mockups/DESIGN-TOKENS-v0.md` |
| V-56 | 「我的目标就是在测试环境能用到下一个完整迭代后的新前端后端和数据库0.3.0版本,之前的0.2.x都只是过程。」+ 同日拍板「后期流程挪号 v0.4.0」 | 08-01 | R141 总目标令+选择题拍板 | 已生效(version-plan v0.3.0 总纲落定:定义/验收公式三件套/倒推里程碑四座标;0.2.x 收编为过程段;后期流程段迁 v0.4.0 判决归属注记随迁) | 人工:9-20 发版对验收公式三件套;8-15 段一完成度对里程碑 | `docs/design/version-plan.md` v0.3.0/v0.4.0 段 |
| V-54 | 「那 A 吧」——风格基调=A 影视编辑感(三方向对比稿选型;组合=A 基调+B 数字纪律 mono/tabular/uppercase+C hover 青描边单件;真图入稿、灰占位块禁示人、字阶 48-52 用于 hero 级) | 07-31 | 设计线增量汇报(对比稿 `outputs/fable-mockups/02-projects-premium-abc.html`;立法落 DESIGN-TOKENS-v0.md「六の前」节) | 已生效(A 并入 00-04 五页,Fable 五帧验收通过;C 亮面/大圆角/pill 整体弃用;05 原型对齐随 R2 皮基线,见 R132) | 人工:每帧验收过「真图入稿/灰占位禁示人/数字 mono」;铺前端时转 token 锁值 | `outputs/fable-mockups/DESIGN-TOKENS-v0.md`、Figma 4JDL0kKz1VxOUNKDqoyEAL |
| V-55 | 「强行加纹样有点 low,这些纹样都不太美观」——传统纹样否决不进 UI;新中式到骨相为止(宋体/竖排/太极/界格母题/片场语言即是中式,字即是纹) | 07-31 | 设计线增量汇报(纹样探索线关闭) | 已生效(纹样全站铺开撤销;12 个自绘 SVG 归档 `outputs/refs/chinese-patterns/` 留品牌物料备用;兜底书封=宋体竖排剧名+panel 纯色+小太极落款;纹样仓库 CC BY-NC 4.0 不可商用、候选全按公有领域几何自绘,直接用图需谈授权) | 人工:UI 稿出现贴花式纹样即打回;书封缺省态按定案措辞验收 | `outputs/refs/chinese-patterns/`、`outputs/fable-mockups/DESIGN-TOKENS-v0.md` |
| V-49 | 「kimi好像没理解我们参考控制包的核心理念,还是按分镜的逻辑做工作台的生图生视频」 | 07-30 | 设计讨论会话(R96) | 已生效(工作台对象模型=控制包/粗剪素材中心,镜头为包下产物;按镜开单的分镜范式判偏;修正模型五条见 R96,进合稿规格) | 人工:工作台合稿验收第一条=对象模型对账(主对象是谁/包锁在哪层/换镜是否换包);与 V-10/V-15/V-29 联判 | `.worktrees/kimi-main/docs/design/mockups/07-workbench-{a,b}.html`、合稿规格(待出) |

## G. 资产与计价

| 编号 | DC 原话(节选) | 日期 | 出处 | 状态 | 守卫方式 | 关联文件 |
| --- | --- | --- | --- | --- | --- | --- |
| V-57 | 「资产送审:维持免审——只有升为通用资产时才审」(丽芬六问第 4 条,二选一里选①) | 08-11 | 产品负责人选择题拍板(丽芬 Figma 评论 `1872390620` / `1872452037` 分诊) | 已生效(追认现状,代码不动;`prd-v2/assets.md` §8.3 第 4 条已销待拍板标记)。与 V-53「个人域不该有审核概念」同向;合规那部分改由「下载带 AIGC 标识 + 动作入审计」承担 | 人工:资产入库动线上出现审核徽标或"待审"态即打回(V-53 首例违反就是这个) | `docs/design/prd-v2/assets.md` §8.3 |
| V-58 | 「通用转个人:不可退,一入通用即公共」(丽芬六问第 2 条) | 08-11 | 同上 | 已生效(`prd-v2/assets.md` §8.3 第 2 条已销待拍板标记)。个人→通用仍须超管审(V-38);想收回只能超管下架,**下架不影响已建立的引用** | 人工:界面上出现"取回私有"/"转回个人"动作即打回;下架后既有引用仍可追溯 | `docs/design/prd-v2/assets.md` §8.3 |
| V-59 | 「#246 计价选 1」——全站统一**按分镜时长**计价,不按档位自带的固定时长 | 08-11 | 产品负责人选择题拍板(issue #246 分诊) | 待施工(前端逐镜卡已是这个口径,**后端按档位固定时长算,两者差约 25%**,以前端口径为准后端跟上;报价与实扣必须走同一个计算入口) | 待建:同一次生成在逐镜确认卡 / 整段估价 / 消耗看板 / 扣费记录四处显示一致 | issue #246;计价入口(前后端各一处,合并到一处) |

| V-60 | 「定稿类全算能当图片参考」——`character_final` / `scene_final` / `costume_reference` / `animal_reference` / `scene_reference` / `character_reference` / `other` 都算;**三视图 `character_turnaround`、多视图 `scene_multi_view` 排除** | 08-11 | 走查实测后当场拍板(全库 1630 条未删媒体只有 538 条被算成「图」,约 573 条真实定稿图产品认不出来) | 待施工(`prd-v2/assets.md` §2.1 已落字;前端 `FE/components/asset-shared.tsx:444` 的 `media_kind === "image"` 精确判定要改成按上述集合判。**后端 `assets/projectScope.ts` 挑图不看 media_kind,这一层是干净的**) | 待建:拿现网 kind 分布跑一遍,断言七类都算得进、两类视图算不进 | `docs/design/prd-v2/assets.md` §2.1、`FE/components/asset-shared.tsx:444`、`FE/control-pack.ts` |
| V-61 | 「缺参考警告但一律放行,不做拦截」 | 08-11 | 同上 | 待施工(`prd-v2/assets.md` §2.1 已落字) | 待建:无可用参考时提交仍然成功,且界面出现警告文案 | `docs/design/prd-v2/assets.md` §2.1 |

## H. 拆解与场次

本节 2026-08-12 新开:前面 A–G 都是生成界面与资产域,拆解 agent 的裁决此前没有落脚处。

| 编号 | DC 原话(节选) | 日期 | 出处 | 状态 | 守卫方式 | 关联文件 |
| --- | --- | --- | --- | --- | --- | --- |
| V-62 | 「按你的建议拆」——把 #283 的「场标是剧本里明写的东西,不该由模型判断」拆成两半:**① 场数由场标行数定,不由模型判断**(保留原裁决);**② 哪一行算场标,允许模型按判据认**(放开)。理由:中文剧本的场标写法关不上枚举,封闭清单必然漏,而漏掉的后果是模型同时收到「这份稿子没有场标」和「不许自己切」,整集塌成 1 场——仓库自己的冒烟脚本(「第一场 客栈门口 黄昏」)与四份 agent 测试夹具(「场景一 客栈门口」)就是这种稿子 | 08-12 | 本会话(#285 / #286 重跑复验)向产品负责人提请拆分,当场拍板 | 已生效。PR #285 的 `SCENE_HEADING_FORMS_RULE` 按 ② 写成开放判据(「这一行在交代场次、地点、时间、内外景,而不是台词或动作」,不是固定关键词表);`SCENE_HEADING_BOUNDARY_RULE` 按 ① 钉死「有几行场标就拆几场」并禁掉按剧情自己再切。总纲(`runner.ts` 系统提示)与 schema 共用同一常量,由构造保证同源 | `tools.test.ts › 场次边界照剧本的场标行走` / `› 盲区回归:仓库自己在用的中文场标写法` / `› 没场标的稿子有出路`,`runner.test.ts › 场标写法只有一份`(读真发往通道的载荷,防规则在路上被抹掉);行为面证据见下 | `src/modules/script-breakdown/agent/tools.ts`、`agent/runner.ts`、`agent/tools.test.ts`、`agent/runner.test.ts` |

**V-62 的行为面证据**(2026-08-12 在 PR #285 的 head `708e9b77` 上实跑,产物
`zhongwen-shortdrama-local-data/breakdown-eval/runs-b1-708e9b77-20260812/`,
报告 `outputs/breakdown-eval-708e9b77-20260812.md`):

| 集 | 金标场数 | 实跑 | 场名 null |
| --- | ---: | --- | ---: |
| `ep-idb-09` | 1 | 8 次全 1(标准差 0) | 0 |
| `ep-bdlw-09` | 4 | 8 次全 4(标准差 0) | 0 |

改造前同一集是 1、4、4、1、1、1(变异系数 77.5%)。封闭枚举那一版(`3e344bdb`)在
`ep-idb-09` 上同样 8 次全 1,**两版在这两集上打平,② 的放开没有把方差放回来**。

**这批数据只能证伪不能证成**:它证明模型这一批判对了,不等于「不由模型判断」被满足——
所以 ① 那半必须留在裁决里,由上面那几条守卫盯着,不能靠跑分保。

| 状态 | 条数 | 编号 |
| --- | --- | --- |
| 已修 | 13 | V-01、V-04、V-06、V-07、V-15、V-19、V-20、V-22、V-24、V-25、V-26、V-27、V-29 |
| 部分修 | 5 | V-02、V-03、V-17、V-23、V-28 |
| 🔴 回归 | 1 | V-16 |
| 从未修 / 违反 / 未达成 | 13 | V-05、V-08~V-14、V-18、V-21、V-30、V-31、V-32 |

## 守卫测试:首批 5 条 + V-26(S73 补挂) + V-19(#28 真库)

文件 `test/dc-verdicts.test.ts`,与仓库门禁同一套 `node:test`(`npm test` 即跑)。

| 判决 | 断言的是什么 | 现在 |
| --- | --- | --- |
| V-06 / V-07 | 模板画幅在值域内必须能 resolveDimensionPick 反查命中档;不在值域必须 presetRatioNote 明示变形警示;「只预填提示词」文案不得复活 | ✅ 绿(S66 修复,`todo` 已摘,转真门禁) |
| V-15 | 确认抽屉参考集取数源 = 工作台控制包,不是项目匹配资产候选池 | ✅ 绿(锁住,防 P-A 重排时改回候选池) |
| V-24 | 集视图头部只有一个实心主按钮,批量生成图片收在「更多」里 | ✅ 绿 |
| V-25 | 素材级唯一主按钮「生成视频」;确认抽屉内只有一个 primary;「生成本粗剪素材」「文生视频」双钮不得复活 | ✅ 绿 |
| V-04 | 宫格切分就地挂项目资产 + 建粗剪素材,不跳资产中心 | ✅ 绿 |
| V-26 | 「直接文生视频」五字组合全站零残留(本测试自带全量扫描);F3 词表(s17-dev-copy-guard)登记不得摘除 | ✅ 绿(S73 挂上,两种变异均验证变红) |
| V-19 | 通用资产只有 approved 能写控制包并进入生成；报价后降审状态在建单、重试和 Worker 付费提交前继续失败关闭；个人资产免审 | ✅ 绿(`#28 tests/reference-review-gate-db.test.ts`,PostgreSQL 14) |
| V-62 | ① 场数 = 场标行数,禁掉按剧情/情绪/时间跳跃自己再切;② 场标写法必须是开放判据,不得写回封闭关键词表;场次 name 照抄整行场标、null 只作例外;以上四条既断构造出来的 schema,也断真发往通道的载荷 | ✅ 绿(PR #285 已于 2026-08-12 合入 dev,合并提交 `cc72f832`)。守卫在 `agent/tools.test.ts` 与 `agent/runner.test.ts`,不在 `test/dc-verdicts.test.ts`——它们和被守的常量同目录,改常量的人一定会看见 |

**为什么 V-06 用 `todo` 而不是删掉**:门禁不能因为一笔既有欠账挡住所有人合流,但欠账必须可见。
`todo` 测试照跑照报错、进不了 fail 计数,每次 `npm test` 都把这行红字打在所有人脸上。
**S66(参数维度化包)修完后把 `todo` 去掉**,它就变成真门禁。
(2026-07-27 Fable 修订:原文写「S59(参数解冻包)」——实际 S59 是弹窗重构包,不含档位值域化;
参数维度化经 R59/R60 定给 S66,V-06/V-07 载体随之改挂 S66。)

下一批优先补(按报告 §3 建议):V-16(分组必须两层)、
V-05/V-31(抽屉顶层常驻区块数 ≤ 3)。

## 回执模板:「DC 判决对账」节

每个前端包的 `docs/validation/*.md` 复制这一节,按本包碰过的文件从上表反查 V 编号:

```markdown
## DC 判决对账(必备节,判决真源:docs/design/dc-verdicts.md)

| V 编号 | 本包处置 | 说明 |
| --- | --- | --- |
| V-15 | 保持 | 抽屉重排没动取数源,`test/dc-verdicts.test.ts › V-15` 仍绿 |
| V-06 | 改进 | 档改为值域,模板 ratio 参与提交;todo 标记已摘除 |
| V-16 | 暂不动 | 理由:两层分组依赖 P-C 的域词表补全,本包只做信息架构 |
```

三选一,**「暂不动」必须写理由**——S5 那次回归如果被逼着写出「V-06:暂不动,理由=后端不认自由参数」,
Fable 当时就会看见冲突,而不是三个月后 DC 看见。
