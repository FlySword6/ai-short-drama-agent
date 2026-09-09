/* ============================================================
   lite-style-gate.test.ts — Lite 界面样式门禁（G1-G7，docs/design/prd-v2/lite-ui-rework.md §3.8）
   扫描 src/pages/lite/** 的 className，漂移当场失败：
     G1 禁 raw 色    —— 不用 #hex / oklch( 等任意值颜色 utility（色彩只走 ink/surface/accent/border token）
     G2 禁外档字号  —— 不用 text-2xl~text-5xl（A4 锁死 page-title/section-title/body/aux 四档）
     *     G3 禁裸宽度值  —— 不用 max-w-[…px] / max-w-6xl / max-w-5xl（容器只走 max-w-7xl, 宽屏 1600px 登记款, 配置页 R2-8 起对齐工作页）
     G4 弹窗走档位  —— DialogContent 上不出现 max-w-* 裸覆盖（用 dialog.tsx 的 size prop）
     G5 禁奇数间距  —— 块级 p/py/px/mt 等不出现 4px（-1）档（4px 网格,参照 gap-4/gap-5/p-4/py-6 口径）
     G6 页头字阶    —— 页头 h1 一律 text-page-title text-ink-1（禁 text-2xl + text-ink-1 旧组合）
     G7 副标题色阶  —— 页头副标题 text-body text-ink-2（禁 text-ink-3）

   G5 定界说明（比 §3.8 表格字面更收敛,理由见下,2026-08-13 实施时裁定）:
   - 门禁放行 `gap-*`:flex 行内元素间距节奏(图标+文字/小徽记),全仓既有 40+ 处、
     壳导航线框(§2.2)本身就用紧凑 gap,历次漂移表从未列入,不属本包清理范围。
   - 门禁放行 12px(3)档块级值:p-3/px-3/py-3/mt-3 在 4px 网格上且是全应用控件标准内边距
     (完整版同样),漂移表从未列入。
   - 真正"奇数/cramped"的漂移 = 块级 4px(-1)档内边距/外边距,本门禁只禁这一档。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const LITE_DIR = join(dirname(fileURLToPath(import.meta.url)), "pages", "lite");

/** 扫描 lite 目录全部 .tsx/.ts 源码（排除 .test.ts），返回 {file, src}[]。 */
function liteSources(): { file: string; src: string }[] {
  return readdirSync(LITE_DIR)
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, src: readFileSync(join(LITE_DIR, f), "utf8") }));
}

const sources = liteSources();

function assertNone(pattern: RegExp, label: string) {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  const hits = sources
    .flatMap(({ file, src }) =>
      [...src.matchAll(re)].map((m) => `${file}:${m.index}`),
    )
    .slice(0, 8);
  assert.equal(hits.length, 0, `${label} —— 命中 ${hits.length} 处（前 8: ${hits.join(", ")}）`);
}

