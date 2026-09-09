/* ============================================================
   workbench-w9.test.ts — W9-C 工作台（布局纪律 + EDIT 组装台）验收断言
   buildEditIR 单测（ir-compiler 集成烟测）+ 源码级锚点（模式照 asset-center.test.ts）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildEditIR, emptyAddition } from "./components/edit-composer";
import { compileEditPrompt, EDIT_DIMENSIONS } from "./ir-compiler";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

/* ---------- buildEditIR：L0 一句话到 EditIR ---------- */

test("buildEditIR：默认全锁（无 fields 项），基线视频 composition 注册", () => {
  const ir = buildEditIR({ intent: "删除所有人，除了主角", overrides: {}, additions: [], cameraInheritance: "" });
  assert.equal(ir.kind, "edit");
  assert.equal(ir.intent, "删除所有人，除了主角");
  assert.equal(ir.base, "base-video");
  assert.equal(ir.assets.length, 1);
  assert.equal(ir.assets[0]?.media, "video");
  assert.equal(ir.assets[0]?.role, "composition");
  assert.deepEqual(Object.keys(ir.fields ?? {}), [], "未解锁的维度不得进 fields（锁定由编译器推导）");
  assert.equal(ir.camera_inheritance, undefined, "镜头继承缺省交给编译器默认句");
});

test("buildEditIR：覆写去空白入 fields；空 intent 回退占位不空串", () => {
  const ir = buildEditIR({ intent: "  ", overrides: { grading: " 黑白老电影 ", duration: "  " }, additions: [emptyAddition("火车冲出银幕")], cameraInheritance: " 手持不动 " });
  assert.equal(ir.intent, "（未填写编辑目标）");
  assert.deepEqual(ir.fields?.grading, { mode: "override", value: "黑白老电影" });
  assert.equal(ir.fields?.duration, undefined, "纯空白覆写视同未解锁");
  assert.equal(ir.additions?.[0]?.summary, "火车冲出银幕");
  assert.equal(ir.camera_inheritance, "手持不动");
});

test("buildEditIR → compileEditPrompt 集成：锁定枚举全覆盖、白名单与继承句在", () => {
  const ir = buildEditIR({
    intent: "让火车从银幕冲出",
    overrides: { grading: "破幕瞬间转彩色" },
    additions: [{ ...emptyAddition("冲出的火车及其光影变化"), name: "转色规则", trigger: "破幕瞬间", spatial_anchor: "以冲出点为中心", time_sync: "精确同步", physics: "撕裂方向一致" }],
    cameraInheritance: "",
  });
  const result = compileEditPrompt(ir);
  // 锁定枚举句：9 个未覆写维度全进枚举（EDIT_DIMENSIONS 10 减覆写 1）
  for (const [, label] of EDIT_DIMENSIONS.filter(([dimension]) => dimension !== "grading")) {
    assert.ok(result.prose.includes(label), `锁定枚举缺 ${label}`);
  }
  assert.ok(result.prose.includes("唯一新增的内容是"), "缺白名单句");
  assert.ok(result.prose.includes("冲出的火车及其光影变化"), "白名单缺新增 summary");
  assert.ok(result.prose.includes("总时长与"), "缺技术规格继承句");
  // 回源表覆盖全部段且段拼接即 prose
  assert.equal(result.provenance.map((entry) => entry.text).join("\n"), result.prose);
  assert.ok(result.slots[0]?.token === "@视频1", "基线视频应为 @视频1");
});

/* ---------- 源码级：EDIT 入口与组装台接入 ---------- */

test("W9-C 源码级：版本库有「基于此编辑」入口并接 EditComposer", () => {
  const workbench = readSource("./pages/workbench-page.tsx");
  assert.ok(workbench.includes("EditComposer"), "未引入 EditComposer");
  assert.ok(workbench.includes("onEditBase"), "版本库缺 onEditBase 回调");
  assert.ok(workbench.includes("基于此编辑"), "版本行缺「基于此编辑」入口");
  assert.ok(workbench.includes("editBase"), "缺基线视频状态");
});

