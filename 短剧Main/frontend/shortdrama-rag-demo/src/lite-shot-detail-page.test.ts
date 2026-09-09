/* ============================================================
   lite-shot-detail-page.test.ts — v1.5/v1.5.1 Lite 分镜详情工作台测试
   （用户反馈第六轮六问 + 匹配口径对齐 lite-assets 8.8/8.9；
   见 docs/design/prd-v2/lite-shots-page.md 决策 4/8、流程 5）
   ============================================================
   覆盖：
   - 源码口径（静态断言）：反馈①顶部 tab 纯镜号数字；反馈②名称+类型徽记
     （ASSET_KIND_LABELS 同一套映射）；反馈③剧本原文可编辑（textarea 失焦保存）；
     反馈④「场景」输入框（匹配/建场后绑 scene_id）；反馈⑤镜头描述/氛围/结构化
     对白编辑器退役（缺席断言）；反馈⑥播放器高度有上限；v1.5.1 已选资产 =
     reference_asset_snapshots 只读投影（auto 移除走 liteRemoveShotAutoRef 抑制
     名单；生成不手传 references，服务端按 shot_id 自动解析——8.9）。
   - 纯函数（从页面导出导入）：分镜编码 shotCode、快照投影 displaySnapshots、
     selection_source 读法、当前版选择、metadata wire 读/写、AI 提示词描述。
   - 组件级：demo 模式渲染布局；真栈（fetch 全 mock）整条重做
     quote→confirm→create 三段式请求体（无 references 键）+ 幂等键台账 + 任务卡。

   测试自身不含 JSX：一律 React.createElement。happy-dom 先落地全局再动态 import
   react/react-dom（同 lite-shots-reference.test.ts 基建纪律）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";

const source = readFileSync(new URL("./pages/lite/lite-shot-detail-page.tsx", import.meta.url), "utf8");

/* happy-dom 先落地全局，再动态 import react/react-dom。 */
const happyWindow = new Window({ url: "http://localhost/" });
for (const key of Object.getOwnPropertyNames(happyWindow)) {
  if (!(key in globalThis)) {
    (globalThis as Record<string, unknown>)[key] = (happyWindow as unknown as Record<string, unknown>)[key];
  }
}
(globalThis as Record<string, unknown>).window = happyWindow;
(globalThis as Record<string, unknown>).document = happyWindow.document;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
/* 事件构造器与 happy-dom EventTarget 同源（Radix 弹层 dispatchEvent 类型校验）。 */
for (const eventCtor of ["Event", "CustomEvent", "PointerEvent", "MouseEvent", "KeyboardEvent", "FocusEvent"]) {
  (globalThis as Record<string, unknown>)[eventCtor] = (happyWindow as unknown as Record<string, unknown>)[eventCtor];
}
/* IntersectionObserver 替身（页面有懒加载组件时按真实浏览器行为走；本页用不上也备着）。 */
class TestIntersectionObserver {
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) { this.callback = callback; }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
  root = null;
  rootMargin = "";
  thresholds = [];
}
(globalThis as Record<string, unknown>).IntersectionObserver = TestIntersectionObserver;

/* 组件挂载依赖 happy-dom 先落地全局，React 求值时才能拿到 DOM/event 构造器；
   故 react / react-dom / 页面模块必须动态 import（静态 import 会在全局落地前求值）。 */
const { act, createElement } = await import("react");
(globalThis as Record<string, unknown>).React = await import("react");
const { createRoot } = await import("react-dom/client");
import type { Episode, MediaVersion, Scene, Shot, ShotAssetSnapshot } from "./types";
const {
  LiteShotDetailPage,
  ASSET_KIND_LABELS,
  buildPromptDescription,
  currentVideoOf,
  displaySnapshots,
  validSnapshots,
  liteShotMeta,
  liteShotMetadataPatch,
  shotCode,
  shotVideoSelectionSource,
} = await import("./pages/lite/lite-shot-detail-page");
const { LiteShell } = await import("./pages/lite/lite-shell");

/* ============================================================
   源码口径：反馈①-⑥ + v1.5.1 匹配口径
   ============================================================ */

test("源码：页面以 React.createElement 手写，无 JSX 标签闭合", () => {
  assert.ok(!source.includes("</div>"), "不得出现 JSX div 闭合");
  assert.ok(!source.includes("</section>"), "不得出现 JSX section 闭合");
  assert.ok(!source.includes("</button>"), "不得出现 JSX button 闭合");
  assert.ok(source.includes("const h = React.createElement"), "页面应手写 createElement 助手 h");
});

test("源码：返回按钮上壳单条（2026-08-17 页头退役 + 二次裁定：每页常驻带文字；2026-08-18：分镜详情返回确定回项目详情）", () => {
  const shell = readFileSync(new URL("./pages/lite/lite-shell.tsx", import.meta.url), "utf8");
  assert.ok(shell.includes("返回项目详情"), "壳单条‹ 返回项目详情（分镜详情，2026-08-18 改名）");
  assert.ok(shell.includes("返回素材"), "壳单条‹ 返回素材（资产详情）");
  assert.ok(shell.includes("返回项目列表"), "壳单条‹ 返回项目列表（工作页/配置页）");
  assert.ok(!shell.includes("hidden md:inline"), "返回文字常显，不因窄屏藏成纯箭头");
  assert.ok(shell.includes("shellDetailBack"), "返回去向在 lite-shell");
  assert.ok(shell.includes('if (target === "shots")'), "分镜详情返回走确定性分支");
  assert.ok(shell.includes('navigate(liteProjectPath(projectId, "workspace", episodeId));'), "分镜详情固定回制作页（项目详情），切镜不污染返回去向");
});

test("源码：反馈① 顶部 tab = 纯镜号数字（当前集排序位），完整编码进悬停 title——tab 在壳顶栏（v1.6 追加）", () => {
  const shell = readFileSync(new URL("./pages/lite/lite-shell.tsx", import.meta.url), "utf8");
  assert.ok(shell.includes('aria-label="同集分镜"'), "同集分镜 tab 条在壳顶栏");
  assert.ok(shell.includes("liteShotDetailPath(projectId, item.id, currentEpId)"), "页签点击切镜");
  assert.ok(shell.includes("const label = String(index + 1)"), "tab 文案 = 排序位序号");
  assert.ok(shell.includes("title={`分镜 ${label} · ${shotCode(item, currentEp, sceneOfItem)}`}"), "完整场记编码进悬停");
  assert.ok(!shell.includes("isActive ? `${label}●`"), "当前镜标 ● 退役，高亮靠背景色（2026-08-18）");
  assert.ok(!source.includes('"aria-label": "同集分镜"'), "页内不再渲染同集分镜 tab 条（上壳）");
});

test("源码：反馈② 已选资产 = 快照只读投影，名称 + 类型徽记（与制作页同一套映射）", () => {
  assert.ok(source.includes("已选资产"), "左栏①标题");
  assert.ok(source.includes("displaySnapshots(shot?.reference_asset_snapshots)"), "数据源 = 快照投影");
  assert.ok(source.includes("匹配+选择"), "加/改入口改名「匹配+选择」，与「已选资产」标题同行（2026-08-18）");
  assert.ok(!source.includes("资产侧声明的只读投影"), "只读投影说明文案退役（2026-08-18）");
  assert.ok(source.includes("ASSET_KIND_LABELS[snapshot.asset_kind]"), "类型映射");
  assert.equal(ASSET_KIND_LABELS.character, "角色");
  assert.equal(ASSET_KIND_LABELS.scene, "场景");
  assert.equal(ASSET_KIND_LABELS.prop, "道具");
  assert.equal(ASSET_KIND_LABELS.costume, "服装");
  assert.equal(ASSET_KIND_LABELS.audio, "音频");
});

