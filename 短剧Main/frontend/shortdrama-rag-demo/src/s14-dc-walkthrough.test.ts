/* ============================================================
   s14-dc-walkthrough.test.ts — S14 DC 真栈走查 12 条验收（测试+代码成对提交）
   条 1 筛选排序 / 条 2 题材自定义 / 条 3 改词 / 条 4 创建失败提示 /
   条 6 视频输出区按媒介归属+顺序 / 条 7 导演台两处 / 条 8 参考三域 /
   条 9 场景道具混淆根因 / 条 10 设置关闭钮 / 条 11 资产中心三改 /
   条 12 设置提权 / 条 13 登录清理+版本号单一来源
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LANE_DOMAINS, REFERENCE_LANES, laneDef } from "./reference-lanes";
import { PROJECT_ROLE_LABEL, forbiddenMessage } from "./operations";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const globalPages = readSource("./pages/global-pages.tsx");
const projectSettings = readSource("./components/project-settings.tsx");
const workbench = readSource("./pages/workbench-page.tsx");
const referenceLanes = readSource("./components/reference-lanes.tsx");
const settingsPage = readSource("./pages/settings-page.tsx");
const assetWidgets = readSource("./components/asset-widgets.tsx");
const versionTs = readSource("./version.ts");
const apiSource = readSource("./api.ts");

/* ---------- 条 1：项目管理筛选排序 ---------- */

test("条 1：负责人/题材/排序三个轻量 Select 在状态 tab 旁，题材选项来自数据", () => {
  assert.ok(globalPages.includes("全部负责人"), "缺负责人筛选");
  assert.ok(globalPages.includes("全部题材"), "缺题材筛选");
  assert.ok(globalPages.includes("按更新时间"), "缺排序选择");
  assert.ok(globalPages.includes("genreOptions"), "题材选项未从列表数据动态来");
  assert.ok(globalPages.includes('owner_user_id === user.id'), "「我负责的」过滤口径不对");
  assert.ok(globalPages.includes('sortBy === "created" ? "created_at" : "updated_at"'), "排序键不对");
});

/* ---------- 条 2：题材自定义 combobox ---------- */

test("条 2（S24-B 改写）：题材=词表建议+可输入新题材（datalist combobox），新题材写回共享词表", () => {
  assert.ok(globalPages.includes('list="genre-suggestions"'), "新建表单未用 combobox");
  assert.ok(projectSettings.includes('list="genre-suggestions"'), "项目设置未用 combobox");
  /* S24-B：建议来自 genre_suggestions 词表接口（服务端共享，登录可读）——
     不再是写死枚举+localStorage；接口失败给一句人话、可直接输入。 */
  assert.ok(globalPages.includes("api.vocabularyGenres()") && projectSettings.includes("api.vocabularyGenres()"), "建议集未接词表接口");
  assert.ok(globalPages.includes("api.addVocabularyGenre(genre.trim())") && projectSettings.includes("api.addVocabularyGenre(genre.trim())"), "新题材未写回词表");
  assert.ok(globalPages.includes("genreSuggestFailed") && projectSettings.includes("genreSuggestFailed"), "接口失败缺人话降级");
});

/* ---------- 条 3：改词 ---------- */

test("条 3：角色=负责人/可编辑/仅查看；新建栏=谁可以看这部剧；403 文案同步", () => {
  assert.equal(PROJECT_ROLE_LABEL.owner, "负责人");
  assert.equal(PROJECT_ROLE_LABEL.editor, "可编辑");
  assert.equal(PROJECT_ROLE_LABEL.viewer, "仅查看");
  assert.ok(globalPages.includes("谁可以看这部剧"), "新建表单栏名未改");
  assert.ok(!globalPages.includes("查看人员（"), "旧「查看人员」栏名仍在");
  assert.ok(!projectSettings.includes("可创作") && !projectSettings.includes("查看者"), "成员面板旧词仍在");
  assert.match(forbiddenMessage("create"), /仅可查看/);
});

/* ---------- 条 4：创建失败提示 ---------- */

test("条 4：创建项目 403 给明确提示（写操作不许静默）", () => {
  assert.ok(globalPages.includes("当前账号未开通建项权限，请联系管理员开通"), "403 提示缺失");
  assert.ok(globalPages.includes('reason.status === 403'), "403 判定缺失");
});

/* ---------- 条 6：视频输出区按媒介归属+顺序 ---------- */

test("条 6：版本轨道限本媒介、输出区在生成输入之后", () => {
  assert.ok(workbench.includes('railMedia = allMedia.filter((item) => item.media_kind === activeKind)'), "轨道未限本媒介");
  assert.ok(workbench.includes("railMedia.find((item) => item.id === previewId)"), "预览未限本类");
  assert.ok(workbench.includes("railMedia.length > 1"), "轨道未用过滤后列表");
  const inputIdx = workbench.indexOf("生成输入");
  const outputIdx = workbench.indexOf("生成输出");
  assert.ok(inputIdx > 0 && outputIdx > inputIdx, "顺序不是先入参→再生产→看本类产物");
});

/* ---------- 条 7：导演台两处 ---------- */

test("条 7：说明句删除；全屏按钮在视口右上角悬浮", () => {
  assert.ok(!workbench.includes("搭景、走位、定机位；机位图归"), "导演台说明句仍在");
  assert.ok(workbench.includes("absolute right-[312px] top-[56px] z-10"), "全屏按钮未锚在画布视口右上角(越过顶栏与右面板)");
});

