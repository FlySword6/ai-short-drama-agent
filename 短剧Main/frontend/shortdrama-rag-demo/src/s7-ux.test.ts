/* ============================================================
   s7-ux.test.ts — S7 体验深改 16 条源码级验收断言
   信息冗余清理（空态/标签/说明书）、大众习惯对齐（顶栏三组/
   卡片主操作外露/开关入菜单/面包屑）、爽感（pressed/骨架/浮层动效）。
   纯源码级断言；宫格命名逻辑见 w6-grid.test.ts。
   S9-4：左栏 rail 断言（S7-2/S7-3）已按「单容器+小节头+底部入口行」重写；
   S9 生产页批（素材回收站/示例文件/降噪）断言见 s9-production.test.ts。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const appShell = readSource("./app.tsx");
const projectPages = readSource("./pages/project-pages.tsx");
const globalPages = readSource("./pages/global-pages.tsx");
const reviewPanels = readSource("./components/review-panels.tsx");
const consumptionRecords = readSource("./components/consumption-records.tsx");
const uiButton = readSource("./components/ui/button.tsx");
const uiPrimitives = readSource("./components/ui/primitives.tsx");
const assetWidgets = readSource("./components/asset-widgets.tsx");
const stepperCss = readSource("./production-stepper.css");

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/* ---------- 1. 顶栏三组对撑：左 flex-1 / 导航真居中 / 右 flex-1 ---------- */

test("S7-1：顶栏退役,壳=固定 72px rail+项目内二级条,导航不再 mx-auto 假居中", () => {
  // 2026-08-02 Fable 改锚:R2 壳后三顶栏结构退役,S7-1 的语义(导航不靠 mx-auto 假居中、
  // 两端不被空档撑歪)由固定宽 rail+二级条天然满足;守「rail 在场+假居中不回潮」。
  const rail = readFileSync(new URL("./components/app-rail.tsx", import.meta.url), "utf8");
  assert.ok(rail.includes("w-[72px]"), "rail 应为固定 72px 宽(壳层新结构)");
  assert.ok(!appShell.includes(`nav className="mx-auto`), "导航不应再 mx-auto（两端被空档撑歪）");
});

/* ---------- 2/3. 左栏：单容器 + 小节头分组 + 集项标签去重（S9-4 重写对齐） ---------- */

test("S7-2：左栏收成单容器——12px 灰字小节头分组，导入/新建降为列表底部入口行", () => {
  const railStart = projectPages.indexOf('aria-label="剧集列表"');
  const railEnd = projectPages.indexOf("<main");
  assert.ok(railStart > 0 && railEnd > railStart, "缺左栏 aside");
  const rail = projectPages.slice(railStart, railEnd);
  assert.equal(countOccurrences(rail, "<Card"), 1, "剧本集/空白集两个分组大卡应收成一个容器");
  assert.ok(rail.includes('text-xs text-ink-4">剧本集 · {scriptEpisodes.length}'), "小节头应为 12px 灰字「剧本集 · N」");
  assert.ok(rail.includes('text-xs text-ink-4">空白集 · {blankEpisodes.length}'), "小节头应为 12px 灰字「空白集 · N」");
  assert.ok(!rail.includes("text-sm font-semibold text-ink-1\">剧本集"), "小节头不应再是卡片标题级字号");
  assert.ok(rail.includes("导入剧本") && rail.includes("新建空白集"), "底部入口行缺「导入剧本 / 新建空白集」");
  assert.ok(rail.includes("border-t border-border-1 pt-2"), "入口行应与列表用分隔线收底");
  assert.ok(rail.indexOf("导入剧本") > rail.indexOf("空白集 · {blankEpisodes.length}"), "入口行应在两组列表之后");
  assert.ok(!projectPages.includes("还没有导入剧本的集"), "空态句应删除（计数 0 已表达）");
});

test("S7-3：集项=「第 N 集」+ 素材数，重复类型标签全删", () => {
  // S9-7/H 线：后端 /episodes 无 shot_count，无数据时不显示计数而不是渲染「0 素材」；两组 rail 同一守卫式
  assert.equal(
    countOccurrences(projectPages, 'typeof episode.shot_count === "number"'),
    2,
    "剧本集/空白集两组 rail item 都应用同一计数守卫（有数据才显示「N 素材」）",
  );
  assert.ok(!projectPages.includes("未导入剧本"), "项内「未导入剧本」标签应删除");
});

/* ---------- 4/5/6. 集头：按钮分级 + 使用资产收折 + 步骤条提示就近 ---------- */

test("S7-4：一键生成本集唯一实心主按钮，预览全集/视频库降 ghost", () => {
  assert.ok(projectPages.includes(`variant="ghost" icon={<PlayCircle />}`), "预览全集应降 ghost");
  const videoLibIndex = projectPages.indexOf("视频库</Button>");
  assert.ok(videoLibIndex > 0, "缺视频库按钮");
  const videoLibButton = projectPages.slice(projectPages.lastIndexOf("<Button", videoLibIndex), videoLibIndex);
  assert.ok(videoLibButton.includes('variant="ghost"'), "视频库应降 ghost");
});