test("源码：2026-08-19 已选资产按 (asset, variant) 去重——同变体只出一行，资产级与变体级各自成行；副行显示引用层级", () => {
  assert.ok(source.includes("displaySnapshots(shot?.reference_asset_snapshots)"), "左栏数据源 = 快照投影（按资产变体去重）");
  assert.ok(source.includes("validSnapshots(shot?.reference_asset_snapshots)"), "弹窗种子 = 全部有效引用（不去重）");
  assert.ok(source.includes("pickerRefs"), "种子与展示拆源");
  assert.ok(source.includes("autoRemovable"), "行内移除只给单条 auto 引用行");
  assert.ok(source.includes("scopeLabel"), "行内区分变体/资产级");
  assert.ok(source.includes('变体「${snapshot.variant_name}」'), "有变体名时显示变体名");
  assert.ok(source.includes('"资产级"'), "variant_id 为空的引用标注资产级");
});

test("源码：2026-08-18 弹窗裁定「匹配+选择」不再跳素材页，改开本镜资产多选弹窗", () => {
  assert.ok(!source.includes('navigate(liteProjectPath(projectId, "assets", episodeId))'), "跳转素材页退役（弹窗优于跳转：不丢左栏未保存编辑）");
  assert.ok(source.includes("setAssetPickerOpen(true)"), "按钮改开弹窗");
  assert.ok(source.includes("LiteShotAssetPickerDialog"), "弹窗接入本页");
  assert.ok(source.includes("linkedAssetKeys"), "已关联键集传给弹窗（reference_asset_snapshots → pickerKey）");
  assert.ok(source.includes("autoRefAssetKeys"), "exact_name(auto) 子集传给弹窗（取消勾选走 liteRemoveShotAutoRef）");
  assert.ok(source.includes("onLinked: retryShot"), "关联成功回拉分镜刷新快照");
});

test("源码：v1.5.1 分镜侧不写 shot_asset_refs（8.9：不引入进 lite）", () => {
  assert.ok(!source.includes("createShotAssetRef"), "lite 详情页不得创建 shot_asset_refs 行");
  assert.ok(!source.includes("updateShotAssetRef"), "lite 详情页不得改 shot_asset_refs 行");
  assert.ok(!source.includes("deleteShotAssetRef"), "lite 详情页不得删 shot_asset_refs 行");
  assert.ok(!source.includes("shotAssetRefs"), "lite 详情页不得读 shot_asset_refs 清单");
  assert.ok(source.includes("liteRemoveShotAutoRef"), "移除 auto 项 = 快照删除 + removedAutoRefs 抑制名单");
});

test("源码：反馈③ 剧本原文可编辑（textarea 失焦保存 script_text）", () => {
  assert.ok(source.includes("剧本原文"), "原文区保留");
  assert.ok(source.includes("saveScriptText"), "失焦保存处理器");
  assert.ok(source.includes("onBlur: saveScriptText"), "textarea 挂失焦");
  assert.ok(source.includes("patchShot({ script_text: trimmed || null })"), "保存写 script_text");
  assert.ok(source.includes("失焦自动保存"), "保存语义明示");
});

test("源码：反馈④ 「场景」输入框（文案改名 + 失焦匹配/建场后绑 scene_id）", () => {
  assert.ok(source.includes('"场景"'), "文案 = 场景");
  assert.ok(!source.includes('"场次"'), "旧文案「场次」退役");
  assert.ok(source.includes("saveSceneInput"), "失焦保存处理器");
  assert.ok(source.includes("api.createScene"), "未命中 → 建场");
  assert.ok(source.includes("scene_no: nextSceneNo"), "建场带 scene_no");
  assert.ok(source.includes("patchShot({ scene_id: matched.id })"), "命中 → 绑 scene_id");
  assert.ok(source.includes("patchShot({ scene_id: null })"), "清空 → scene_id=null");
  assert.ok(!source.includes("未分场"), "旧下拉选项「未分场」退役");
});

test("源码：2026-08-18 v1.7 反馈——对白/动作输入框与场景/时长同组（失焦保存，窄屏自滚）", () => {
  assert.ok(source.includes('"对白"'), "对白字段文案");
  assert.ok(source.includes('"动作"'), "动作字段文案");
  assert.ok(source.includes("onBlur: saveDialogue"), "对白失焦保存");
  assert.ok(source.includes("liteShotMetadataPatch({ dialogue_note: trimmed || null })"), "对白写 metadata.lite.shot.dialogue_note（065 命名空间）");
  assert.ok(source.includes("onBlur: saveAction"), "动作失焦保存");
  assert.ok(source.includes("action: trimmed || null"), "动作写 breakdown_elements.action（现有列，不新增字段）");
  assert.ok(source.includes("overflow-y-auto px-4 py-3 lg:overflow-y-visible"), "窄屏页面自滚（堆叠模式底部字段不被裁）");
});

test("源码：反馈⑤ 镜头描述/氛围/结构化对白编辑器退役（内容收敛进剧本原文）", () => {
  /* 编辑器的代码标识符全部退役（注释里允许提及"已退役"字样，故按标识符断言）。 */
  assert.ok(!source.includes("breakdownDraft"), "拆解四字段草稿状态退役");
  assert.ok(!source.includes("saveBreakdownField"), "拆解保存处理器退役");
  assert.ok(!source.includes("renderBreakdownField"), "拆解字段渲染退役");
  assert.ok(!source.includes("atmosphereDraft"), "氛围草稿退役");
  assert.ok(!source.includes("saveAtmosphere"), "氛围保存退役");
  assert.ok(!source.includes("renderDialogueEditor"), "结构化对白编辑器退役");
  assert.ok(!source.includes("dialogueLines"), "对白行状态退役");
  assert.ok(!source.includes("dialogueToScriptText"), "对白→script_text 回写退役");
  assert.ok(!source.includes("加一行"), "对白加行退役");
  assert.ok(!source.includes("保存对白"), "对白保存退役");
  assert.ok(source.includes("剧本原文"), "剧本原文成为唯一可编辑文本口径");
});

test("源码：反馈⑥ 右栏播放器高度有上限（版本条与提示词恒可见）", () => {
  assert.ok(source.includes("flex h-40 items-center justify-center overflow-hidden rounded-lg bg-black lg:h-56"), "右栏播放器容器固定高度（小屏 h-40 / 大屏 h-56，2026-08-18）");
  assert.ok(source.includes("max-h-full max-w-full"), "右栏视频 object-contain 式约束（不随宽度无限放大）");
});

test("源码：视频版本（播放器/当前版/设当前版/标签/下载/回溯）", () => {
  assert.ok(source.includes("视频版本"), "右栏①标题");
  assert.ok(source.includes("shotMedia"), "版本列表读取");
  assert.ok(source.includes("setShotPrimary"), "设当前版");
  assert.ok(source.includes("setVersionLabel"), "版本标签保存");
  assert.ok(source.includes("version_label"), "版本标签展示/编辑");
  assert.ok(source.includes("downloadMedia"), "下载");
  assert.ok(source.includes("generation_request_id"), "回溯按生成任务 id 拉取");
  assert.ok(source.includes("回溯"), "回溯入口");
  assert.ok(source.includes("currentVideoOf"), "当前版 = 定稿否则最新默认");
  assert.ok(source.includes("shotVideoSelectionSource"), "selection_source 读法");
});

test("源码：整条重新做 = estimate → create(auto_confirm 并入, v1.9 十.7) + 幂等键 + 服务端自动解析参考（8.9）", () => {
  assert.ok(source.includes("整条重新做"), "版本编辑弹窗① = 整条重新做");
  assert.ok(source.includes('}, "生成视频")'), "生成按钮文案不带「一次任务」后缀（2026-08-19 裁定）");
  assert.ok(source.includes("quoteGeneration"), "① 估价");
  assert.ok(source.includes("createGeneration(submitBody, quote.generation_quote_id, true)"), "② 提交带 auto_confirm（十.7 并入确认）");
  assert.ok(!source.includes("confirmGenerationQuote"), "v1.9 十.7：不再单独调 confirm");
  assert.ok(source.includes("client_idempotency_key"), "幂等键");
  assert.ok(source.includes("supplement_prompt"), "生效模板内容拼入补充段");
  assert.ok(source.includes("effectivePromptTemplate"), "生效模板解析");
  assert.ok(!source.includes("input.references"), "参考不再手传——服务端按 shot_id 自动解析快照（8.9）");
  assert.ok(source.includes("rememberLiteGenMarker"), "提交前落幂等键台账");
  assert.ok(source.includes("readLiteGenMarkers"), "挂载恢复读台账");
  assert.ok(source.includes("pollDelayMs"), "指数退避轮询");
  assert.ok(source.includes("resolveLiteTier"), "策略反查档");
  assert.ok(source.includes("LITE_REFERENCE_REJECT_MESSAGE"), "参考被拒人话");
  assert.ok(source.includes("isLiteReferenceRejection"), "422 InvalidParameter 识别");
});

