/* ============================================================
   s83-workbench-params.test.ts — S83 工作台参数选择区批验收（含 S83b 返工轮）

   V-36（DC 判决）：demo 参数 popover 假可调——单档 fixture 让维度引擎全部走
     单值固定标签，底条估价又写死初始档。修复 = demo 图片 fixture 扩多档
     （capability-tiers.ts DEMO_IMAGE_TIERS，S83b 起只用库里真实登记档,
     缺 1:1·1K 留「查无组合」缺口演示置灰）
     + 底条/确认抽屉 demo 估价跟随选中档（demoEstimatePoints）
     + footer 判定（dimensionPopoverFooter）：有置灰项或有单值维度都给出路说明。
     本文件用 happy-dom 真渲染 DimensionPopover（组件在 gen-params-popover.tsx，
     S83 未改组件本身，只改它的输入数据与 footer），断言：
     - demo 档表下比例/清晰度是 chips 可选，不再是固定标签；
     - 数量维度随库里「全 qty=1」回单值固定标签（数据事实）；
     - 选中态 aria-pressed、查无组合置灰 aria-disabled 且点了不生效；
     - footer 如实渲染传入文案。
   V-35 的模板区去重断言在 s9-generation.test.ts（S59 用例内），此处不重复。

   S83c：footer 守卫从字符串断言升级为行为断言（验收实测:S83b 的 includes
     守卫在「两个浮层 footer 入参对调」变异下零红）。两个 popover 连同 footer
     接线从 workbench-page.tsx 抽进 gen-params-popover.tsx 的
     TierDimensionPopovers，本文件真渲染它，断言每个浮层各自拿到正确 footer,
     并加不变式「有可点 button 的浮层不得说 SINGLE_TIER_NOTE」。

   S83d：SINGLE_TIER_NOTE 判定从「被切开的子集」改吃全量维度（四包并行验收：
     模型子集只有 model_label 一条维度,子集 every(single) 恒真,五档齐开时模型浮层
     对用户说「当前只开放这一档」=当场假话;而 S83c 的不变式 clickable===0 跳过
     恰好放它一马,:229 还把假话断言成了期望值）。本轮:模型浮层期望改正
     （demo 图片下=MORE_TIERS_NOTE,不得 SINGLE）;不变式改双向——有 button 不得
     SINGLE;无 button 且全量非单档也不得 SINGLE（这条真断言到模型浮层）;
     加 demo 视频（全量单档）回归:两个浮层都如实出 SINGLE_TIER_NOTE。

   基建说明：根 npm test 只收集 .test.ts（不匹配 .tsx），故本文件用
   React.createElement 不写 JSX；happy-dom 为 test-only devDependency。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Window } from "happy-dom";

/* happy-dom 先落地全局，再动态 import react/react-dom——react-dom 的 DOM
   特性探测发生在调用期，但保证 globals 先于模块求值最稳。 */
const happyWindow = new Window({ url: "http://localhost/" });
for (const key of Object.getOwnPropertyNames(happyWindow)) {
  if (!(key in globalThis)) {
    (globalThis as Record<string, unknown>)[key] = (happyWindow as unknown as Record<string, unknown>)[key];
  }
}
(globalThis as Record<string, unknown>).window = happyWindow;
(globalThis as Record<string, unknown>).document = happyWindow.document;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
/* 根 npm test 从仓根跑 tsx（根 tsconfig 无 jsx 字段 → classic 转换），被测 .tsx
   组件会引用自由变量 React；挂到全局兼容两种运行方式（前端目录内跑是 react-jsx,
   用不到它，挂了也无害）。 */
(globalThis as Record<string, unknown>).React = await import("react");
const { createRoot } = await import("react-dom/client");
const { DimensionPopover, TierDimensionPopovers } = await import("./components/gen-params-popover");
const { DEMO_IMAGE_TIERS, FALLBACK_VIDEO_TIER, MORE_TIERS_NOTE, SINGLE_TIER_NOTE } = await import("./capability-tiers");
const { listGenerationDimensions } = await import("./generation-dimensions");

type Pick = [string, string | number | boolean];

interface Harness {
  container: HTMLElement;
  picks: Pick[];
  render: (currentTierIndex: number, footer?: string) => void;
  open: () => void;
  click: (el: Element) => void;
  dialog: () => Element;
  chip: (text: string) => Element;
}