/* ---------- 条 8/9：参考三域分区 + 场景道具混淆根因 ---------- */

test("条 8：三域=实体（角色/场景/道具）/风格（光影/色卡/运镜）/媒介（参考视频/音频），域标题+收纳", () => {
  assert.deepEqual(LANE_DOMAINS.map((d) => d.label), ["实体参考", "风格参考", "媒介参考"]);
  assert.deepEqual(LANE_DOMAINS[0]!.lanes, ["character", "scene", "prop"]);
  // K2：色卡进风格域，光影之后、运镜之前
  assert.deepEqual(LANE_DOMAINS[1]!.lanes, ["lighting", "color_card", "camera_motion"]);
  assert.deepEqual(LANE_DOMAINS[2]!.lanes, ["reference_video", "audio"]);
  assert.ok(referenceLanes.includes("DomainSection"), "域分区组件缺失");
  assert.ok(referenceLanes.includes("aria-expanded"), "域收纳缺展开语义");
  assert.equal(REFERENCE_LANES.length, 8, "组数应为 8（6+光影+K2 色卡）");
});

test("条 9：场景组只收 scene——lighting/style_env 归「光影」（混淆根因修复）", () => {
  assert.deepEqual(laneDef("scene").roles, ["scene"], "场景组 role 未收窄");
  assert.deepEqual(laneDef("scene").kinds, ["scene"], "场景组 kind 未收窄");
  assert.deepEqual(laneDef("lighting").roles, ["style_env"], "光影组 role 不对");
  assert.deepEqual(laneDef("lighting").kinds, ["lighting"], "光影组 kind 不对");
  // S24-C：光影槽选择器锁类型随词表走——pickKind 进词表列（原来是写死的 LANE_PICK_KIND 映射）
  assert.ok(readSource("./lane-vocabulary.ts").includes('pickKind: "lighting"'), "光影词条 pickKind 未锁类型");
  // S15-B：词条本体迁词表（lane-vocabulary.ts），根因注释跟随数据
  assert.ok(readSource("./lane-vocabulary.ts").includes("条 9"), "根因注释缺失");
});

/* ---------- 条 10：设置页无重复关闭钮 ---------- */

test("条 10：设置页无重复关闭按钮（复核实证）", () => {
  const closes = settingsPage.split('aria-label="关闭"').length - 1;
  assert.ok(closes <= 1, `设置页出现 ${closes} 个关闭按钮`);
});

/* ---------- 条 11：资产中心三改 ---------- */

test("条 11①：个人资产详情给「生成图片」直达（target_asset_entity_id，先估价后确认）", () => {
  assert.ok(assetWidgets.includes("AssetGenerateDialog"), "缺生成直达弹窗");
  assert.ok(assetWidgets.includes("target_asset_entity_id: asset.id"), "未带 target_asset_entity_id");
  assert.ok(assetWidgets.includes("先估价"), "缺估价步");
  assert.ok(assetWidgets.includes("确认生成"), "缺确认步（红线）");
  assert.ok(assetWidgets.includes('asset.scope === "personal"'), "未限定个人资产");
  assert.ok(apiSource.includes("async quoteGeneration"), "估价链缺失");
});

test("条 11②③：页签去「资产」轰炸；「上传」「新建」拆分", () => {
  assert.ok(globalPages.includes('value="personal">个人</TabsTrigger>'), "页签未改「个人」");
  assert.ok(globalPages.includes('value="common">通用</TabsTrigger>'), "页签未改「通用」");
  assert.ok(globalPages.includes(">上传</Button>") && globalPages.includes(">新建</Button>"), "上传/新建未拆分");
  assert.ok(globalPages.includes("createBlankAsset"), "新建空资产逻辑缺失");
  assert.ok(globalPages.includes("api.ingestJsonAssets"), "新建未走真链");
});

/* ---------- 条 12：全局设置提权 ---------- */

test("条 12：头像旁有全局设置直达按钮(rail 底组承载)", () => {
  // 2026-08-02 Fable 改锚:R2 壳后设置直达=rail 底组齿轮(头像上方),UserMenu 内同落点双保险。
  const rail = readFileSync(new URL("./components/app-rail.tsx", import.meta.url), "utf8");
  assert.ok(rail.includes('navigate("/settings")'), "rail 缺设置直达");
  assert.ok(rail.includes("全局设置"), "rail 缺设置按钮文案");
});

/* ---------- 条 13：登录清理+版本号单一来源 ---------- */

test("条 13：整页登录退役(V-47)——LoginPage/海报副文/IP 展示带/离线演示入口全灭；版本号=version.ts", () => {
  assert.ok(!globalPages.includes("export function LoginPage"), "整页 LoginPage 未退役");
  assert.ok(!globalPages.includes("login-hero-sub"), "海报副文未删");
  assert.ok(!globalPages.includes("好故事，我们有一库"), "IP 展示带未删");
  assert.ok(!globalPages.includes("demo-entry"), "离线演示入口未删");
  assert.ok(!globalPages.includes("V{APP_VERSION}"), "整页登录页脚版本号未随葬(V-47)");
  assert.ok(versionTs.includes('from "../package.json"'), "version.ts 未读 package.json");
});