test("源码：视频提示词（绑定/失焦保存/AI 草稿/锁定；描述以剧本原文为主）", () => {
  assert.ok(source.includes("视频提示词"), "右栏③标题");
  assert.ok(source.includes("video_prompt"), "绑定字段");
  assert.ok(source.includes("onBlur: saveVideoPrompt"), "失焦保存提示词");
  assert.ok(source.includes("draftPrompt"), "AI 生成草稿接口");
  assert.ok(source.includes("AI 生成"), "草稿按钮");
  assert.ok(source.includes("prompt_locked"), "锁定元数据键");
  assert.ok(source.includes("promptLocked"), "锁定状态");
  assert.ok(source.includes("不会自动保存"), "草稿不自动保存说明");
  assert.ok(source.includes("selectedAssetIds = [...new Set(refs.map((snapshot) => snapshot.asset_entity_id))]"), "AI 草稿资产上下文 = 快照实体 id");
});

test("源码：不在本页的功能缺席（首帧登记/延长/image 生成/image_prompt 编辑/segment 编辑/裁片/定稿快照）", () => {
  for (const gone of ["首帧登记", "延长", "image_prompt", "segment", "裁片", "定稿快照", "first_frame"]) {
    assert.ok(!source.includes(gone), `本页不得出现「${gone}」`);
  }
});

/* ============================================================
   源码口径：v1.6（2026-08-18 第七轮三问）
   ============================================================ */

test("源码：v1.6 反馈① tab 条在壳顶栏横向滚动自适应，切镜后当前 tab 滚进可视区，字号收敛", () => {
  const shell = readFileSync(new URL("./pages/lite/lite-shell.tsx", import.meta.url), "utf8");
  assert.ok(shell.includes("flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"), "壳顶栏 tab 条横向滚动（窄屏/多镜兼容）");
  assert.ok(shell.includes('scrollIntoView({ block: "nearest", inline: "center" })'), "切镜后当前 tab 自动滚进可视区");
  assert.ok(shell.includes("rounded-md px-3 py-2 text-sm"), "壳顶栏 tab 字号 text-sm + 圆角 rounded-md（2026-08-18）");
  assert.ok(!source.includes("scrollIntoView"), "页内 tab 条与滚动副作用退役（迁入壳）");
});

test("源码：工作页 tab 字号保持收敛", () => {
  const shell = readFileSync(new URL("./pages/lite/lite-shell.tsx", import.meta.url), "utf8");
  assert.ok(shell.includes("rounded-sm px-4 py-2 text-xs"), "工作页 tab text-xs（12px，2026-08-18 再收敛）");
  assert.ok(!shell.includes("gap-1 whitespace-nowrap rounded-sm px-4 py-2 font-medium"), "旧 text-base（16px）配方退役");
});

test("源码：v1.6 反馈② 已选资产列表固定高度内部滚动，徽记收敛为「自动匹配」", () => {
  assert.ok(source.includes("max-h-48 space-y-2 overflow-y-auto"), "资产列表固定高度 + 内部滚动（小屏 max-h-48 / 大屏 max-h-80，2026-08-18）");
  assert.ok(source.includes('isAuto ? "自动匹配" : "手动关联"'), "来源徽记 = 自动匹配 / 手动关联");
  assert.ok(!source.includes("自动匹配（一键生成本集）"), "来源徽记「一键生成本集」退役");
  assert.ok(source.includes("refs.length} 个"), "计数徽记提示总量（参考资产放开上限时心里有数）");
});

test("源码：v1.6 反馈③ 生成视频档本镜三级级联可选（模型/比例/清晰度全从正式池推导）", () => {
  assert.ok(source.includes("availableVideoTiers = useMemo(() => formalVideoTiers(genConfigState.data?.tiers ?? [])"), "维度取值从正式池（seedance，非预览火山方舟视频档）推导，不硬编码");
  assert.ok(source.includes("handleTierModelChange"), "切模型处理器");
  assert.ok(source.includes("handleTierRatioChange"), "切比例处理器");
  assert.ok(source.includes("handleTierResolutionChange"), "切清晰度处理器");
  assert.ok(source.includes("pickLiteDefaultTier(availableVideoTiers.filter"), "切模型 → 该模型下按配置页策略反查默认档");
  assert.ok(source.includes("tierPriceLabel(selectedTier)"), "档价如实展示");
  assert.ok(source.includes("tierOverrideId"), "用户覆盖档状态（null = 跟配置页默认档）");
  assert.ok(source.includes("const tier = forcedTier ?? override ?? resolved ?? cheapestActiveTier(videoTiers)"), "提交档 = 强制档（预览）→ 覆盖档 → 正式池内默认档反查 → 最便宜 seedance 档兜底");
});

test("源码：固定「回溯」行退役（2026-08-18）——每版参数在版本详情弹窗看，右栏不常驻", () => {
  assert.ok(!source.includes("tracebackLine"), "回溯行数据拼接退役");
  assert.ok(!source.includes("③ 回溯行（固定）"), "回溯行渲染退役");
  assert.ok(source.includes("版本提示词（生成时用的）"), "按版回溯仍在版本详情弹窗");
});

test("源码：无视频版本不占位、版本区不带生成按钮（2026-08-18）——生成入口唯一在提示词区底部", () => {
  assert.ok(!source.includes("还没有视频"), "空态占位卡退役");
  assert.ok(!source.includes("用下方提示词生成第一版"), "空态占位文案退役");
  assert.ok(source.includes("videos.length === 0 ? null"), "无视频 = 版本区不渲染占位");
  assert.ok(source.includes("暂无版本"), "「暂无版本」徽记保留");
});