test("S7-5：使用资产收成可折叠摘要行「使用资产 N 项 ▸」，默认收起", () => {
  assert.ok(projectPages.includes("aria-expanded={assetsOpen}"), "缺折叠 aria 契约");
  assert.ok(projectPages.includes("${episodeAssets.length} 项"), "缺「N 项」摘要");
});

test("S7-6：步骤条提示就近代步骤点尾部，不再 margin-left:auto 飘右上角", () => {
  assert.ok(!stepperCss.includes("margin-left: auto"), ".production-stepper-next 不应再撑到行尾");
});

/* ---------- 7/9/10. 资产页头：说明书入 HelpHint + 开关入更多菜单 + ? 归位 ---------- */

test("S7-7：页头说明书删除，标题旁 HelpHint 浮层承接", () => {
  // S10-D3：页名「项目资产」改「本剧资产」，HelpHint 标签同步
  assert.ok(projectPages.includes('<HelpHint label="本剧资产说明">'), "本剧资产标题旁缺 HelpHint");
  assert.equal(
    countOccurrences(projectPages, "项目资产沿用个人/通用资产分类"),
    1,
    "说明文案只应出现一次（HelpHint 浮层内），页头段落已删",
  );
});

test("S7-9：入库默认档位收进「更多」菜单，筛选行不再混开关", () => {
  assert.ok(projectPages.includes("<DropdownMenuLabel>生成产物默认审核</DropdownMenuLabel>"), "更多菜单缺生成产物审核档位 label");
  assert.equal(countOccurrences(projectPages, "<ReviewPolicyMenuItems"), 1, "档位项全文件仅更多菜单一处");
  assert.ok(
    projectPages.indexOf("<ReviewPolicyMenuItems") > projectPages.indexOf("<DropdownMenuLabel>生成产物默认审核"),
    "档位项应在「生成产物默认审核」label 之后",
  );
  assert.ok(reviewPanels.includes("export function ReviewPolicyMenuItems"), "review-panels 缺菜单项组件");
  assert.ok(!reviewPanels.includes("export function ReviewPolicySwitches"), "旧开关行组件应退役");
});

/* ---------- 8. 资产卡操作：主操作外露 + 次要进 kebab ---------- */

test("S7-8：四文字链平铺废除——整卡进详情、通过/拒绝成小按钮对、移出进 kebab", () => {
  assert.ok(!projectPages.includes(">查看详情</button>"), "文字链「查看详情」应废除");
  assert.ok(!projectPages.includes(">移出项目</button>"), "文字链「移出项目」应收进 kebab");
  assert.ok(projectPages.includes("更多操作"), "卡片 kebab 菜单触发器缺失");
});

/* ---------- 12. 面包屑：生产页补同款，全站有来路可回 ---------- */

test("S7-12：生产页补面包屑（项目管理 / 《剧名》/ 第 N 集），与资产页同款", () => {
  assert.equal(countOccurrences(projectPages, 'aria-label="面包屑"'), 2, "资产页+生产页各一处面包屑");
  assert.ok(projectPages.includes('`第 ${selectedEpisode.episode_no} 集`'), "生产页面包屑缺当前集");
});

/* ---------- 14. 骨架屏：素材列表 / 资产库 / 消耗明细 ---------- */

test("S7-14：列表加载不再空白等待——素材/资产库/消耗明细都有骨架屏", () => {
  assert.ok(projectPages.includes('Skeleton className="h-[178px]"'), "素材列表缺骨架卡");
  assert.ok(globalPages.includes('Skeleton className="h-[280px]"'), "资产库缺骨架卡");
  assert.ok(consumptionRecords.includes("<Skeleton"), "消耗明细表缺骨架行");
});

/* ---------- 15/16. 爽感：页签/浮层动效 + pressed 态 ---------- */

test("S7-15：页签切换与帮助浮层走统一 fade-in 动效", () => {
  assert.ok(uiPrimitives.includes("data-[state=active]:animate-fade-in"), "TabsContent 缺进场动效");
  assert.ok(assetWidgets.includes("animate-fade-in"), "HelpHint 浮层缺进场动效");
});

test("S7-16：按钮按下有 pressed 态——Button 原语+页签统一 scale 0.98", () => {
  assert.ok(uiButton.includes("active:scale-[0.98]"), "Button 缺 pressed 压缩");
  assert.ok(!uiButton.includes("active:translate-y-px"), "旧位移除开");
  assert.ok(uiPrimitives.includes("active:scale-[0.98]"), "TabsTrigger 缺 pressed 压缩");
});
