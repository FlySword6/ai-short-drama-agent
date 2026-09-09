/* ============================================================
   lite-asset-detail-page.test.ts — Phase 2 详情页纯逻辑测试

   口径锁定(第二阶段):
   - 独立路由页面(非抽屉):/lite/projects/:id/assets/:assetEntityId
   - 左右分栏工作台(§4.4.2):页顶动作位(2026-08-17 页头退役:‹ 返回素材 + 资产名上壳单条,页内只留「新建资产」;v1.8 九.3 由「管理图片」改名,行为不变) / 内容区左 flex-[2] 主图+变体网格 / 右 flex-[3] 信息面板+出现记录+版本轨
   - lightbox:边界 clamp(不循环)、Esc/◀▶ 键盘导航
   - 变体默认选中(契约 v1.3):默认第一个变体(非「全部」),空 → null
   - 「设为主图」按钮:非主图 + 有可用 ID(上传图 asset_media_id / 生成图 media_result_id)
   - 身份字段:null/空 → 短横占位

   不导入 .tsx(无 jsdom 会触发 React 组件评估挂起),
   纯函数复制同口径,结构断言用源码扫描。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./pages/lite/lite-asset-detail-page.tsx", import.meta.url), "utf8");

// ---- 纯函数(复制自 lite-asset-detail-page.tsx 同口径) ----

/** lightbox 索引导航:边界 clamp(不循环),空列表或 null 返回 null。 */
function navigateLightbox(length: number, index: number | null, delta: number): number | null {
  if (length === 0 || index === null) return null;
  const next = index + delta;
  return next >= 0 && next < length ? next : index;
}

/** 变体默认选中:契约 v1.3 默认选第一个变体(非「全部」),空列表返回 null。 */
function pickDefaultVariant<T extends { is_primary: boolean; variant_id: string }>(variants: T[]): string | null {
  return variants[0]?.variant_id ?? null;
}

/** 「设为主图」按钮显示条件:非主图 + 有可用 ID(上传图 asset_media_id / 生成图 media_result_id 均可翻转)。 */
function canSetAsPrimary(item: { is_primary: boolean; asset_media_id: string | null; media_result_id: string | null }): boolean {
  return !item.is_primary && (item.asset_media_id !== null || item.media_result_id !== null);
}