test("源码：v1.6.8 正式=seedance / 预览=快乐马——档池硬切分，预览弹窗锁定快乐马单档（refs 1–9 闸）；v1.7 参数化（比例/清晰度/时长可调）", () => {
  assert.ok(source.includes("预览视频"), "次级入口「预览视频」（常驻渲染）");
  assert.ok(source.includes("生成预览"), "预览提交按钮文案");
  assert.ok(!source.includes("生成预览（1 次任务）"), "预览提交按钮不带「（1 次任务）」后缀（2026-08-19 用户裁定）");
  assert.ok(source.includes("renderPreviewDialog"), "预览弹窗渲染函数");
  assert.ok(source.includes("startGeneration(previewTier, true, { resolution: previewResolution, ratio: previewRatio, durationSeconds: previewDuration })"), "预览提交强制快乐马预览档 + 带 preview 标记 + 携带弹窗覆盖参数（比例/清晰度/时长）");
  assert.ok(!source.includes("setPreviewOpen(false)"), "提交预览后弹窗默认不关闭（2026-08-19：出片前保持打开）");
  assert.ok(source.includes("视频生成中…出片后自动出现在上方播放器，弹窗保持打开。"), "生成中状态在弹窗内可见");
  assert.ok(!source.includes("submissionParameters"), "无兼容层：预览身份只来自快乐马档 params.preview=true（E2 的 submissionParameters 前端追加键已回退，不留死代码）");
  assert.ok(source.includes("forcedTier: CapabilityTier | null = null"), "正式链接受强制档参数");
  assert.ok(source.includes("formalVideoTiers(config.tiers)"), "正式闸与提交档池 = formalVideoTiers（seedance 锁定，快乐马预览档不进正式链）");
  assert.ok(source.includes("previewTiers = useMemo(() => previewVideoTiers"), "预览池 = previewVideoTiers（快乐马预览档）");
  assert.ok(source.includes("const previewTier = previewTiers[0]!"), "弹窗锁定快乐马预览档单档（不再复用主区 seedance 三级级联）");
  assert.ok(source.includes("renderTierSelects"), "主区生成档三级级联保留（弹窗改为快乐马单档 + 参数化控件）");
  assert.ok(source.includes("refsOk = refs.length >= 1 && refs.length <= 9"), "快乐马参考生视频硬约束 1–9 张（前端禁用闸 + 原因，撤销 v1.6.7 纯提示词即可预览）");
  assert.ok(source.includes("快乐马预览需至少 1 张参考图"), "无参考图禁用预览提交并给原因");
  assert.ok(source.includes("disabled: !refsOk || submitting"), "预览提交按钮：refs 闸 + 提交中禁用");
  assert.ok(source.includes("disabled: submitting || previewTiers.length === 0"), "预览入口按快乐马预览池启用");
  assert.ok(source.includes("当前没有可用的预览档（快乐马）"), "无预览档时禁用并说明原因");
  assert.ok(!source.includes("请先在配置页保存视频生成配置"), "未配置不再拦生成——出厂默认即可点（2026-08-19）");
  assert.ok(source.includes("pickLiteDefaultTier(videoTiers, config.strategy ?? null)"), "出厂默认 = 正式池最便宜档（dev=seedance 2.0/720p/9:16）");
  assert.ok(source.includes("video.preview ? h(\"span\", { className: \"text-warning\" }, \"· 预览\")"), "预览 chip 徽记（历史 metadata.preview 预览在弹窗内带徽记展示）");
  /* v1.7 参数化：快乐马预览三可调项 + 时长收敛 + 覆盖计价（矩阵常量 + 助手函数）。 */
  assert.ok(source.includes("HAPPYHORSE_PREVIEW_RATIOS.map"), "预览比例下拉 = 快乐马 9 种画幅（不含 adaptive）");
  assert.ok(source.includes("HAPPYHORSE_PREVIEW_RESOLUTIONS.map"), "预览清晰度下拉 = 快乐马 480p/720p/1080p");
  assert.ok(source.includes("setPreviewDuration(clampPreviewDuration(Number((event.target as HTMLInputElement).value), previewDuration))"), "时长输入收敛 3–15 整数秒");
  assert.ok(source.includes("previewEstimatePoints(previewTier, previewDuration)"), "预览估价按实际覆盖时长重算（不按档登记 5s 计价）");
  assert.ok(source.includes("const openPreviewDialog = useCallback"), "开窗时初始化预览参数（比例/清晰度/时长）");
  assert.ok(source.includes("本镜时长 ${shotDuration} 秒超出快乐马预览能力"), "分镜时长越界时给收敛提示");
  assert.ok(source.includes("tierModelLabel(previewTier)"), "模型只读展示（快乐马单档锁定，不做模型选择）");
  /* 2026-08-19 预览隔离：主区 videos 过滤预览台账命中的 generation_request_id，
     弹窗播放器/版本 chip 走 previewVideos（提交预览即入台账，出片落弹窗）。 */
  assert.ok(source.includes("readLitePreviewRequestIds(window.sessionStorage, shotId)"), "预览台账按镜读入（sessionStorage）");
  assert.ok(source.includes("rememberLitePreviewRequest(window.sessionStorage, shot.id, task.generation_request_id)"), "预览提交成功后请求 id 入台账");
  assert.ok(source.includes("allVideos.filter((video) => video.preview !== true && (!video.generation_request_id || !previewRequestIds.has(video.generation_request_id)))"), "主区 videos 排除预览版：metadata.preview 历史预览或台账命中请求（无 requestId 的素材条目保留）");
  assert.ok(source.includes("allVideos.filter((video) => video.preview === true || (video.generation_request_id != null && previewRequestIds.has(video.generation_request_id)))"), "previewVideos = 台账命中的版本或历史 preview 标记（仅弹窗展示）");
  assert.ok(source.includes("previewVideos.find((video) => video.id === selectedPreviewVideoId) ?? previewVideos[previewVideos.length - 1] ?? null"), "弹窗播放器目标 = 所选预览版 → 最新预览版（无预览 = null 空态）");
  assert.ok(!source.includes("?? selectedVideo ?? currentVideo"), "无预览版不回落到主区正式版（预览/正式分离，v1.7）");
  assert.ok(source.includes("previewVideos.map((video) => renderPreviewChip(video, video.id === target?.id))"), "弹窗版本 chip 只列预览版并可在窗内切换");
  assert.ok(source.includes("暂无预览版本，点「生成预览」出一版"), "无预览时空态提示");
  assert.ok(source.includes("preview: preview || undefined"), "任务对象带 preview 标记（settle 提示分流）");
  assert.ok(source.includes("tracked.preview ? \"预览视频已生成，在预览弹窗查看\""), "预览出片提示指向弹窗，不指主区播放器");
  const tiers = readFileSync(new URL("./capability-tiers.ts", import.meta.url), "utf8");
  assert.ok(tiers.includes("export function isPreviewTier"), "预览档识别函数在共享模块");
  assert.ok(tiers.includes("tier.params.preview === true"), "识别键 = params.preview===true");
});

/* ============================================================
   纯函数：分镜编码 + 快照投影
   ============================================================ */

const S = { shot_no: "3" } as Shot;
const EP = { episode_no: 2 } as Episode;
const SCENE = { name: "旧宅门口" } as Scene;

test("shotCode：{集号}-{镜号}-{场景短名}（悬停/面包屑/版本弹窗标题用）", () => {
  assert.equal(shotCode(S, EP, SCENE), "2-3-旧宅门口");
});

test("shotCode：场景短名去掉「第N集」类前缀后取前 6 字", () => {
  const scene = { name: "第2集-别墅" } as Scene;
  assert.equal(shotCode(S, EP, scene), "2-3-别墅");
});

test("shotCode：无场景/无集时省略对应段", () => {
  assert.equal(shotCode(S, EP, null), "2-3");
  assert.equal(shotCode(S, null, SCENE), "3-旧宅门口");
});

test("displaySnapshots：pending 与坏行不入投影清单（未命中真实分镜不参与生成与展示）", () => {
  const snapshots: ShotAssetSnapshot[] = [
    { asset_entity_id: "a1", variant_id: "v1", name: "任天野", matched_by: "exact_name", status: "bound" },
    { asset_entity_id: "a2", variant_id: null, name: "待绑定", matched_by: "manual", status: "pending" },
    { asset_entity_id: "", variant_id: null, name: "坏行", matched_by: "manual", status: "bound" },
    { asset_entity_id: "a3", variant_id: "v3", name: "林晚", matched_by: "manual", status: "bound" },
  ];
  assert.deepEqual(displaySnapshots(snapshots).map((item) => item.asset_entity_id), ["a1", "a3"]);
  assert.deepEqual(displaySnapshots(null), []);
  assert.deepEqual(displaySnapshots(undefined), []);
});

test("displaySnapshots：按 (asset, variant) 去重——同变体 auto/manual 只出一行，资产级与变体级各自成行（2026-08-19 二次裁定）", () => {
  const snapshots: ShotAssetSnapshot[] = [
    { asset_entity_id: "a1", variant_id: "v1", name: "aily", matched_by: "exact_name", status: "bound" },
    { asset_entity_id: "a1", variant_id: "v1", name: "aily", matched_by: "manual", status: "bound" },
    { asset_entity_id: "a1", variant_id: "v2", name: "aily", matched_by: "manual", status: "bound" },
    { asset_entity_id: "a1", variant_id: null, name: "aily", matched_by: "manual", status: "bound" },
    { asset_entity_id: "a2", variant_id: null, name: "林晚", matched_by: "manual", status: "bound" },
  ];
  const out = displaySnapshots(snapshots);
  assert.deepEqual(
    out.map((item) => `${item.asset_entity_id}::${item.variant_id ?? "asset"}`),
    ["a1::v1", "a1::v2", "a1::asset", "a2::asset"],
    "按 (asset, variant) 成行：同变体合并一行，不同变体与资产级各自成行（首见序）",
  );
  assert.equal(out[0]?.matched_by, "manual", "同 (asset, variant) 保留 manual（用户确认）行");
  assert.equal(out[2]?.variant_id, null, "资产级引用独立成行，不被变体行顶替（不默认选中用户没选过的变体）");
});

