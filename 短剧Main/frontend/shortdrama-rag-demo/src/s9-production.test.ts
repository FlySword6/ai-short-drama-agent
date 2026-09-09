/* ============================================================
   s9-production.test.ts — S9 生产页批（DC 第二批 ③④⑤⑥）源码级验收断言
   ③ 素材卡 kebab「移入回收站」：DELETE /shots/:id 软删除接通；
      后端 V0.1 回收站列表/恢复仅支持项目与个人资产（src/modules/trash
      repository.assertSupportedKind），素材如实提示暂不可恢复，不造假恢复口。
   ⑤ 导入示例文件：public/shortdrama-script-template.xlsx 存在且
      左栏入口行与导入弹窗都给了下载链接；列结构可被后端 parser 解析
      （真源验证脚本 .scratch-s9/verify-template.mts，已跑绿）。
   ⑥ 降噪：命名规则收 HelpHint、素材区统一 border-border-1 分隔线、
      无图占位去多彩渐变统一 surface-well。
   追加：S9-20 动作承诺类型 → 类型锁定（AssetBlankFormModal lockedKind）；
      18-集级「一键生成本集」改「生成本集」（与素材级「生成视频」同构）。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const projectPages = readSource("./pages/project-pages.tsx");

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/* ---------- S9-3：素材卡「移入回收站」 ---------- */

test("S9-3a：素材卡 kebab 有「移入回收站」，走 DELETE /shots/:id 软删除", () => {
  assert.ok(projectPages.includes("移入回收站"), "kebab 菜单缺「移入回收站」");
  assert.ok(
    projectPages.includes("api.request(`/shots/${encodeURIComponent(shot.id)}`, { method: \"DELETE\" })"),
    "删除应接通后端 DELETE /api/v1/shots/:shot_id（软删除）",
  );
});

test("S9-3b：有产物的素材删除给确认弹窗并提示产物数", () => {
  assert.ok(projectPages.includes("${media.length} 个生成产物"), "确认弹窗缺产物数提示");
  assert.ok(projectPages.includes("确认移入回收站"), "缺确认按钮");
});

test("S9-3c：素材恢复口未上线不造假——弹窗如实提示暂不可恢复，demo 走降级 toast", () => {
  assert.ok(projectPages.includes("素材删除后暂不可恢复"), "缺回收站语义的人话降级说明");
  assert.ok(projectPages.includes("离线演示不会写入回收站"), "demo 模式缺降级 toast");
});

/* ---------- S9-5：导入示例文件 ---------- */

test("S9-5：示例 xlsx 存在于 public，左栏入口行与导入弹窗各一处下载链接", () => {
  const template = readSource("../public/shortdrama-script-template.xlsx");
  assert.ok(template.length > 1_000, "public/shortdrama-script-template.xlsx 不应是空文件");
  assert.equal(
    countOccurrences(projectPages, 'href="/shortdrama-script-template.xlsx"'),
    2,
    "左栏入口行与导入弹窗应各有一处示例文件链接",
  );
  assert.ok(projectPages.includes("下载示例 Excel"), "导入弹窗缺示例文件引导文案");
});

/* ---------- S9-6：生产页降噪 ---------- */

test("S9-6a：命名规则不常驻——收进标题旁 HelpHint", () => {
  assert.ok(!projectPages.includes("命名：集-素材-场景-版本</span>"), "常驻命名说明应删除");
  assert.ok(projectPages.includes('<HelpHint label="素材命名规则">'), "标题旁缺命名规则 HelpHint");
});

test("S9-6b：素材区与上方统一一种分隔线（border-border-1）", () => {
  assert.ok(
    projectPages.includes('className="flex items-center gap-3 border-t border-border-1 pt-4"'),
    "素材区 header 缺统一分隔线",
  );
});

test("S9-6c：无图占位去多彩渐变，统一 surface-well 居中弱化", () => {
  assert.ok(!projectPages.includes("SHOT_THUMB_TONES"), "多彩占位渐变应删除");
  assert.ok(
    projectPages.includes("flex aspect-video items-center justify-center overflow-hidden bg-surface-well text-ink-4"),
    "无图占位应统一 surface-well + 居中淡图标",
  );
});

/* ---------- S9-20：动作承诺了对象类型的，类型即锁定 ---------- */

test("S9-20a：AssetBlankFormModal 加 lockedKind——锁定时类型为不可改说明行，不再给全量 13 类", () => {
  assert.ok(projectPages.includes("lockedKind?: string"), "Modal 缺 lockedKind prop");
  assert.ok(!projectPages.includes("defaultKind"), "旧 defaultKind 预填（可改选）应移除");
  assert.ok(
    projectPages.includes('<Field label="类型" hint={lockedKind ? "类型随入口锁定，不可改选" : undefined}>'),
    "锁定时类型字段应为不可改说明行",
  );
  assert.ok(projectPages.includes("assetKindLabel(lockedKind)"), "说明行应回显锁定类型标签");
});

test("S9-20b：「更多」菜单创建项各锁预填 kind（S17-C：详情页重复入口已撤，创建归列表页一处）", () => {
  assert.ok(projectPages.includes("lockedKind={createKind}"), "「创建角色/场景/道具…」应锁菜单预填 kind");
  assert.ok(!projectPages.includes("createPersona"), "详情页重复入口残留");
});

/* ---------- 18-集级：集级按钮与素材级「生成视频」同构（动作+对象） ---------- */

test("18-集级：「一键生成本集」改「生成本集」，旧文案与注释全清", () => {
  assert.ok(projectPages.includes(">生成本集（已就绪"), "集级主按钮应改名「生成本集」");
  assert.ok(!projectPages.includes("一键生成本集"), "「一键生成本集」文案/注释应全清（batch 抽屉标题归 integration 对齐）");
});
