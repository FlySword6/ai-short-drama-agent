# Token 对齐与 legacy 归档 规格(R159/R160,2026-08-02;DC:「把旧的归档掉,别影响新版」)

## 目标
新版气质=Figma 帧的气质。根治「买家秀卖家秀」:新 token 基建从 Figma 变量直出,legacy 体系归档隔离,新页零依赖旧样式。

## 施工五件

1. **tokens.css 新建**(frontend/shortdrama-rag-demo/src/styles/tokens.css):
   - 唯一源=Figma「COL 短剧设计系统 v2」Foundations 页三变量集合(Color/Spacing/Radius),用 get_variable_defs 拉**真值**,禁手抄禁凭记忆;
   - 字体体系:宋体两切(标题/场名类衬线)+正文黑体+数字 mono(积分/时间码/计数一律 mono),font-face 引入与降级链写清;
   - 明度分区阶(bg→pane→elevated 的层次差),无边框法则的 CSS 实现(禁 border 分区,用背景明度+留白)。
2. **基础件重铸**:panel/card/badge/button 四类基础样式按 token 重写(新类名 tk- 前缀),对照 Figma Components 页组件——不改组件行为只换皮。
3. **五新页切换**:P-04 段落工作台/P-06 剧本/P-07 项目资产/P-03b 备戏台/登录弹窗+游客页,全部切 tk- 体系;切换后**逐页截图与对应 Figma 帧并排**进回执(帧保真验收首跑)。
4. **legacy 归档**:legacy.css → legacy-archived.css,仅旧页(StoryboardPage/旧 workbench 等待退役页)引用;新页文件出现 legacy 引用即门禁红(加一条守卫:新页 import 清单禁 legacy-archived)。
5. **演示数据配平**:切换后空列/无图卡按雾岛包补齐(书封海报全量挂上),质感=数据×样式两条腿。

## 验收(帧保真级,新口径首次执行)
- 五页截图 vs Figma 帧并排,统筹逐页判「气质到没到」:字体层次/明度分区/留白密度/mono 数字四项逐页过;
- 守卫全绿+E2E 15 用例复跑绿(样式改动不许破动线);
- tag KIMI-TOKEN-ALIGN-DONE。

## 边界
- 旧页(退役队列)不切不修,随块 2 退役一起消失;
- 动效不在本单(动效体系随 Figma 动效 section 后接);
- UX spec 单(KIMI-UX-EVAL)暂挂,本单完成后续跑。