function mountPopover(): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const picks: Pick[] = [];
  let tierIndex = 0;
  let footerText: string | undefined;
  const render = (index: number, footer?: string): void => {
    tierIndex = index;
    footerText = footer;
    act(() => {
      root.render(createElement(DimensionPopover, {
        trigger: "参数",
        ariaLabel: "生成参数",
        dimensions: listGenerationDimensions(DEMO_IMAGE_TIERS, "image", DEMO_IMAGE_TIERS[tierIndex]!),
        footer: footerText,
        onPick: (key: string, value: string | number | boolean) => { picks.push([key, value]); },
      }));
    });
  };
  const click = (el: Element): void => {
    act(() => {
      // happy-dom MouseEvent 与 DOM lib Event 类型不同源，运行时兼容,此处收敛类型
      el.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }) as unknown as Event);
    });
  };
  render(0);
  const trigger = container.querySelector('[aria-haspopup="dialog"]');
  assert.ok(trigger, "缺 popover 触发钮");
  return {
    container,
    picks,
    render,
    click,
    open: () => {
      if (trigger.getAttribute("aria-expanded") !== "true") click(trigger);
      assert.ok(container.querySelector('[role="dialog"]'), "popover 未打开");
    },
    dialog: () => {
      const dialog = container.querySelector('[role="dialog"]');
      assert.ok(dialog, "浮层不在");
      return dialog!;
    },
    chip: (text: string) => {
      const btn = [...container.querySelectorAll('[role="dialog"] button')]
        .find((el) => el.textContent === text);
      assert.ok(btn, `缺 chip「${text}」`);
      return btn!;
    },
  };
}

/* ============================================================
   V-36：demo 多档让维度引擎真可调
   ============================================================ */

test("S83 组件级：demo 真登记档下比例/清晰度是可选 chips（修复前全是固定标签）", () => {
  const h = mountPopover();
  h.open();
  const dialog = h.dialog();
  // 参数维度行都在（标签文本）：比例/清晰度取值渲成 button
  for (const label of ["比例", "清晰度", "数量"]) {
    assert.ok(dialog.textContent!.includes(label), `缺维度行「${label}」`);
  }
  for (const text of ["16:9", "9:16", "1:1", "2K", "1K"]) {
    h.chip(text);
  }
  // 单值维度保持固定标签形态（合同 §4，不做假可调控件）：
  // 数量（库里图片档全 qty=1）与模型（同模型档表）有行、无 button
  assert.ok(dialog.textContent!.includes("1 张"), "数量单值固定标签缺失");
  assert.ok(
    ![...dialog.querySelectorAll("button")].some((el) => el.textContent === "1 张"),
    "数量单值维度被做成了假可调控件",
  );
  assert.ok(dialog.textContent!.includes("模型"), "缺模型维度行");
  assert.ok(
    ![...dialog.querySelectorAll("button")].some((el) => el.textContent!.includes("Seedream")),
    "单值模型维度被做成了假可调控件",
  );
});

test("S83 组件级：选中态 aria-pressed 如实,点 9:16 → onPick(aspect_ratio, 9:16)", () => {
  const h = mountPopover();
  h.open();
  assert.equal(h.chip("16:9").getAttribute("aria-pressed"), "true", "当前档 16:9 未标选中");
  assert.equal(h.chip("9:16").getAttribute("aria-pressed"), "false");
  assert.equal(h.chip("2K").getAttribute("aria-pressed"), "true", "当前档 2K 未标选中");
  h.click(h.chip("9:16"));
  assert.deepEqual(h.picks, [["aspect_ratio", "9:16"]], "点 9:16 未发出正确 onPick");
});

test("S83 组件级：1:1 档下 1K 置灰(aria-disabled)且点了不生效（查无组合不给选,缺口=真登记档中少登记的一条）", () => {
  const h = mountPopover();
  h.render(2); // currentTier = 1:1·2K·1张(DEMO_IMAGE_TIERS[2])
  h.open();
  assert.equal(h.chip("1K").getAttribute("aria-disabled"), "true", "「1K」未置灰(1:1·1K 查无组合)");
  // 有真档组合的不许误灰：2K 清晰度、16:9/9:16 比例仍可选
  for (const text of ["2K", "16:9", "9:16"]) {
    assert.equal(h.chip(text).getAttribute("aria-disabled"), "false", `「${text}」被误灰`);
  }
  h.click(h.chip("1K"));
  assert.deepEqual(h.picks, [], "置灰项点击不应触发 onPick");
});