test("displaySnapshots：同资产有变体行时自动匹配的资产级行冗余丢弃——消除「一个自动匹配一个手动关联」两行（2026-08-19 三次裁定）", () => {
  const snapshots: ShotAssetSnapshot[] = [
    { asset_entity_id: "a1", variant_id: null, name: "Elara", matched_by: "exact_name", status: "bound" },
    { asset_entity_id: "a1", variant_id: "v1", name: "Elara", matched_by: "manual", status: "bound" },
    { asset_entity_id: "a2", variant_id: null, name: "林晚", matched_by: "exact_name", status: "bound" },
    { asset_entity_id: "a3", variant_id: null, name: "Aaric", matched_by: "manual", status: "bound" },
    { asset_entity_id: "a3", variant_id: "v9", name: "Aaric", matched_by: "manual", status: "bound" },
  ];
  const out = displaySnapshots(snapshots);
  assert.deepEqual(
    out.map((item) => `${item.asset_entity_id}::${item.variant_id ?? "asset"}`),
    ["a1::v1", "a2::asset", "a3::asset", "a3::v9"],
    "a1 自动资产级行被丢弃（已有变体行）；a2 无变体行保留自动资产级；a3 手动资产级保留",
  );
});

test("validSnapshots：只滤 pending/坏行，不去重——弹窗种子按 (asset, variant) 保留全部引用", () => {
  const snapshots: ShotAssetSnapshot[] = [
    { asset_entity_id: "a1", variant_id: "v1", name: "aily", matched_by: "exact_name", status: "bound" },
    { asset_entity_id: "a1", variant_id: "v2", name: "aily", matched_by: "exact_name", status: "bound" },
    { asset_entity_id: "a1", variant_id: null, name: "aily", matched_by: "manual", status: "bound" },
    { asset_entity_id: "a2", variant_id: null, name: "林晚", matched_by: "manual", status: "pending" },
    { asset_entity_id: "", variant_id: null, name: "坏行", matched_by: "manual", status: "bound" },
  ];
  const out = validSnapshots(snapshots).map((item) => `${item.asset_entity_id}::${item.variant_id ?? "asset"}`);
  assert.deepEqual(out, ["a1::v1", "a1::v2", "a1::asset"], "资产级 + 变体级 + 多变体全部保留，仅 pending/坏行剔除");
  assert.deepEqual(validSnapshots(null), []);
  assert.deepEqual(validSnapshots(undefined), []);
});

/* ============================================================
   纯函数：selection_source 读法 + 当前版选择 + metadata wire
   ============================================================ */

function media(id: string, isPrimary: boolean, createdAt: string): MediaVersion {
  return { id, media_kind: "video", version_no: 1, is_primary: isPrimary, created_at: createdAt } as MediaVersion;
}

test("shotVideoSelectionSource：wire 显式 manual / latest_default 直接读", () => {
  const manual = { id: "m1", is_primary: true, selection_source: "manual" } as unknown as MediaVersion;
  assert.equal(shotVideoSelectionSource(manual, []), "manual");
  const latest = { id: "m2", is_primary: false, selection_source: "latest_default" } as unknown as MediaVersion;
  assert.equal(shotVideoSelectionSource(latest, []), "latest_default");
});

test("shotVideoSelectionSource：wire 缺失回落 is_primary → manual", () => {
  assert.equal(shotVideoSelectionSource(media("m1", true, "2026-08-10T08:00:00.000Z"), []), "manual");
});

test("shotVideoSelectionSource：wire 缺失、非定稿且是最新 → latest_default；否则 null", () => {
  const older = media("m-old", false, "2026-08-10T08:00:00.000Z");
  const newer = media("m-new", false, "2026-08-10T09:00:00.000Z");
  assert.equal(shotVideoSelectionSource(newer, [older, newer]), "latest_default", "最新版 = 默认(最新)");
  assert.equal(shotVideoSelectionSource(older, [older, newer]), null, "非最新非定稿 = 非当前版");
});

test("currentVideoOf：定稿优先，无定稿取最新（按 created_at）", () => {
  const v1 = media("v1", false, "2026-08-10T08:00:00.000Z");
  const v2 = media("v2", true, "2026-08-10T09:00:00.000Z");
  const v3 = media("v3", false, "2026-08-10T10:00:00.000Z");
  assert.equal(currentVideoOf([v1, v2, v3])?.id, "v2", "定稿优先");
  assert.equal(currentVideoOf([v1, v3])?.id, "v3", "无定稿取最新");
  assert.equal(currentVideoOf([]), null);
});

test("liteShotMeta：wire 嵌套 lite.shot 优先，平铺兜底，无 metadata → undefined", () => {
  const nested = { id: "s", metadata: { lite: { shot: { atmosphere: "压抑", prompt_locked: true } } } } as unknown as Shot;
  assert.deepEqual(liteShotMeta(nested), { atmosphere: "压抑", prompt_locked: true });
  const flat = { id: "s", metadata: { atmosphere: "紧张" } } as Shot;
  assert.deepEqual(liteShotMeta(flat), { atmosphere: "紧张" });
  assert.equal(liteShotMeta(null), undefined);
});

test("liteShotMetadataPatch：按后端 zod 形状构造嵌套 metadata.lite.shot", () => {
  assert.deepEqual(liteShotMetadataPatch({ prompt_locked: true }), { metadata: { lite: { shot: { prompt_locked: true } } } });
  assert.deepEqual(liteShotMetadataPatch({ atmosphere: "压抑", dialogue: null }), { metadata: { lite: { shot: { atmosphere: "压抑", dialogue: null } } } });
});

test("buildPromptDescription：内容 = 左栏全字段（场景 + 剧本原文 + 对白 + 动作 + 时长）；空字段不占位", () => {
  const shot = {
    id: "s",
    script_text: "林晚：你怎么会在这里？",
    breakdown_elements: { subject: null, action: "林晚后退半步", visual: null, camera_language: null },
    duration_seconds: 4,
    metadata: { lite: { shot: { dialogue_note: "林晚压低声音质问" } } },
  } as unknown as Shot;
  const text = buildPromptDescription(shot, "旧宅门口");
  assert.equal(text, [
    "场景：旧宅门口",
    "剧本原文：林晚：你怎么会在这里？",
    "对白：林晚压低声音质问",
    "动作：林晚后退半步",
    "时长：4 秒",
  ].join("\n"));
  assert.equal(buildPromptDescription({ id: "s", script_text: "" } as Shot, null), "", "无任何左栏字段 → 空描述");
  assert.equal(buildPromptDescription({ id: "s", script_text: "  旁白：夜。  " } as Shot, null), "剧本原文：旁白：夜。", "原文去首尾空白并带标签");
});

/* ============================================================
   组件级：demo 模式渲染布局
   ============================================================ */

const TEST_USER = { id: "user-lite-1", username: "lite-tester", display_name: "精简版测试员", ui_mode: "lite" as const };
const READY_CAPS = { status: "ready" as const, capabilities: { platformRole: "member" as const, allowMemberCreateProject: true, projects: [], permissions: [] as string[] } };

function mount(node: Parameters<ReturnType<typeof createRoot>["render"]>[0]): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  return { container: container as HTMLElement, unmount: () => act(() => root.unmount()) };
}

function findButton(container: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((el) => el.textContent?.trim() === label);
}

