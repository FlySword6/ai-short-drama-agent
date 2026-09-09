/* ============================================================
   p1-states-motion.test.ts — 板14（四态）+ 板15（动效/图标）验收断言
   纯逻辑：loadingEscalation 8s 阈值、humanErrorMessage 无堆栈。
   源码级：空态 CTA、慢加载「仍在加载 · 重试」、图标唯一来源、
   禁 emoji/Duotone/第二图标库、动效关键帧与时长合同。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LOADING_SLOW_THRESHOLD_MS,
  humanErrorMessage,
  loadingEscalation,
} from "./pages/batch-generate-drawer";
import { relativeTimeLabel } from "./ui";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const projectsPage = readSource("./pages/global-pages.tsx");
const projectPages = readSource("./pages/project-pages.tsx");
const versionModal = readSource("./components/version-modal.tsx");
const batchDrawer = readSource("./pages/batch-generate-drawer.tsx");
const twCss = readSource("./tw.css");
const uiPrimitives = readSource("./components/ui/primitives.tsx");
const uiButton = readSource("./components/ui/button.tsx");
const packageJson = readSource("../package.json");

const P1_PAGE_SOURCES: Array<[string, string]> = [
  ["pages/global-pages.tsx", projectsPage],
  ["components/version-modal.tsx", versionModal],
  ["pages/batch-generate-drawer.tsx", batchDrawer],
];

/* ---------- 板14 加载态：8s 阈值与升级判定 ---------- */

test("loadingEscalation：8s 内普通加载，达到 8s 升级为慢加载", () => {
  assert.equal(LOADING_SLOW_THRESHOLD_MS, 8000);
  assert.equal(loadingEscalation(0), "loading");
  assert.equal(loadingEscalation(7999), "loading");
  assert.equal(loadingEscalation(8000), "slow");
  assert.equal(loadingEscalation(30000), "slow");
});

test("板14：三个加载界面都在慢加载分支给出「仍在加载 · 重试」，不做无限转圈", () => {
  for (const [name, source] of P1_PAGE_SOURCES) {
    if (name === "components/version-modal.tsx") continue; // 弹窗自身无独立加载态
    assert.ok(source.includes("仍在加载 · 重试"), `${name} 缺「仍在加载 · 重试」`);
    assert.ok(source.includes("useSlowLoading"), `${name} 未接入 useSlowLoading`);
    assert.ok(/skeleton/i.test(source), `${name} 加载态未用骨架屏`);
  }
});

/* ---------- 板14 错误态：一句人话，无堆栈 ---------- */

test("humanErrorMessage：剥堆栈行，只留一句人话", () => {
  const withStack = new Error("服务暂时不可用\n    at fetch (http://localhost:5173/src/api.ts:271:1)\n    at async ProjectsPage");
  assert.equal(humanErrorMessage(withStack), "服务暂时不可用");
});

test("humanErrorMessage：已知英文先映射中文，后端中文清洗后保留", () => {
  assert.equal(humanErrorMessage(new TypeError("Failed to fetch")), "网络连接异常，请检查网络后重试");
  assert.equal(humanErrorMessage(new Error("Error: 请求超时")), "请求超时");
  assert.equal(humanErrorMessage(new Error("provider backend exploded"), "生成失败，请重试"), "生成失败，请重试");
});

test("humanErrorMessage：单行内联堆栈也剥掉", () => {
  assert.equal(humanErrorMessage("读取失败 at Object.request (api.ts:271:11)"), "读取失败");
});

test("humanErrorMessage：空消息回退默认文案，超长截断", () => {
  assert.equal(humanErrorMessage(null), "操作失败，请重试");
  assert.equal(humanErrorMessage(""), "操作失败，请重试");
  assert.equal(humanErrorMessage("分镜不存在", "分镜读取失败，请重试"), "分镜不存在");
  const long = humanErrorMessage("错".repeat(200));
  assert.ok(long.length <= 120);
  assert.ok(long.endsWith("…"));
});

test("板14：页面错误显示一律过 humanErrorMessage，不直出原始 message", () => {
  assert.ok(projectsPage.includes("humanErrorMessage(error"), "ProjectsPage 错误态未净化");
  assert.ok(batchDrawer.includes("humanErrorMessage(reason"), "批量抽屉估价错误未净化");
});

/* ---------- 板14 空态即入口：CTA 断言 ---------- */

test("板14：项目管理空态 = 三步起步指引 + 剧名输入 + 新建项目（K2G 改写，空态即入口口径不变）", () => {
  /* K2G：空态从单句 EmptyState 升级为三步起步指引（建项目→导剧本→拆分镜），
     表单随指引迁到 components/home-next-step.tsx；入口能力（剧名输入+新建 CTA）不变。 */
  const homeNextStep = readSource("./components/home-next-step.tsx");
  assert.ok(projectsPage.includes("<HomeStartGuide"), "空态未接三步起步指引");
  assert.ok(homeNextStep.includes("还没有剧。三步开出第一部"), "缺空态标题");
  assert.ok(homeNextStep.includes('aria-label="剧名"'), "缺剧名输入");
  assert.ok(homeNextStep.includes("新建项目"), "空态缺「新建项目」CTA");
  // 新建项目 CTA 同时出现在标题行（网格加号卡）与空态指引
  const ctaCount = projectsPage.split("新建项目").length - 1;
  assert.ok(ctaCount >= 1, "列表区缺「新建项目」CTA");
});