test("W9-C 源码级：EditComposer 四层齐全（L0 命令条/L1 回显/L2 手风琴/L3 只读预览）", () => {
  const composer = readSource("./components/edit-composer.tsx");
  assert.ok(composer.includes("对这个视频说一句话"), "缺 L0 命令条");
  assert.ok(composer.includes("将锁定"), "缺 L1 结构化回显");
  assert.ok(composer.includes("展开精细控制"), "缺 L1→L2 升级入口");
  assert.ok(composer.includes("EDIT_DIMENSIONS"), "L2 锁定区未消费维度常量表");
  assert.ok(composer.includes("核心新增块"), "缺 L2 新增块区");
  assert.ok(composer.includes("镜头继承"), "缺 L2 镜头继承区");
  assert.ok(composer.includes("compileEditPrompt"), "L3 未接编译器");
  assert.ok(composer.includes("回源"), "缺 L3 回源点击");
  assert.ok(composer.includes("已验证可控") && composer.includes("官方推荐未验证"), "缺数值伪精度两档标注");
  // 提交走付费确认链同一入口（prose + 基线引用一并上送）
  assert.ok(composer.includes("onSubmit(compiled.prose, [base.id])"), "提交未带编译产物与基线引用");
});

test("W9-C 源码级：布局纪律锚点（参数=底条维度 popover/沉浸/时间线细带/版本轨道/常驻操作条）", () => {
  const workbench = readSource("./pages/workbench-page.tsx");
  /* K-goal-04 条 3：「调整」参数与版本抽屉退场——档位切换唯一入口=底条维度 popover;
     原 overlay 锚点(paramsOpen/参数与版本)随之退役 */
  assert.ok(!workbench.includes("paramsOpen"), "「调整」参数抽屉残留（K-goal-04 条 3 已删）");
  assert.ok(workbench.includes("TierDimensionPopovers"), "档位切换未收敛到底条维度 popover");
  assert.ok(workbench.includes("focusMode"), "缺沉浸模式");
  assert.ok(workbench.includes("CornersOut"), "沉浸切换缺图标");
  assert.ok(workbench.includes("点击展开"), "时间线缺细带默认态");
  assert.ok(workbench.includes("previewId"), "缺版本轨道预览态");
  assert.ok(workbench.includes("宫格切分") && workbench.includes("转为参考资产"), "常驻操作条缺失");
  // 术语收口：没有「分镜图提示词」，就是「提示词」
  assert.ok(!workbench.includes("分镜图提示词"), "旧术语「分镜图提示词」仍在");
});

/* ---------- S9-0：视频页签生产流向（生成输入组/生成输出区/空态引导） ---------- */

test("S9-0 源码级：视频页签「生成输入」组聚合当前图片/当前引用/提示词，舞台=「生成输出」", () => {
  const workbench = readSource("./pages/workbench-page.tsx");
  assert.ok(workbench.includes("生成输出"), "缺「生成输出」区标题");
  assert.ok(workbench.includes('aria-label={tab === "video" ? "生成输入" : undefined}'), "缺「生成输入」组容器（视频页签）");
  assert.ok(workbench.includes("当前图片 · 按图生视频的首帧"), "当前图片未标注输入角色（首帧）");
  assert.ok(workbench.includes("确认图、引用与提示词共同决定上方输出"), "缺输入→输出流向说明");
});

test("S9-0 源码级：视频空态改引导动作（先确认图按图生视频，或只按提示词生成）", () => {
  const workbench = readSource("./pages/workbench-page.tsx");
  assert.ok(workbench.includes("先在图片页签确认一张图，就能按图生成视频；也可以只按提示词生成"), "视频空态缺引导动作文案");
  assert.ok(!workbench.includes("支持文生视频；有确认图时默认按图生视频"), "旧空态文案仍在");
  // S59 + G26 吸收：清「文生视频」工程话术残留
  assert.ok(!workbench.includes("直接文生视频"), "「直接文生视频」工程话术仍在");
});

test("S9-0 源码级：连播/交付口径统一——成功条与 toast 不再出旧连体按钮名", () => {
  const workbench = readSource("./pages/workbench-page.tsx");
  assert.ok(workbench.includes("整集连播"), "成功条缺「整集连播」入口");
  assert.ok(!workbench.includes("本集连播与交付"), "旧连体按钮名仍在工作台出现");
});