test("LiteShell：lite/full 用户在项目内与项目列表都能双向切换", () => {
  for (const projectId of ["demo-lite-project", null]) {
    let liteSwitches = 0;
    const liteShell = mount(createElement(LiteShell, {
      pathname: projectId ? `/lite/projects/${projectId}/workspace` : "/lite/projects",
      projectId,
      demoMode: true,
      user: TEST_USER,
      switching: false,
      onSwitchUiMode: () => { liteSwitches += 1; },
    }));
    const toFull = findButton(liteShell.container, "完整版");
    assert.ok(toFull, `lite 用户在${projectId ? "项目内" : "项目列表"}缺「完整版」入口`);
    act(() => { toFull.click(); });
    assert.equal(liteSwitches, 1);
    liteShell.unmount();

    const fullShell = mount(createElement(LiteShell, {
      pathname: projectId ? `/lite/projects/${projectId}/workspace` : "/lite/projects",
      projectId,
      demoMode: true,
      user: { ...TEST_USER, ui_mode: "full" as const },
      switching: false,
      onSwitchUiMode: () => {},
    }));
    assert.ok(findButton(fullShell.container, "精简版"), `full 用户在${projectId ? "项目内" : "项目列表"}缺「精简版」入口`);
    fullShell.unmount();
  }
});

function mountDetail(demoMode: boolean, notify: (message: string, kind?: "info" | "success" | "error") => void = () => {}): { container: HTMLElement; unmount: () => void } {
  return mount(createElement(LiteShotDetailPage, {
    demoMode,
    notify,
    user: TEST_USER,
    capabilities: READY_CAPS,
    projectId: demoMode ? "demo-lite-project" : PROJECT_ID,
    shotId: demoMode ? "demo-lite-shot-1" : SHOT_ID,
  }));
}

test("渲染（demo）：左右分栏工作台齐全，tab 上壳顶栏，反馈⑤编辑区缺席，demo 数据渲染、零网络请求", async () => {
  const { container, unmount } = mountDetail(true);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const text = container.textContent ?? "";
  /* v1.6 追加：分镜切换 tab 上壳顶栏，页内不再渲染；「已自动保存」2026-08-18 退役 */
  assert.ok(container.querySelector('nav[aria-label="同集分镜"]') === null, "页内不再渲染同集分镜 tab 条");
  assert.ok(!text.includes("已自动保存"), "「已自动保存」退役，页内缺席");
  const shell = mount(createElement(LiteShell, {
    pathname: "/lite/projects/demo-lite-project/shots/demo-lite-shot-1",
    projectId: "demo-lite-project",
    demoMode: true,
    user: TEST_USER,
    switching: false,
    onSwitchUiMode: () => {},
  }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const shellText = shell.container.textContent ?? "";
  assert.ok(!shellText.includes("已自动保存"), "壳顶栏「已自动保存」指示退役（2026-08-18）");
  const tabs = [...shell.container.querySelectorAll('nav[aria-label="同集分镜"] button')].map((el) => el.textContent?.trim() ?? "");
  assert.deepEqual(tabs, ["1", "2"], "壳顶栏 tab = 排序位序号（高亮不带 ● 圆点）");
  const firstTab = shell.container.querySelector('nav[aria-label="同集分镜"] button');
  assert.ok(firstTab?.getAttribute("title")?.includes("1-3-旧宅门口"), "完整场记编码进悬停 title");
  shell.unmount();
  assert.ok(!text.includes("查看全本"), "「查看全本」按钮退役（2026-08-18）");
  /* 左栏：已选资产（快照投影 + 类型徽记） */
  assert.ok(text.includes("已选资产"), "已选资产区");
  assert.ok(text.includes("任天野"), "引用资产名");
  assert.ok(text.includes("旧宅铁门"), "引用资产名");
  assert.ok(text.includes("角色"), "类型徽记：角色");
  assert.ok(text.includes("道具"), "类型徽记：道具");
  assert.ok(text.includes("自动匹配"), "来源徽记");
  assert.ok(!text.includes("自动匹配（一键生成本集）"), "来源徽记不再带「一键生成本集」（v1.6 反馈②）");
  assert.ok(text.includes("匹配+选择"), "加/改入口「匹配+选择」跳素材页");
  /* 左栏：分镜内容（反馈③④⑤） */
  assert.ok(text.includes("剧本原文"), "剧本原文区");
  const scriptArea = container.querySelector("textarea");
  assert.ok(scriptArea && scriptArea.value.includes("林晚：你怎么会在这里？"), "剧本原文可编辑 textarea 带初值");
  assert.ok(text.includes("场景"), "场景输入框文案");
  assert.ok([...container.querySelectorAll("input")].some((el) => el.value === "旧宅门口"), "场景输入框回显当前场景名");
  assert.ok(text.includes("对白"), "对白字段在场（v1.7）");
  assert.ok(text.includes("动作"), "动作字段在场（v1.7）");
  assert.ok([...container.querySelectorAll("input")].some((el) => el.value === "从夜色中走出"), "动作输入框回显 breakdown_elements.action");
  assert.ok(!text.includes("镜头描述"), "拆解四字段编辑区缺席");
  assert.ok(!text.includes("结构化对白"), "结构化对白区缺席");
  /* 右栏：视频版本 */
  assert.ok(text.includes("视频版本"), "视频版本区");
  assert.ok(text.includes("当前版 v2"), "当前版徽章（定稿 v2）");
  assert.ok(text.includes("雨夜版"), "版本标签展示");
  /* 右栏：视频提示词 + 生成 */
  assert.ok(text.includes("视频提示词"), "视频提示词区");
  assert.ok(text.includes("AI 生成"), "AI 草稿按钮");
  assert.ok(text.includes("生成视频"), "生成按钮文案在场");
  assert.ok(!text.includes("生成视频（1 次任务）"), "生成按钮不带「一次任务」后缀（2026-08-19 裁定）");
  /* 右栏：生成视频档三级级联（v1.6 反馈③：模型/比例/清晰度本镜可选） */
  const selects = [...container.querySelectorAll("select")];
  assert.ok(selects.length >= 3, "模型/比例/清晰度三个选择器在场");
  assert.ok(text.includes("Seedance 2.0 Fast"), "模型选择器显示当前档模型");
  assert.ok(text.includes("9:16"), "比例选择器取值");
  assert.ok(text.includes("720p"), "清晰度选择器取值");
  assert.ok(text.includes("80 积分/秒"), "档价如实展示，不虚构");
  /* 左栏：已选资产列表固定高度内部滚动（v1.6 反馈②） */
  assert.ok(container.querySelector(".max-h-48.overflow-y-auto") !== null, "资产列表包在固定高度滚动容器里");
  assert.ok(text.includes("2 个"), "已选资产计数徽记");
  /* 播放器 src = 当前版；容器高度有上限（反馈⑥） */
  const video = container.querySelector("video");
  assert.ok(video, "有 <video> 播放器");
  assert.ok(video!.getAttribute("src")?.endsWith("demo-video-2.mp4"), "播放器播当前版 v2");
  assert.ok(video!.closest(".h-40") !== null, "播放器包在固定高度容器里（小屏 h-40）");
  unmount();
});

test("渲染（demo）：点「生成视频」在离线模式下只提示、不发起真实请求", async () => {
  const notices: string[] = [];
  const { container, unmount } = mountDetail(true, (message) => notices.push(message));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { findButton(container, "生成视频")!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.ok(notices.some((message) => message.includes("离线演示")), "离线演示不发起真实生成");
  unmount();
});

/* ============================================================
   真栈（fetch 全 mock）：整条重做 quote→confirm→create 三段式
   ============================================================ */

const PROJECT_ID = "proj-lite-detail-1";
const EPISODE_ID = "ep-lite-detail-1";
const SHOT_ID = "shot-lite-detail-1";
const SCENE_ID = "scene-lite-1";
const SNAPSHOT_ASSET_ID = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT_VARIANT_ID = "22222222-2222-4222-8222-222222222222";
const MEDIA_V1 = "mr-vid-1";
const MEDIA_V2 = "mr-vid-2";

const calls: Array<{ method: string; path: string; body: unknown }> = [];
let estimateBody: Record<string, unknown> | null = null;
let createGenerationBody: Record<string, unknown> | null = null;

const VIDEO_TIER_RAW = {
  tier_id: "vid-tier-1",
  media_type: "video",
  display_name: "Seedance 2.0 Fast",
  provider_label: "火山方舟",
  model_label: "视频模型",
  params: { aspect_ratio: "9:16", resolution: "720p", duration_seconds: 4 },
  price: { unit: "per_second", points: 80 },
  status: "active",
};

/* v1.6.8：真栈 mock 同步生产形状——视频档表同时有 seedance（火山方舟）与快乐马预览档
   （provider_label=阿里云百炼，params.preview=true）；正式池=seedance，预览池=快乐马，
   互斥切分。 */
const PREVIEW_TIER_RAW = {
  tier_id: "vid-preview-1",
  media_type: "video",
  display_name: "HappyHorse 1.1 预览",
  provider_label: "阿里云百炼",
  model_label: "快乐马",
  params: { aspect_ratio: "9:16", resolution: "480p", duration_seconds: 5, watermark: false, preview: true },
  price: { unit: "per_second", points: 8 },
  status: "active",
};

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ ok: true, data }),
    blob: async () => new Blob(),
  } as unknown as Response;
}