test("G1 禁 raw 色：lite 页 className 不出现任意值颜色 utility", () => {
  // 任意值颜色 utility（bg-[#fff]/text-[hsl(…)] 等）;SVG 演示占位图 fill="hsl(…)" 非 className,天然不匹配
  assertNone(
    /(?:bg|text|border|ring|outline|fill|stroke|from|to|via|divide|shadow|accent|caret|decoration)-\[(?:#[0-9a-fA-F]{3,8}|oklch\(|hsl\(|hwb\(|rgb\()/g,
    "G1 raw-color utility",
  );
  // oklch( 即便不在 utility 里也禁用（canvas 直渲图表例外, Lite 暂无）
  assertNone(/oklch\(/, "G1 oklch( any-context");
});

test("G2 禁外档字号：lite 页不出现 text-2xl~text-5xl（A4 四档 token 锁死）", () => {
  assertNone(/text-(?:2xl|3xl|4xl|5xl)\b/g, "G2 out-of-tier font size");
});

test("G3 禁裸宽度值：lite 页不出现 max-w-[…px] / max-w-6xl / max-w-5xl", () => {
  // 登记款（DC 2026-08-14 裁定 R2-1 更新）：小屏 1440px，2xl(≥1536px) 起 1920px。
  // 新裸宽一律先在此登记（已登记的 1440px/1920px 除外），否则 G3 直接红。
  assertNone(/max-w-\[(?!(?:1440|1920)px)[0-9.]+px\]/, "G3 max-w-[…px]（已登记 1440px/1920px 除外）");
  // §3.1: 剧本页 max-w-6xl / 分镜页 max-w-5xl 一律回 max-w-7xl
  assertNone(/max-w-6xl\b/g, "G3 max-w-6xl");
  assertNone(/max-w-5xl\b/g, "G3 max-w-5xl");
  // 正向:标准工作页容器档存在（max-w-[1440px] 全树至少一处,由其它工作页兜底）
  assert.ok(sources.some((s) => s.file !== "lite-project-config-page.tsx" && s.src.includes("max-w-[1440px]")), "G3 标准工作页 1440px 容器缺失");
  // 2026-08-17 用户三次裁定（lite-config-tabs-and-style.md §4.1.3 追加裁定）：配置页宽度随屏幕伸缩——
  // 撤销 R2-8 的 1440/1920px 上限,容器 w-full 满宽;G3 配置页专属断言随之从「必须有」改为「必须无」。
  const config = sources.find((s) => s.file === "lite-project-config-page.tsx")?.src ?? "";
  assert.ok(!config.includes("max-w-[1440px]"), "G3 配置页不得再套 1440px 上限（2026-08-17 满宽裁定）");
  assert.ok(!config.includes("max-w-3xl"), "G3 配置页 max-w-3xl 已退役（R2-8 宽度对齐工作页）");
});

test("G4 弹窗走档位：DialogContent 上不出现 max-w-* 裸覆盖", () => {
  const offenders = sources
    .flatMap(({ file, src }) =>
      src
        .split("\n")
        .map((line, i) => ({ file, line: i + 1, src: line }))
        .filter((l) => l.src.includes("DialogContent") && /max-w-/.test(l.src)),
    )
    .slice(0, 8);
  assert.equal(offenders.length, 0, `G4 DialogContent max-w-* —— ${offenders.map((o) => `${o.file}:${o.line}`).join(", ")}`);
  // 正向:两个宽弹窗用 size="wide"（新建资产 / 加图）而非裸 max-w
  assert.ok(
    sources.some((s) => s.file === "lite-asset-create-dialog.tsx" && s.src.includes('DialogContent size="wide"')),
    "G4 新建资产弹窗应为 size=wide",
  );
  assert.ok(
    sources.some((s) => s.file === "lite-asset-add-image-dialog.tsx" && s.src.includes('DialogContent size="wide"')),
    "G4 加图弹窗应为 size=wide",
  );
});

test("G5 禁奇数间距：lite 页块级 p/py/px/mt 等不出现 4px(-1) 档", () => {
  assertNone(
    /(?<![a-z])(?:p|px|py|pt|pb|pl|pr|mt|mb|mr|ml)-1(?![0-9.])/,
    "G5 4px block spacing（gap-* 行内间距放行,见文件头定界说明）",
  );
});

test("G6 页头字阶：页头页一律 text-page-title text-ink-1（禁 text-2xl+text-ink-1 旧组合）", () => {
  // text-2xl 已由 G2 全禁,这里复述旧组合以锁死回归语义
  assertNone(/text-2xl\b/g, "G6 页头旧字号 text-2xl");
  const headerPages = [
    // 2026-08-16 用户裁定：配置页页头不设标题/副标题（媒体 tab 已达意，lite-ui-rework.md §4.6），退出页头页名单。
    // 2026-08-17 用户裁定：壳两层并单条（lite-ui-rework.md §2.2），制作/素材/资产详情/分镜详情页头标题行退役
    //（名称上壳单条，§3.2），退出页头页名单——页头页只剩项目列表页。
    "lite-projects-page.tsx",
  ];
  for (const f of headerPages) {
    const src = sources.find((s) => s.file === f)?.src;
    assert.ok(src, `G6 页头页缺失源码 ${f}`);
    assert.ok(src.includes("text-page-title"), `G6 ${f} 页头 h1 未用 text-page-title token`);
    assert.ok(src.includes("text-ink-1"), `G6 ${f} 页头正标题未用 text-ink-1`);
  }
});

test("G7 副标题色阶：页头副标题 text-body text-ink-2（禁 text-ink-3）", () => {
  assertNone(/text-body[^"]*text-ink-3/, "G7 页头副标题漂移 text-body+text-ink-3");
  const headerPages = [
    // 2026-08-16 用户裁定：配置页退出页头页名单；2026-08-17 用户裁定：壳单条化，制作/素材/资产详情/
    // 分镜详情页头标题行退役（lite-ui-rework.md §2.2/§3.2）——页头页只剩项目列表页。
    "lite-projects-page.tsx",
  ];
  for (const f of headerPages) {
    const src = sources.find((s) => s.file === f)?.src;
    assert.ok(src, `G7 页头页缺失源码 ${f}`);
    assert.ok(src.includes("text-ink-2"), `G7 ${f} 页头副标题未用 text-ink-2`);
  }
});

test("G8 视口固定分栏工作台页（§3.7 模式 B）用 flex 布局填满父容器（main 为 flex-col，子页 flex-1）", () => {
  const workbenchPages = [
    "lite-workspace-page.tsx",
    "lite-asset-detail-page.tsx",
    "lite-shot-detail-page.tsx",
    // R2-8（2026-08-14 第二轮）：配置页高度固定为屏幕可用高（对齐工作台模型），纳入 G8 高度模型口径。
    "lite-project-config-page.tsx",
  ];
  for (const f of workbenchPages) {
    const src = sources.find((s) => s.file === f)?.src;
    assert.ok(src, `G8 工作台页缺失源码 ${f}`);
    // R2-7（2026-08-14 第三轮）：容器改用 flex-1 填满父 flex-col main，不再用硬编码 h-[calc(100dvh-…)]
    assert.ok(/flex-1\b/.test(src), `G8 ${f} 未用 flex-1 填满父容器（main 为 flex-col）`);
  }
});