test("S83 组件级：footer 如实渲染传入文案；undefined 时不渲染（判定逻辑单测在 generation-dimensions.test.ts）", () => {
  const h = mountPopover();
  h.open();
  assert.ok(!h.dialog().textContent!.includes(MORE_TIERS_NOTE), "footer=undefined 时仍渲染提示");
  h.render(1, MORE_TIERS_NOTE); // 有置灰项/部分单值 → 页面会传 note
  assert.ok(h.dialog().textContent!.includes(MORE_TIERS_NOTE), "传入 footer 未渲染");
});

/* ============================================================
   S83c 行为守卫：两个浮层各自拿到正确 footer(取代 S83b 的字符串守卫)

   S83b 的守卫用 includes 匹配源码字符串,验收实测:把两个 popover 的
   footer 入参对调,全量测试零红,页面却出现「5 枚 chip 可点、footer 说当前
   只开放这一档」的当场假话——死代码里的字符串照样搜得到。此处升级为
   行为断言:happy-dom 真渲染 TierDimensionPopovers(工作台底条两个浮层
   连同 footer 接线的真实组件,workbench-page.tsx 同源),直接断言
   每个浮层渲出来的 footer 是什么。

   S83d 修正(子集单值≠只有一档):S83c 的真值表本身写错了一格——模型浮层
   拿 model_label 单维子集判 every(single),恒真,demo 图片五档齐开时它也说
   「当前只开放这一档」;而旧不变式 clickable===0 跳过,恰好放它一马。
   现行判定(generation-dimensions.ts dimensionPopoverFooter):「只有一档」
   只吃全量维度。demo 图片默认档(16:9·2K·1 张)下的真值:
   - 模型浮层:同模型标签档表 → model_label 单值固定标签、0 可点 button,
     全量非单档 → MORE_TIERS_NOTE(不得 SINGLE_TIER_NOTE);
   - 参数浮层:比例/清晰度多值可点、数量单值(部分单值) → MORE_TIERS_NOTE。
   demo 视频(全量单档)下两个浮层都如实出 SINGLE_TIER_NOTE。
   ============================================================ */

interface TierPopoversHarness {
  container: HTMLElement;
  open: (ariaLabel: string) => Element;
}

function mountTierPopovers(
  tiers: readonly import("./capability-tiers").CapabilityTier[],
  mediaType: "image" | "video",
): TierPopoversHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(TierDimensionPopovers, {
      tiers,
      mediaType,
      selectedTier: tiers[0]!,
      onPick: () => {},
    }));
  });
  return {
    container,
    open: (ariaLabel: string) => {
      const trigger = container.querySelector(`[aria-haspopup="dialog"][aria-label="${ariaLabel}"]`);
      assert.ok(trigger, `缺「${ariaLabel}」popover 触发钮`);
      act(() => {
        // happy-dom MouseEvent 与 DOM lib Event 类型不同源，运行时兼容,此处收敛类型
        trigger.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }) as unknown as Event);
      });
      const dialog = container.querySelector(`[role="dialog"][aria-label="${ariaLabel}"]`);
      assert.ok(dialog, `「${ariaLabel}」浮层未打开`);
      return dialog!;
    },
  };
}

test("S83d 行为级:demo 图片(模型子集单值+参数子集多值)两个浮层都不得说「当前只开放这一档」", () => {
  const h = mountTierPopovers(DEMO_IMAGE_TIERS, "image");
  const modelDialog = h.open("模型选择");
  assert.ok(
    !modelDialog.textContent!.includes(SINGLE_TIER_NOTE),
    "模型浮层:全量五档齐开,model_label 子集单值≠只有一档,不得说「当前只开放这一档」(S83c 把这句假话断言成了期望值)",
  );
  assert.ok(
    modelDialog.textContent!.includes(MORE_TIERS_NOTE),
    "模型浮层:模型行是固定标签(不全可点),出路说明=「更多档位即将开放」",
  );
  const paramDialog = h.open("生成参数");
  assert.ok(paramDialog.textContent!.includes(MORE_TIERS_NOTE), "参数浮层(部分单值)未给出路说明");
  assert.ok(
    !paramDialog.textContent!.includes("当前只开放这一档"),
    "参数浮层有可选 chip,footer 却说「当前只开放这一档」(当场假话)",
  );
});