/** 身份信息字段的展示值:null/空 → 短横占位。 */
function identityDisplay(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

interface TestVariant { is_primary: boolean; variant_id: string }

/* ---------- 左右分栏工作台结构断言 ---------- */

test("T4.1 工作台:页头 + 内容区左右分栏 + 版本轨结构(§4.4.2)", () => {
  assert.ok(source.includes('flex-[2]'), "内容区左侧应占 2 份(主图+变体网格)");
  assert.ok(source.includes('flex-[3]'), "内容区右侧应占 3 份(信息面板)");
  assert.ok(source.includes('border-l border-border-1'), "右栏应有 border-l 分隔");
  assert.ok(source.includes("versionTrack") || source.includes("版本图轨"), "应有版本图轨");
  assert.ok(source.includes("overflow-x-auto"), "版本图轨应横向滚动");
});

test("T4.1 工作台:返回按钮上壳单条(2026-08-17),页内 goBack 供 Esc/错误态使用", () => {
  const shell = readFileSync(new URL("./pages/lite/lite-shell.tsx", import.meta.url), "utf8");
  assert.ok(shell.includes("返回素材"), "壳单条应有‹ 返回素材(资产详情)");
  assert.ok(shell.includes("返回素材列表"), "壳单条返回 title 指明回素材列表");
  assert.ok(source.includes("window.history.back()"), "应优先历史返回");
  assert.ok(source.includes("liteProjectPath(projectId, \"assets\")"), "无历史时回落到 assets 列表页");
  assert.ok(source.includes("function goBack"), "应有 goBack 组件(Esc 返回上一级)");
});

test("T4.1 工作台:Esc 返回上一级(keydown listener)", () => {
  assert.ok(source.includes("Escape"), "应有 Escape 键监听");
  assert.ok(source.includes("addEventListener"), "应有 keydown 事件监听");
});

test("T4.1 工作台:点击遮罩关闭(target === currentTarget)", () => {
  assert.ok(source.includes("e.target === e.currentTarget"), "点击遮罩应关闭");
});

test("T4.1 工作台:左 2 份主图 + 右 3 份信息面板", () => {
  assert.ok(source.includes("flex-[2]"), "主区左侧应占 2 份");
  assert.ok(source.includes("flex-[3]"), "主区右侧应占 3 份");
});

/* ---------- 空状态 ---------- */

test("T4.4/v1.9 空状态与动作位:无图占位仍在;资产级删除收口到素材列表资产卡(十.8),详情页不设;变体删除入口常驻", () => {
  assert.ok(source.includes("ImageSquare"), "应引用图片占位图标");
  assert.ok(source.includes("还没有图片"), "无图时应显示空态占位文案");
  assert.ok(source.includes("删除资产入口收口到素材列表资产卡"), "v1.9 十.8:详情页不设资产级删除,收口到列表卡");
  assert.ok(!source.includes("handleDeleteAsset"), "详情页不应再有资产级删除 handler");
  assert.ok(source.includes("删除变体"), "v1.9 十.4:删除变体入口应常驻网格头");
  assert.ok(source.includes("setAddImageDialog"), "加图入口仍通过内部 state 管理弹窗 B");
  assert.ok(source.includes('mode: "add_image"'), "变体卡封面/加图应以 add_image 模式打开弹窗 B");
});

test("T4.4 空状态:信息面板展示 detail.name + detail.intro", () => {
  assert.ok(source.includes("detail.name"), "信息面板应展示资产名称");
  assert.ok(source.includes("detail.intro"), "信息面板应展示资产描述");
});

/* ---------- lightbox 导航纯函数 ---------- */

test("T4.5 lightbox:右越界 clamp 不循环(到最后一张右移停在原地)", () => {
  assert.equal(navigateLightbox(3, 2, 1), 2);
});

test("T4.5 lightbox:左越界 clamp 不循环(到第一张左移停在原地)", () => {
  assert.equal(navigateLightbox(3, 0, -1), 0);
});

test("T4.5 lightbox:正常右移", () => {
  assert.equal(navigateLightbox(5, 1, 1), 2);
});

test("T4.5 lightbox:正常左移", () => {
  assert.equal(navigateLightbox(5, 3, -1), 2);
});

test("T4.5 lightbox:空列表返回 null", () => {
  assert.equal(navigateLightbox(0, 0, 1), null);
});

test("T4.5 lightbox:index=null 返回 null", () => {
  assert.equal(navigateLightbox(5, null, 1), null);
});

test("T4.5 lightbox:DetailLightbox 组件层级 z-[70](覆盖层,高于页面内容)", () => {
  assert.ok(source.includes("z-[70]"), "lightbox 层级应为 z-[70]");
});

test("T4.5 lightbox:lightbox 内有键盘 ◀▶ + Esc 导航", () => {
  assert.ok(source.includes("ArrowLeft"), "应有 ArrowLeft 导航");
  assert.ok(source.includes("ArrowRight"), "应有 ArrowRight 导航");
});

/* ---------- 变体默认选中 ---------- */

test("T4.3 变体默认选中:契约 v1.3 有主变体也默认选第一个", () => {
  const variants: TestVariant[] = [
    { variant_id: "v1", is_primary: false },
    { variant_id: "v2", is_primary: true },
  ];
  assert.equal(pickDefaultVariant(variants), "v1");
});

test("T4.3 变体默认选中:无主变体 → 选第一个", () => {
  const variants: TestVariant[] = [
    { variant_id: "v1", is_primary: false },
    { variant_id: "v2", is_primary: false },
  ];
  assert.equal(pickDefaultVariant(variants), "v1");
});

test("T4.3 变体默认选中:空列表 → null", () => {
  assert.equal(pickDefaultVariant([]), null);
});

/* ---------- 设主图按钮条件 ---------- */

test("T4.2 canSetAsPrimary:非主图 + 有 asset_media_id → true", () => {
  assert.equal(canSetAsPrimary({ is_primary: false, asset_media_id: "am-1", media_result_id: null }), true);
});

test("T4.2 canSetAsPrimary:非主图生成图有 media_result_id → true", () => {
  assert.equal(canSetAsPrimary({ is_primary: false, asset_media_id: null, media_result_id: "mr-1" }), true);
});

test("T4.2 canSetAsPrimary:已是主图 → false", () => {
  assert.equal(canSetAsPrimary({ is_primary: true, asset_media_id: "am-1", media_result_id: null }), false);
});

test("T4.2 canSetAsPrimary:双 ID 均无 → false(无法翻转)", () => {
  assert.equal(canSetAsPrimary({ is_primary: false, asset_media_id: null, media_result_id: null }), false);
});

/* ---------- 身份字段展示 ---------- */

test("T4.6 identityDisplay:null → 短横占位", () => {
  assert.equal(identityDisplay(null), "—");
});

test("T4.6 identityDisplay:空串 → 短横占位", () => {
  assert.equal(identityDisplay(""), "—");
});

test("T4.6 identityDisplay:undefined → 短横占位", () => {
  assert.equal(identityDisplay(undefined), "—");
});

test("T4.6 identityDisplay:有值 → 原样返回", () => {
  assert.equal(identityDisplay("短发"), "短发");
  assert.equal(identityDisplay(25), "25");
  assert.equal(identityDisplay(168), "168");
});

/* ---------- 名称编辑 ---------- */

test("T4.7/T16.8 基础信息三字段一个表单:一次 PATCH name/intro/note(trim 后调 liteUpdateAsset),唯一一对保存/取消", () => {
  assert.ok(source.includes("async function saveBasicInfo"), "应有 saveBasicInfo 函数(三字段合并一次提交)");
  assert.ok(source.includes("basicDraft.name.trim()"), "名称应 trim 后保存");
  assert.ok(source.includes("liteUpdateAsset"), "应调 liteUpdateAsset");
  assert.ok(!source.includes("EditableTextRow"), "逐行编辑组件 EditableTextRow 应退役(v1.8 九.4a)");
});

test("T16.9 出现记录无变体下拉:新记录恒挂当前选中变体(回落第一个变体)", () => {
  assert.ok(!source.includes("资产级关联"), "不应再有「资产级关联(不指定变体)」下拉选项(v1.8 九.4b)");
  assert.ok(source.includes("selectedVariantId ?? variants[0]?.variant_id"), "新记录应挂当前选中变体并回落第一个变体");
});

test("T16.10 资产无变体时隐藏新增关联入口", () => {
  assert.ok(source.includes("variants.length > 0 ?"), "无变体时不渲染「+ 新增关联分镜」入口");
});

/* ---------- 契约 v1.3.1(问题三)出现记录不跳转 + 场景回显 ---------- */

test("T4.8 出现记录 bound 条目不跳转(契约 v1.3.1 六.4)", () => {
  assert.ok(!source.includes('navigate(liteProjectPath(projectId, "shots"'), "bound 条目不应对分镜页 navigate");
  assert.ok(source.includes('bound ? (\n                          <CheckCircle'), "bound 条目显示已绑定成功标记");
  assert.ok(source.includes('Badge tone="warning">待绑定</Badge>'), "未绑定仍显示待绑定徽记,bound 不跳转时仍为纯文本");
});

/* ---------- 契约 v1.3.1(问题二)add_image 首图落第一个变体 ---------- */

test("T4.8 add_image 停在「全部」时回落到第一个变体(契约 v1.3.1 六.3)", () => {
  assert.ok(source.includes("selectedVariantId ?? variants[0]?.variant_id"), "add_image 无选中变体时应回落到第一个变体");
});

test("T4.8/v2.4 源码:new_variant 预填按当前变体数决定(仅首变体 prefill)", () => {
  assert.ok(source.includes('setAddImageDialog({ source: "ai", mode: "new_variant" })'), "网格头「新建变体」以 new_variant 模式打开弹窗 B");
  assert.ok(source.includes("noExistingVariant={variants.length === 0}"), "详情页按当前变体数传 noExistingVariant,首变体才预填资产信息");
});

/* ---------- v1.4(问题七)大图区退役,看图统一走 lightbox ---------- */

test("T12.2 详情页无 sticky 主图大卡(契约 v1.4 七.2)", () => {
  assert.ok(!source.includes("aspect-[9/16]"), "sticky 主图大卡应整体移除");
  assert.ok(!source.includes("sticky top-0 z-10"), "主图大卡 sticky 容器应移除");
  assert.ok(source.includes("共 {variants.length} 个变体"), "网格区头应保留变体计数");
});

test("T12.3 看图走 lightbox:变体卡封面有图时点击打开 lightbox", () => {
  assert.ok(source.includes("点击查看大图"), "变体卡封面应有看图入口");
  assert.ok(source.includes("setLightboxIndex(idx)"), "封面点击应定位 lightbox 到该图");
});

test("T12.4 无图变体封面点击打开弹窗 B add_image 而非 lightbox(契约 v1.4 七.2)", () => {
  assert.ok(source.includes("还没有图片,点击添加"), "无图变体封面应引导加图");
  assert.ok(/if \(cover\) \{/.test(source), "封面点击按有图/无图分流");
  assert.ok(source.includes('setAddImageDialog({ source: "ai", mode: "add_image" })'), "无图封面应打开弹窗 B add_image");
});

test("T12.3 选中变体信息面板小封面进 lightbox(契约 v1.4 七.2)", () => {
  assert.ok(source.includes("选中变体小封面"), "信息面板顶部应有小封面缩略图");
});

/* ---------- 音频资产展示(2026-08-18) ---------- */

test("音频:详情页识别音频资产(isAudio),主标签/面板标题用音频口径", () => {
  assert.ok(source.includes('const isAudio = detail.asset_kind === "audio"'), "应有 isAudio 判定(资产类型=audio)");
  assert.ok(source.includes("主音频"), "音频资产应有「主音频」表述");
  assert.ok(source.includes("设为主音频"), "音频资产应有「设为主音频」动作");
});

test("音频:变体卡封面用 <audio> 渲染,点击打开音频 lightbox", () => {
  assert.ok(source.includes("<audio"), "音频变体卡应渲染 <audio> 元素");
  assert.ok(source.includes("isAudio ?"), "音频分支应以 isAudio 为门");
});

test("音频:选中变体信息面板小封面用 <audio> 播放", () => {
  const audioCount = (source.match(/<audio/g) || []).length;
  assert.ok(audioCount >= 2, `音频应至少两处 <audio>(变体卡 + 信息面板小封面),实际 ${audioCount}`);
});

test("音频:AI 生成信息 format 标注音频格式", () => {
  assert.ok(source.includes("format"), "生成信息应展示 format");
  assert.ok(source.includes("isAudio ?"), "format 展示应有音频分支");
});

test("音频:版本轨展示 media_kind + format(数据面见 api.ts liteListVersionTrack)", () => {
  assert.ok(source.includes("item.media_kind === \"audio\""), "版本轨/lightbox 应读 media_kind 判音频");
  assert.ok(source.includes("displayVersion.format"), "生成信息应展示 format");
  assert.ok(source.includes("音频版本轨"), "音频资产版本轨应有音频标题");
  assert.ok(source.includes("还没有音频"), "音频资产应有音频空态文案");
});