function route(method: string, path: string): unknown {
  if (method === "GET" && path === `/projects/${PROJECT_ID}`) return { id: PROJECT_ID, name: "测试项目", lite_episode_id: EPISODE_ID };
  if (method === "GET" && path === `/projects/${PROJECT_ID}/episodes`) {
    return { items: [{ id: EPISODE_ID, project_id: PROJECT_ID, episode_no: 2, name: "测试第二集" }], count: 1 };
  }
  if (method === "GET" && path === `/episodes/${EPISODE_ID}/shots`) {
    return { items: [{ id: SHOT_ID, episode_id: EPISODE_ID, shot_no: "3", title: "测试镜", scene_id: SCENE_ID, sort_order: 3 }], count: 1 };
  }
  if (method === "GET" && path === `/shots/${SHOT_ID}`) {
    return {
      id: SHOT_ID,
      episode_id: EPISODE_ID,
      shot_no: "3",
      title: "测试镜",
      scene_id: SCENE_ID,
      script_text: "林晚：你怎么会在这里？",
      breakdown_elements: { subject: "任天野", action: "走出", visual: "旧宅门口", camera_language: "中景" },
      duration_seconds: 4,
      video_prompt: "夜色中任天野走出。",
      metadata: { atmosphere: "压抑", dialogue: { lines: [{ speaker: "林晚", text: "你怎么会在这里？" }] }, prompt_locked: false },
      sort_order: 3,
      /* v1.5.1：Lite 引用真值随 shot 下发（toShot 透传）——服务端生成时自动解析。 */
      reference_asset_snapshots: [
        { asset_entity_id: SNAPSHOT_ASSET_ID, variant_id: SNAPSHOT_VARIANT_ID, name: "任天野", asset_kind: "character", matched_by: "exact_name", status: "bound" },
      ],
    };
  }
  if (method === "GET" && path === `/episodes/${EPISODE_ID}/scenes`) {
    return { items: [{ id: SCENE_ID, episode_id: EPISODE_ID, name: "旧宅门口" }], count: 1 };
  }
  if (method === "GET" && path === `/shots/${SHOT_ID}/media`) {
    return {
      items: [
        { id: MEDIA_V1, media_kind: "video", version_no: 1, version_label: null, is_primary: false, storage_url: "https://storage.example/v1.mp4", duration_seconds: 4, created_at: "2026-08-10T08:00:00.000Z", persistence_status: "persisted" },
        { id: MEDIA_V2, media_kind: "video", version_no: 2, version_label: null, is_primary: true, storage_url: "https://storage.example/v2.mp4", duration_seconds: 4, created_at: "2026-08-10T09:00:00.000Z", persistence_status: "persisted" },
      ],
      count: 2,
    };
  }
  if (method === "GET" && path.startsWith("/generation/capability-tiers")) {
    return { tiers: [VIDEO_TIER_RAW, PREVIEW_TIER_RAW] };
  }
  if (method === "GET" && path === `/projects/${PROJECT_ID}/generation-defaults/video`) {
    return { id: "gd-vid", project_id: PROJECT_ID, media_kind: "video", mode: "material_to_prompt", model_key: "vid-tier-1", parameters: { resolution: "720p", ratio: "9:16", duration_seconds: 4, prompt_template_id: "tpl-vid-1" }, version: 1 };
  }
  if (method === "GET" && path === `/projects/${PROJECT_ID}/prompt-templates?media_kind=video`) {
    return { items: [{ id: "tpl-vid-1", project_id: PROJECT_ID, media_kind: "video", name: "视频模板", content: "模板正文：跟随人物动作。", created_by_user_id: "u", created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" }], count: 1 };
  }
  if (method === "POST" && path === "/generations/estimate") return { generation_quote_id: "quote-detail-1" };
  if (method === "POST" && path === "/generation-quotes/quote-detail-1/confirm") return { generation_quote_id: "quote-detail-1" };
  if (method === "POST" && path === "/generations") {
    return { generation_request_id: "gen-req-new", status: "pending", created_at: "2026-08-10T10:00:00.000Z" };
  }
  /* 轮询：恒 pending（进行中）→ 任务卡保持 active、台账不清空，供断言幂等键。 */
  if (method === "GET" && path.startsWith("/generations/gen-req-new")) {
    return { generation_request_id: "gen-req-new", status: "pending", created_at: "2026-08-10T10:00:00.000Z" };
  }
  return undefined;
}

async function respond(input: unknown, init?: { method?: string; headers?: unknown; body?: unknown }): Promise<Response> {
  const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? "");
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/api\/v1/, "") || "/";
  let body: unknown;
  if (typeof init?.body === "string") {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  calls.push({ method, path, body });
  if (method === "POST" && path === "/generations/estimate") estimateBody = body as Record<string, unknown>;
  if (method === "POST" && path === "/generations") createGenerationBody = body as Record<string, unknown>;
  const data = route(method, path);
  assert.notEqual(data, undefined, `fetch mock 未覆盖：${method} ${path}`);
  return jsonResponse(data);
}

const inflight = new Set<Promise<unknown>>();
let issuedRequests = 0;
(globalThis as Record<string, unknown>).fetch = (input: unknown, init?: { method?: string; headers?: unknown; body?: unknown }): Promise<Response> => {
  issuedRequests += 1;
  const pending = respond(input, init);
  inflight.add(pending);
  void pending.catch(() => {}).finally(() => inflight.delete(pending));
  return pending;
};

const SETTLE_ROUND_CAP = 50;
async function settle(): Promise<void> {
  for (let round = 0; round < SETTLE_ROUND_CAP; round += 1) {
    const issuedBefore = issuedRequests;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.allSettled([...inflight]);
    });
    if (inflight.size === 0 && issuedRequests === issuedBefore) return;
  }
  assert.fail(`请求链停不下来（${SETTLE_ROUND_CAP} 轮仍在发新请求）`);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  await settle();
  assert.ok(predicate(), `请求全部落地后仍不满足：${label}`);
}