test("S83d 行为级:demo 视频(全量单档)两个浮层都如实说「当前只开放这一档」", () => {
  const h = mountTierPopovers([FALLBACK_VIDEO_TIER], "video");
  for (const ariaLabel of ["模型选择", "生成参数"]) {
    const dialog = h.open(ariaLabel);
    assert.ok(
      dialog.textContent!.includes(SINGLE_TIER_NOTE),
      `全量单档,「${ariaLabel}」浮层未如实说「当前只开放这一档」(修过头=把真单档的交代也删了)`,
    );
    /* 文案字面钉死一处(模型浮层):footer 是用户可见文案,不只锁常量引用——
       把 SINGLE_TIER_NOTE 改成别的字符串时,本条必须红(变异自跑②的靶子)。 */
    if (ariaLabel === "模型选择") {
      assert.ok(
        dialog.textContent!.includes("当前只开放这一档"),
        "模型浮层未渲染用户可见文案「当前只开放这一档」(文案被改=对用户交代失真)",
      );
    }
  }
});

test("S83d 行为级不变式(双向):有 button ⇒ 不得 SINGLE;无 button 且全量非单档 ⇒ 也不得 SINGLE", () => {
  /* 旧不变式(S83c)的 clickable===0 continue 恰好跳过模型浮层——没有 button 的浮层
     恰恰是 SINGLE_TIER_NOTE 唯一合法出现的地方,也是最该查的地方。改成双向:
     有 button(可点=不止一档)不得 SINGLE;无 button 但全量档表非单档同样不得 SINGLE
     (这条就是真断言到模型浮层的回归守卫)。全量是否单档从 fixture 全量维度推,不写死。 */
  const h = mountTierPopovers(DEMO_IMAGE_TIERS, "image");
  const allDimensions = listGenerationDimensions(DEMO_IMAGE_TIERS, "image", DEMO_IMAGE_TIERS[0]!);
  const allSingle = allDimensions.every((dimension) => dimension.single);
  assert.ok(!allSingle, "前置:demo 图片全量维度非全单值(档表不止一档),双向守卫的回归臂才有效");
  let checked = 0;
  for (const ariaLabel of ["模型选择", "生成参数"]) {
    const dialog = h.open(ariaLabel);
    const clickable = dialog.querySelectorAll("button[aria-pressed]").length;
    if (clickable === 0 && allSingle) continue; // 全量单档时无 button 的浮层说 SINGLE 是合法的,不查
    checked += 1;
    assert.ok(
      !dialog.textContent!.includes(SINGLE_TIER_NOTE),
      clickable > 0
        ? `「${ariaLabel}」浮层有 ${clickable} 枚可点 button,footer 却是 SINGLE_TIER_NOTE(可点却说只开放一档=假话)`
        : `「${ariaLabel}」浮层无 button 但全量非单档,footer 却是 SINGLE_TIER_NOTE(子集单值≠只有一档=假话)`,
    );
  }
  assert.ok(checked > 0, "不变式没有真实检查到任何浮层(空转=假守卫)");
});

/* ============================================================
   源码级守卫：demo 估价跟随选中档
   ============================================================ */

const workbench = readFileSync(new URL("./pages/workbench-page.tsx", import.meta.url), "utf8");

test("S83 源码级：底条 demo 估价走 demoEstimatePoints(选中档 ?? 初始档)", () => {
  /* K-goal-04 条 4：确认抽屉退场,抽屉内第二处估价调用随之退役;
     demo 估价唯一调用点=生成卡底条(⚡ 实时估价,选中档 ?? 初始档口径不变) */
  const occurrences = workbench.split("demoEstimatePoints(").length - 1;
  assert.ok(occurrences >= 1, "底条 demo 估价未走 demoEstimatePoints");
  assert.ok(workbench.includes("selectedTier ?? (mediaKind === \"image\" ? FALLBACK_IMAGE_TIER : FALLBACK_VIDEO_TIER)"), "未选中档时回落初始档口径丢失");
});