test("板14：空态区分「没有项目」与「筛选无结果」，不用入口空态顶替", () => {
  assert.ok(projectsPage.includes("projects.length === 0"), "缺真空态分支");
  assert.ok(projectsPage.includes("没有符合条件的项目"), "缺筛选空态");
});

test("板14：工作台子资源降级态明示原因", () => {
  assert.ok(!projectsPage.includes("闭环计数") && !projectsPage.includes("retryLoopCounts"), "项目页仍消费不存在的媒体审核闭环");
  assert.ok(!projectPages.includes("review_status") && !projectPages.includes("p1-review-pill"), "分镜卡仍展示无动作审计的媒体审核状态");
});

/* ---------- 板15 图标：唯一来源 @phosphor-icons/react ---------- */

const EMOJI_PATTERN = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
const SECOND_ICON_LIB = /from\s+["'](?:react-icons|lucide-react|@heroicons\/|@iconify|@mui\/icons-material|antd)/;

test("板15：页面无 emoji 图标记，无第二图标库，无 Duotone/Fill 权重", () => {
  for (const [name, source] of P1_PAGE_SOURCES) {
    assert.ok(!EMOJI_PATTERN.test(source), `${name} 出现 emoji`);
    assert.ok(!SECOND_ICON_LIB.test(source), `${name} 引入第二图标库`);
    assert.ok(!/weight=["'](?:duotone|fill)["']/.test(source), `${name} 使用 duotone/fill 权重`);
  }
});

test("板15：图标唯一来源 @phosphor-icons/react（依赖里无第二套图标库）", () => {
  const manifest = JSON.parse(packageJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  assert.ok(deps["@phosphor-icons/react"], "缺 @phosphor-icons/react 依赖");
  const forbidden = Object.keys(deps).filter((name) => /react-icons|lucide|heroicons|iconify|icons-material/.test(name));
  assert.deepEqual(forbidden, [], `出现第二图标库依赖：${forbidden.join(", ")}`);
  for (const [name, source] of P1_PAGE_SOURCES) {
    assert.ok(source.includes('from "@phosphor-icons/react"'), `${name} 未从 phosphor 引图标`);
  }
});

test("板15：同义同图——积分消耗统一 Coins，视频版本统一 VideoCamera", () => {
  assert.ok(!versionModal.includes("FilmStrip"), "版本弹窗仍用 FilmStrip（视频语义应为 VideoCamera）");
  assert.ok(!batchDrawer.includes("icon={<SpinnerGap />}"), "重新估价按钮误用静态 SpinnerGap");
});

/* ---------- 板15 动效合同（Tailwind 迁移后的新现实） ---------- */

test("板15：卡片 hover 反馈集中在 Card 原语（interactive：位移+边框提亮）", () => {
  assert.ok(uiPrimitives.includes("hover:-translate-y-0.5"), "Card interactive 缺 hover 位移");
  assert.ok(uiPrimitives.includes("hover:border-border-2"), "Card interactive 缺 hover 边框提亮");
  assert.ok(uiPrimitives.includes("duration-150"), "Card 过渡未走短时长");
});

test("板15：按钮触感集中在 Button 原语（active 压缩 + focus ring）", () => {
  assert.ok(uiButton.includes("active:scale-[0.98]"), "Button 缺 active 触感");
  assert.ok(uiButton.includes("focus-visible:ring-2"), "Button 缺 focus ring");
  assert.ok(uiButton.includes("ease-out-quart"), "Button 缓动未走 token 族");
});

test("板15：浮层动效走 tw.css 统一关键帧（进 240ms / 退 160ms）", () => {
  assert.ok(twCss.includes("--animate-fade-up"), "缺 fade-up 定义");
  assert.ok(twCss.includes("--animate-fade-out"), "缺 fade-out 定义");
  assert.ok(twCss.includes("0.24s"), "fade-up 未到 240ms");
  assert.ok(twCss.includes("0.16s"), "fade-out 未到 160ms");
  assert.ok(batchDrawer.includes("requestClose"), "批量抽屉未走退出再卸载");
});

test("板15：409 shake / 庆祝 pop+glow / 时间线呼吸与点亮在 tw.css 归位且页面挂钩在", () => {
  for (const key of ["vw-conflict-shake", "vw-celebrate-pop", "vw-celebrate-glow", "vw-tl-breathe", "vw-tl-lit-once"]) {
    assert.ok(twCss.includes(`@keyframes ${key}`), `tw.css 缺关键帧 ${key}`);
  }
});

test("板15：reduced-motion 静止覆盖 tw.css 全部自定义循环/一次性动画", () => {
  assert.ok(twCss.includes("prefers-reduced-motion"), "tw.css 缺 reduced-motion 覆盖");
  const reduced = twCss.split("prefers-reduced-motion")[1] ?? "";
  for (const hook of ["vw-tl-card", "vw-default-conflict", "vw-celebrate", "vw-tl-lit"]) {
    assert.ok(reduced.includes(hook), `reduced-motion 未覆盖 ${hook}`);
  }
});

/* ---------- 板15 动效数值锚定（D 项：防 tw.css 数值漂移） ---------- */

test("板15 数值锚：浮层进 240ms 退 160ms、呼吸 1.6s、shake ×2、庆祝 pop 240ms+glow 600ms", () => {
  // 浮层时长
  assert.ok(twCss.includes("--animate-fade-up: fade-up 0.24s"), "fade-up 不是 240ms");
  assert.ok(twCss.includes("--animate-fade-out: fade-out 0.16s"), "fade-out 不是 160ms");
  // 时间线呼吸循环周期
  assert.ok(twCss.includes("vw-tl-breathe 1.6s"), "呼吸不是 1.6s");
  // shake ×2：四个对称位移关键帧
  const shake = twCss.split("@keyframes vw-conflict-shake")[1]?.slice(0, 600) ?? "";
  for (const stop of ["12.5%", "37.5%", "62.5%", "87.5%"]) {
    assert.ok(shake.includes(stop), `shake 缺 ${stop} 停顿帧`);
  }
  // 庆祝：pop 走 duration-3（240ms），glow 走 duration-5（600ms），均一次性
  const celebrate = twCss.split(".vw-celebrate {")[1]?.split("}")[0] ?? "";
  assert.ok(celebrate.includes("var(--duration-3)"), "庆祝 pop 未走 duration-3");
  assert.ok(celebrate.includes("var(--duration-5)"), "庆祝 glow 未走 duration-5");
  assert.ok((celebrate.match(/ 1[;,]/g) ?? []).length >= 2, "庆祝不是一次性");
});

test("板15 数值锚：原语交互时长 150ms 族（Button/Card/dropdown）", () => {
  assert.ok(uiButton.includes("duration-150"), "Button 过渡未走 150ms 族");
  assert.ok(uiPrimitives.includes("duration-150"), "Card/原语过渡未走 150ms 族");
  const dropdown = readSource("./components/ui/dropdown-menu.tsx");
  assert.ok(dropdown.includes("animate-fade-up"), "dropdown 未用统一入场关键帧");
});

/* ---------- P1-11 项目卡：封面最新产物首帧 + 进度徽章 + 空说明不占位 ---------- */

test("relativeTimeLabel：相对时间梯度，无值/非法日期回空串", () => {
  const now = new Date("2026-07-23T12:00:00Z").getTime();
  assert.equal(relativeTimeLabel("2026-07-23T12:00:00Z", now), "刚刚");
  assert.equal(relativeTimeLabel("2026-07-23T11:30:00Z", now), "30 分钟前");
  assert.equal(relativeTimeLabel("2026-07-23T09:00:00Z", now), "3 小时前");
  assert.equal(relativeTimeLabel("2026-07-20T12:00:00Z", now), "3 天前");
  assert.equal(relativeTimeLabel("2026-06-23T12:00:00Z", now), "1 个月前");
  assert.equal(relativeTimeLabel("2025-07-23T12:00:00Z", now), "1 年前");
  // 未来时钟偏差按「刚刚」，不负数
  assert.equal(relativeTimeLabel("2026-07-24T12:00:00Z", now), "刚刚");
  assert.equal(relativeTimeLabel(null, now), "");
  assert.equal(relativeTimeLabel("", now), "");
  assert.equal(relativeTimeLabel("not-a-date", now), "");
});

test("P1-11 源码级：项目卡进度徽章（N 集 · M 素材 · 相对时间），空说明不再摆占位句", () => {
  assert.ok(!projectsPage.includes("尚未填写项目说明"), "空说明占位句仍在");
  // S9-7/H 线：后端 /projects 无计数字段，无数据时段隐藏而不是渲染「0 集 · 0 素材」假进度（报 Sol 缺口）
  assert.ok(projectsPage.includes('typeof project.episode_count === "number"'), "集计数未按有无守卫");
  assert.ok(projectsPage.includes('typeof project.asset_count === "number"'), "素材计数未按有无守卫");
  assert.ok(projectsPage.includes('statsParts.join(" · ")'), "缺进度徽章拼装行");
  assert.ok(projectsPage.includes("relativeTimeLabel(project.updated_at)"), "最近活动未走相对时间");
  // 说明为空就整段不渲染（条件渲染，不是空字符串占位）
  assert.ok(projectsPage.includes("project.description?.trim()"), "说明未按空值整段隐藏");
});

test("P1-11 源码级：项目卡封面取最新产物首帧（最新集优先扫描）", () => {
  assert.ok(projectsPage.includes("useProjectCover"), "缺海报位惰性封面");
  assert.ok(projectsPage.includes("b.episode_no - a.episode_no"), "封面未按最新集优先");
  assert.ok(projectsPage.includes('item.media_kind === "image"'), "封面未限定图片产物");
});