test("生成视频（真栈）：一次点击走完 estimate → create(auto_confirm)，请求体含幂等键/模板补充段；不手传 references（服务端按 shot_id 自动解析快照）", async () => {
  window.sessionStorage.setItem("shortdrama_v01_token", "lite-test-token");
  const notices: string[] = [];
  const { container, unmount } = mountDetail(false, (message) => notices.push(message));
  try {
    const submitButton = (): HTMLButtonElement | undefined => findButton(container, "生成视频");
    await waitFor(() => {
      const button = submitButton();
      return button !== undefined && !button.disabled;
    }, "生成按钮就绪（配置+数据加载完成）");

    /* v1.5.1：已选资产来自 shot 的 reference_asset_snapshots，不单独拉 asset-refs */
    assert.ok(container.textContent?.includes("任天野"), "快照投影出资产名");
    assert.ok(!calls.some((call) => call.path.includes("asset-refs")), "不请求 shot_asset_refs 端点（8.9）");

    const before = calls.length;
    await act(async () => { submitButton()!.click(); });
    await waitFor(() => container.textContent?.includes("视频生成中…") === true, "任务卡出现（提交落地）");

    /* 两段式顺序：estimate → create（v1.9 十.7：确认并入 submit 的 auto_confirm） */
    const batch = calls.slice(before);
    const estimate = batch.find((call) => call.method === "POST" && call.path === "/generations/estimate");
    const create = batch.find((call) => call.method === "POST" && call.path === "/generations");
    assert.ok(estimate, "① 估价请求发出");
    assert.ok(create, "② 创建任务发出");
    assert.ok(batch.indexOf(estimate!) < batch.indexOf(create!), "创建在估价之后");

    const telemetry = batch.find((call) => {
      const body = call.body;
      return call.method === "POST"
        && call.path === "/events"
        && body !== null
        && typeof body === "object"
        && "event" in body
        && body.event === "lite_generation_submitted";
    });
    assert.ok(telemetry, "③ Lite 生成提交埋点发出");
    const telemetryBody = telemetry?.body;
    assert.ok(telemetryBody && typeof telemetryBody === "object" && "ts" in telemetryBody && typeof telemetryBody.ts === "number");
    assert.deepEqual(telemetryBody, {
      event: "lite_generation_submitted",
      props: {
        project_id: PROJECT_ID,
        episode_id: EPISODE_ID,
        shot_id: SHOT_ID,
        request_id: "gen-req-new",
        media_kind: "video",
        preview: false,
      },
      ts: telemetryBody.ts,
    });
    const createBody = createGenerationBody;
    assert.equal(createBody?.auto_confirm, true, "v1.9 十.7：提交带 auto_confirm");

    /* 请求体 */
    assert.ok(estimateBody, "捕获 estimate 请求体");
    assert.equal(estimateBody!.media_kind, "video");
    assert.equal(estimateBody!.tier_id, "vid-tier-1", "档 id 整档透传（正式池=seedance；快乐马预览档 vid-preview-1 被池切分排除，不落正式请求）");
    assert.equal(estimateBody!.shot_id, SHOT_ID, "shot_id 透传——服务端据此自动解析快照参考");
    assert.ok(typeof estimateBody!.client_idempotency_key === "string" && (estimateBody!.client_idempotency_key as string).length > 0, "幂等键");
    assert.equal(estimateBody!.supplement_prompt, "模板正文：跟随人物动作。\n夜色中任天野走出。", "生效模板内容 + 本镜提示词拼补充段");
    assert.equal(estimateBody!.references, undefined, "不手传 references（resolveControlReferences 服务端解析）");
    assert.ok(createGenerationBody, "捕获 create 请求体");
    assert.equal(createGenerationBody!.generation_quote_id, "quote-detail-1", "创建带已确认的报价 id");

    /* 幂等键台账：提交前落 key，创建后补写 requestId */
    const marker = JSON.parse(window.sessionStorage.getItem(`lite-gen:${SHOT_ID}:video`) ?? "null") as { key: string; requestId?: string } | null;
    assert.ok(marker && marker.key, "台账落幂等键");
    assert.equal(marker!.requestId, "gen-req-new", "台账补写 requestId");

    /* 任务卡（requestId 展示截断前 8 位） */
    assert.ok(container.textContent?.includes("任务 gen-req-"), "任务卡展示 requestId 前缀");
    assert.ok(notices.some((message) => message.includes("视频生成任务已提交")), "成功后通知用户");
  } finally {
    unmount(); /* 无论断言成败都卸载：清掉轮询定时器，避免失败路径挂住进程 */
  }
});

/* Radix Dialog portal 进 document.body（dialog.tsx DialogContent → Portal），不在页 container
   内；预览弹窗交互统一查 document.body。 */
function findBodyButton(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find((el) => el.textContent?.trim() === label);
}

test("生成预览（真栈，v1.7 参数化）：弹窗锁定快乐马单档，比例/清晰度/时长可调（时长默认收敛本镜 4s），refs 1–9 闸放行，提交强制快乐马预览档并携带覆盖参数", async () => {
  /* 隔离：上一测试（正式生成）在 sessionStorage 留下本镜 video 台账（requestId=gen-req-new），
     挂载恢复效应会把它重新接回成进行中任务 → 闸会误拦预览提交。先清空再设 token。 */
  window.sessionStorage.clear();
  window.sessionStorage.setItem("shortdrama_v01_token", "lite-test-token");
  const notices: string[] = [];
  const { container, unmount } = mountDetail(false, (message) => notices.push(message));
  try {
    const previewButton = (): HTMLButtonElement | undefined => findButton(container, "预览视频");
    await waitFor(() => {
      const button = previewButton();
      return button !== undefined && !button.disabled;
    }, "预览按钮就绪（预览池非空 = 快乐马预览档在场）");
    await act(async () => { previewButton()!.click(); });
    await waitFor(() => findBodyButton("生成预览") !== undefined, "预览弹窗打开（portal 进 document.body）");
    const bodyText = document.body.textContent ?? "";
    assert.ok(bodyText.includes("预览仅支持快乐马"), "弹窗明示预览=快乐马/正式=Seedance");
    assert.ok(bodyText.includes("模型") && bodyText.includes("快乐马"), "模型只读展示（快乐马单档锁定，不做模型选择）");
    assert.ok(bodyText.includes("480p"), "预览清晰度下拉默认快乐马档注册值 480p（能力内可调）");
    assert.ok(bodyText.includes("9:16"), "预览比例下拉默认快乐马档注册值 9:16（能力内可调）");
    assert.ok(bodyText.includes("时长（秒）"), "时长输入框在弹窗（3–15 整数秒）");
    assert.ok(!bodyText.includes("超出快乐马预览能力"), "本镜 4 秒在 3–15 能力内，不出现收敛提示");
    assert.ok(bodyText.includes("约 32 积分"), "预览估价按覆盖时长 4s × 8 点/秒 = 32（不按档登记 5s 计 40）");
    assert.ok(bodyText.includes("暂无预览版本，点「生成预览」出一版"), "无预览版时播放器给空态（不回落到主区正式版）");
    assert.ok(bodyText.includes("参考资产：1 个"), "refs 计数展示（mock 快照 1 条）");
    const generatePreviewButton = findBodyButton("生成预览")!;
    assert.equal(generatePreviewButton.disabled, false, "refs=1（1–9 内）→ 提交按钮可点");
    const before = calls.length;
    await act(async () => { generatePreviewButton.click(); });
    await waitFor(() => notices.some((m) => m.includes("预览视频任务已提交")), "预览任务提交成功通知");
    const batch = calls.slice(before);
    const estimate = batch.find((call) => call.method === "POST" && call.path === "/generations/estimate");
    const create = batch.find((call) => call.method === "POST" && call.path === "/generations");
    assert.ok(estimate, "预览估价发出");
    assert.ok(create, "预览创建任务发出");
    assert.equal(estimateBody?.tier_id, "vid-preview-1", "预览提交强制快乐马预览档（正式档 vid-tier-1 不进预览链）");
    const estimateParams = (estimateBody?.parameters ?? {}) as Record<string, unknown>;
    assert.equal(estimateParams.preview, true, "预览身份来自快乐马档 params.preview=true，前端不再追加身份键");
    assert.equal(estimateParams.duration_seconds, 4, "覆盖时长 = 分镜时长收敛（4s）写入报价体，后端按覆盖值计价");
    assert.equal(estimateParams.resolution, "480p", "覆盖清晰度透传报价体");
    assert.equal(estimateParams.ratio, "9:16", "覆盖比例透传报价体");
    const previewSet = JSON.parse(window.sessionStorage.getItem(`lite:preview-video-request:${SHOT_ID}`) ?? "null") as unknown;
    assert.ok(Array.isArray(previewSet) && previewSet.includes("gen-req-new"), "预览提交成功后请求 id 入本镜预览台账");
  } finally {
    unmount();
  }
});
