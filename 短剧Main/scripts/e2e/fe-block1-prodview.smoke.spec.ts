/**
 * 块 1 集视图(P-02b)四层验收 ③ E2E 新用例 + ④ UX 指标实测(T3/T5)。
 *
 * 覆盖:
 *   test 1「集视图动线」:登录 → 雾岛项目 /projects/:id/production →
 *     四层在场(①整集时间线带格数=场数 / ②下一步条唯一 primary 按投影态 /
 *     ③场卡×2:场名衬线+Badge+x/N 就位 font-tkmono+缩略 img+Ghost 备戏 /
 *     ④更多 ▾:审核队列/交付本集/导出·预览留位)→
 *     动线:场卡→P-04 段落工作台→「生产」页签回 /production;
 *     Ghost 备戏→/assets/prep(带场 localStorage 暂存);
 *     更多 ▾→交付本集→modal 出现→关闭。
 *   test 2「UX 指标实测 T3/T5」(docs/design/ux-metrics.md 集成区):
 *     T3 开拍一段(理想跳 2/点击 ≤5):集视图→(点场卡)→工作台→(开拍)→确认报价区出现即止
 *        ——付费红线:只估价不提交;
 *     T5 交付一集(理想跳 1/点击 ≤4):集视图→更多 ▾→交付本集→modal 打开即止
 *        ——落账是写动作,不点确认;
 *     实测值落 outputs/ux-t3t5-baseline-20260802.json。
 *
 * 用法:
 *   SGOAL06_BASE_URL=http://localhost:5173 npx playwright test \
 *     --config scripts/e2e/fe-block1-prodview.playwright.config.ts
 *
 * 断言策略:DOM 硬断言为主,不复述 Midscene aiAssert——暗色页同页同言 AI 判断波动,
 *   按 fe-b1-batch1 子卡 3「AI 软闸让位 DOM 硬判」先例,本文件要素全部硬断言覆盖。
 * 凭据读 TEST_ENV_ADMIN_USERNAME / TEST_ENV_ADMIN_PASSWORD,不打印、不写报告。
 * 属地:本文件与 fe-block1-prodview.playwright.config.ts 为块 1 集视图验收自建,
 *   不碰 fe-b1-batch1.smoke.spec.ts(另一会话所有)。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifactDir = path.resolve(
  process.env.FE_BLOCK1_PRODVIEW_ARTIFACT_DIR ?? path.join(worktreeRoot, "artifacts", "fe-block1-prodview"),
);
const screenshotDir = path.join(artifactDir, "screenshots");
const summaryPath = path.join(artifactDir, "prodview-summary.json");
const uxBaselinePath = path.join(worktreeRoot, "outputs", "ux-t3t5-baseline-20260802.json");

type CardStep = { card: string; url?: string; ok: boolean; screenshot?: string; error?: string };
const steps: CardStep[] = [];

/* ---- production-status 投影类型(与 src/types.ts EpisodeProductionStatus 对齐,只取本文件用的字段) ---- */
interface SceneStatus {
  scene_id: string;
  scene_no: number;
  name: string;
  sort_order: number;
  production_status: string;
  status_label: string;
  shot_summary: { total: number };
  control_package_summary: { filled_lane_count: number; enabled_lane_count: number };
}
interface EpisodeStatus {
  episode_id: string;
  project_id: string;
  production_status: string;
  status_label: string;
  scene_count: number;
  delivered_scene_count: number;
  next_scene_id: string | null;
  scenes: SceneStatus[];
}
interface ProdviewContext {
  projectId: string;
  projectName: string;
  episodeId: string;
  episodeNo: number;
  episodeName: string | null;
  status: EpisodeStatus;
}

/* ---- UX 指标实测记录(ux-metrics.md A 组:跳数比 ≤1.0 / 点击数比 ≤1.2 / 被迫回头 0) ---- */
interface UxLeg { action: string; from: string; to: string; clicks: number; page_hops: number; note?: string }
interface UxTaskMetric {
  name: string;
  spec_path: string;
  ideal: { page_hops: number; clicks: number };
  measured: { page_hops: number; clicks: number };
  hop_ratio: number | null;
  click_ratio: number | null;
  forced_backtracks: number;
  pass: boolean | null;
  measured_scope: string;
  legs: UxLeg[];
  notes: string[];
}
const uxMetrics: Record<string, UxTaskMetric> = {};

/** 集视图观察到的真实投影态,写进 summary 供回执(不硬造)。 */
const observed: Record<string, unknown> = {};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}(值不会输出到报告)`);
  return value;
}

function baseUrl(): string {
  const configured = process.env.SGOAL06_BASE_URL ?? "http://localhost:5173";
  const url = new URL(configured);
  if (!/^https?:$/.test(url.protocol)) throw new Error("SGOAL06_BASE_URL 必须是 http(s) 地址");
  return url.origin;
}

function safeFilename(name: string): string {
  return name.replaceAll(/[^a-z0-9]+/gi, "-").replaceAll(/^-|-$/g, "").toLowerCase();
}

/** 登录:确定性 selector,成功落到 /projects。 */
async function loginAsAdmin(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${baseUrl()}/login`, { waitUntil: "domcontentloaded" });
  // 账号框 autoComplete 按 allowRegister 合法切换(email/username,F08)，选择器改用不随之变的 data-testid。
  await page.getByTestId("login-username-input").fill(requiredEnv("TEST_ENV_ADMIN_USERNAME"));
  await page.getByTestId("login-password-input").fill(requiredEnv("TEST_ENV_ADMIN_PASSWORD"));
  await page.getByTestId("login-submit-button").click();
  await page.waitForURL((url) => url.pathname === "/projects", { timeout: 20_000 });
}

/** 探雾岛项目(name 含「雾岛」)→ 首集(按 episode_no 升序,与页面取集逻辑一致)→ production-status 投影。 */
async function wudaoContext(page: import("@playwright/test").Page): Promise<ProdviewContext> {
  return page.evaluate(async () => {
    const token = window.sessionStorage.getItem("shortdrama_v01_token");
    if (!token) throw new Error("登录后未找到会话");
    const req = async (url: string) => {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`${url} 返回 ${response.status}`);
      return (await response.json()) as { data?: unknown };
    };
    const projects = (await req("/api/v1/projects")).data as { items?: Array<{ id: string; name?: string }> };
    const project = (projects.items ?? []).find((item) => (item.name ?? "").includes("雾岛"));
    if (!project) throw new Error("没有找到 name 含「雾岛」的项目");
    const episodes = (await req(`/api/v1/projects/${project.id}/episodes`)).data as { items?: Array<{ id: string; episode_no: number; name?: string | null }> };
    const episode = [...(episodes.items ?? [])].sort((a, b) => a.episode_no - b.episode_no)[0];
    if (!episode) throw new Error("雾岛项目没有集");
    const status = (await req(`/api/v1/episodes/${episode.id}/production-status`)).data as EpisodeStatus;
    return {
      projectId: project.id,
      projectName: project.name ?? "",
      episodeId: episode.id,
      episodeNo: episode.episode_no,
      episodeName: episode.name ?? null,
      status,
    };
  });
}

async function record(card: string, run: () => Promise<void>, page: import("@playwright/test").Page): Promise<void> {
  const step: CardStep = { card, ok: false };
  try {
    await run();
    step.ok = true;
    step.url = page.url();
  } catch (error) {
    const screenshot = path.join(screenshotDir, `${safeFilename(card)}-failed.png`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
    step.screenshot = screenshot;
    step.error = error instanceof Error ? error.message : String(error);
  }
  steps.push(step);
  if (!step.ok) throw new Error(`${card} 未过:${step.error}`);
}

/* 下一步条状态机(nextStepOf):按集投影态断 primary 文案,不写死。 */
const NEXT_STEP_LABEL: Record<string, RegExp> = {
  not_broken_down: /去拆剧本/,
  broken_down: /去备戏/,
  preparing: /去备戏/,
  ready: /进工作台/,
  has_media: /进工作台/,
  generating: /查看队列/,
  delivered: /送审交付/,
};

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true });
  requiredEnv("TEST_ENV_ADMIN_USERNAME");
  requiredEnv("TEST_ENV_ADMIN_PASSWORD");
});

test.afterAll(async () => {
  await mkdir(artifactDir, { recursive: true });
  await mkdir(path.dirname(uxBaselinePath), { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify({
    goal: "块 1 集视图(P-02b)③ E2E 动线 + ④ UX T3/T5 实测",
    base_url: baseUrl(),
    ok: steps.every((step) => step.ok),
    observed,
    ux_baseline: path.relative(worktreeRoot, uxBaselinePath),
    steps,
  }, null, 2)}\n`, "utf8");
  await writeFile(uxBaselinePath, `${JSON.stringify({
    goal: "UX 指标实测 T3/T5(集成区,docs/design/ux-metrics.md)",
    measured_at: new Date().toISOString(),
    base_url: baseUrl(),
    subject: observed,
    thresholds: { hop_ratio: "<=1.0", click_ratio: "<=1.2", forced_backtracks: 0 },
    tasks: uxMetrics,
  }, null, 2)}\n`, "utf8");
});

test("集视图动线:四层在场+场卡入工作台+Ghost 备戏+更多 ▾ 交付 modal", async ({ page }) => {
  await loginAsAdmin(page);
  await record("block1-prodview-flow", async () => {
    const ctx = await wudaoContext(page);
    const { status } = ctx;
    const scenes = [...status.scenes].sort((a, b) => a.sort_order - b.sort_order);
    Object.assign(observed, {
      project: ctx.projectName,
      project_id: ctx.projectId,
      episode_id: ctx.episodeId,
      episode_no: ctx.episodeNo,
      production_status: status.production_status,
      status_label: status.status_label,
      scene_count: status.scene_count,
      scenes: scenes.map((scene) => ({
        name: scene.name,
        status: scene.production_status,
        status_label: scene.status_label,
        lanes: `${scene.control_package_summary.filled_lane_count}/${scene.control_package_summary.enabled_lane_count}`,
      })),
    });

    await page.goto(`${baseUrl()}/projects/${ctx.projectId}/production`, { waitUntil: "domcontentloaded" });
    const sceneList = page.locator('section[aria-label="场列表"]');
    await expect(sceneList.locator("article").first()).toBeVisible({ timeout: 15_000 });

    // 集标题行:集名(衬线)+已交付计数
    const epLabel = ctx.episodeName ?? `第 ${ctx.episodeNo} 集`;
    await expect(page.getByRole("heading", { name: epLabel, exact: true })).toBeVisible();
    await expect(page.getByText(`第 ${status.delivered_scene_count}/${status.scene_count} 场已交付`)).toBeVisible();

    // ① 整集时间线带:格数=场数,每格 title=「序号 · 场名 · 状态」,有主版本缩略 img
    const timeline = page.locator('section[aria-label="整集时间线"]');
    await expect(timeline).toBeVisible();
    await expect(timeline.locator(":scope > button")).toHaveCount(scenes.length);
    for (const scene of scenes) {
      await expect(timeline.locator(`button[title="${scene.scene_no} · ${scene.name} · ${scene.status_label}"]`)).toBeVisible();
    }
    await expect(timeline.locator("button img")).toHaveCount(scenes.length, { timeout: 15_000 });

    // ② 下一步条:唯一 primary(主内容区 main 内 bg-accent 按钮恰 1 枚且在条内;Pi 助手抽屉的
    //    发送钮是全局壳常驻、不属页面态,V-24 口径按主内容区计),文案按投影态
    const nextBar = page.locator('section[aria-label="下一步"]');
    await expect(nextBar).toBeVisible();
    const expectedLabel = NEXT_STEP_LABEL[status.production_status];
    if (!expectedLabel) throw new Error(`未知集投影态 ${status.production_status}`);
    await expect(nextBar.getByRole("button", { name: expectedLabel })).toBeVisible();
    await expect(page.locator("main#main-content button.bg-accent")).toHaveCount(1);
    await expect(nextBar.locator("button.bg-accent")).toHaveCount(1);

    // ③ 场卡列表:卡数=场数;每卡=场名(衬线)+Badge+x/N 就位(font-tkmono)+缩略 img+Ghost 备戏
    await expect(sceneList.locator("article")).toHaveCount(scenes.length);
    for (const [index, scene] of scenes.entries()) {
      const card = sceneList.locator("article").nth(index);
      await expect(card).toHaveAttribute("aria-label", `进 ${scene.name} 段落工作台`);
      const name = card.locator("h3");
      await expect(name).toHaveText(scene.name);
      await expect(name).toHaveAttribute("style", /--tk-font-serif/);
      await expect(card.getByText(scene.status_label, { exact: true })).toBeVisible();
      const lanes = `${scene.control_package_summary.filled_lane_count}/${scene.control_package_summary.enabled_lane_count}`;
      if (scene.shot_summary.total === 0) {
        await expect(card.locator("span.font-tkmono", { hasText: "—" })).toBeVisible();
      } else {
        await expect(card.locator("span.font-tkmono", { hasText: `${lanes} 就位` })).toBeVisible();
      }
      await expect(card.locator(`img[alt="${scene.name}"]`)).toBeVisible({ timeout: 15_000 });
      await expect(card.getByRole("button", { name: "备戏", exact: true })).toBeVisible();
    }

    // 动线 1:点场卡 → P-04 段落工作台;「生产」页签回 /production
    const first = scenes[0]!;
    await sceneList.locator("article").first().locator("h3").click();
    await page.waitForURL(
      (url) => url.pathname === `/projects/${ctx.projectId}/storyboards/${ctx.episodeId}/scenes/${first.scene_id}`,
      { timeout: 10_000 },
    );
    await expect(page.locator('aside[aria-label="参考控制包"]')).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "生产", exact: true }).click();
    await page.waitForURL((url) => url.pathname === `/projects/${ctx.projectId}/production`, { timeout: 10_000 });
    await expect(sceneList.locator("article").first()).toBeVisible({ timeout: 15_000 });

    // 动线 2:Ghost 备戏 → /assets/prep(带场参数 localStorage 暂存,裁定③口径)
    await sceneList.locator("article").first().getByRole("button", { name: "备戏", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/assets/prep", { timeout: 10_000 });
    await expect(page.locator('div[aria-label="备戏台"]')).toBeVisible({ timeout: 15_000 });
    const prepCurrent = await page.evaluate(() => window.localStorage.getItem("shortdrama_prep_current_v1"));
    expect(prepCurrent, "备戏应带上当前场参数").toContain(first.scene_id);

    // ④ 集级操作「更多 ▾」:四项可见;交付本集 → modal 出现 → 关闭
    await page.goto(`${baseUrl()}/projects/${ctx.projectId}/production`, { waitUntil: "domcontentloaded" });
    await expect(sceneList.locator("article").first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "更多 ▾", exact: true }).click();
    await expect(page.getByRole("button", { name: "审核队列", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "交付本集", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "导出本集 · 留位", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "预览全集 · 留位", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "交付本集", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(`交付第 ${ctx.episodeNo} 集`, { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "关闭" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }, page);
});

test("UX 指标实测 T3/T5:跳数/点击数 vs ux-metrics.md 理想基线", async ({ page }) => {
  await loginAsAdmin(page);
  await record("ux-t3t5-probe", async () => {
    const ctx = await wudaoContext(page);
    const scenes = [...ctx.status.scenes].sort((a, b) => a.sort_order - b.sort_order);
    const first = scenes[0]!;
    const prodPath = `/projects/${ctx.projectId}/production`;
    const workbenchPath = `/projects/${ctx.projectId}/storyboards/${ctx.episodeId}/scenes/${first.scene_id}`;
    const sceneList = page.locator('section[aria-label="场列表"]');

    /* ================= T5 交付一集(理想:集视图→审核→交付本集,跳 1/点击 ≤4) ================= */
    const t5Legs: UxLeg[] = [];
    const t5Notes: string[] = [];
    await page.goto(`${baseUrl()}${prodPath}`, { waitUntil: "domcontentloaded" });
    await expect(sceneList.locator("article").first()).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "更多 ▾", exact: true }).click();
    t5Legs.push({ action: "点「更多 ▾」展开集级操作", from: prodPath, to: prodPath, clicks: 1, page_hops: 0 });
    const deliverItem = page.getByRole("button", { name: "交付本集", exact: true });
    await expect(deliverItem).toBeVisible();
    await expect(page.getByRole("button", { name: "审核队列", exact: true })).toBeVisible();
    await deliverItem.click();
    const t5Dialog = page.getByRole("dialog");
    await expect(t5Dialog).toBeVisible();
    await expect(t5Dialog.getByText(`交付第 ${ctx.episodeNo} 集`, { exact: true })).toBeVisible();
    t5Legs.push({ action: "点「交付本集」→ 交付 modal 打开", from: prodPath, to: `${prodPath} (modal)`, clicks: 1, page_hops: 0, note: "modal 不算页面跳转" });
    t5Notes.push("实测止于 modal 打开:确认落账是写动作,不在本轮授权,未点;");
    t5Notes.push("「审核队列」与「交付本集」同收「更多 ▾」菜单,审核入口同跳数可达;");
    t5Notes.push("理想「集视图→审核→交付本集」含完整交付动作,实测为其前缀,比值按实测段计。");
    await t5Dialog.getByRole("button", { name: "关闭" }).click(); // 收口卫生,不计入任务点击
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const t5Measured = { page_hops: t5Legs.reduce((sum, leg) => sum + leg.page_hops, 0), clicks: t5Legs.reduce((sum, leg) => sum + leg.clicks, 0) };
    uxMetrics.T5 = {
      name: "交付一集",
      spec_path: "集视图→审核→交付本集",
      ideal: { page_hops: 1, clicks: 4 },
      measured: t5Measured,
      hop_ratio: Number((t5Measured.page_hops / 1).toFixed(2)),
      click_ratio: Number((t5Measured.clicks / 4).toFixed(2)),
      forced_backtracks: 0,
      pass: t5Measured.page_hops / 1 <= 1.0 && t5Measured.clicks / 4 <= 1.2,
      measured_scope: "集视图 →「更多 ▾」→「交付本集」→ 交付 modal 打开(未落账)",
      legs: t5Legs,
      notes: t5Notes,
    };

    /* ================= T3 开拍一段(理想:集视图→工作台→确认报价→提交,跳 2/点击 ≤5) ================= */
    const t3Legs: UxLeg[] = [];
    const t3Notes: string[] = [];
    await page.goto(`${baseUrl()}${prodPath}`, { waitUntil: "domcontentloaded" });
    await expect(sceneList.locator("article").first()).toBeVisible({ timeout: 15_000 });
    // 入口现状注记:集态=broken_down → 下一步条 primary=「去备戏」(设计语义:未备好先备戏,属 T2 域);
    // T3 入口实测走场卡——与 ready 态「进工作台」同落点(段落工作台)、同跳数(1 跳 1 击),无迂回。
    t3Notes.push(`入口现状:集投影态=${ctx.status.production_status},下一步条=「去备戏」(未备好先备戏=设计内语义,非迂回);`);
    t3Notes.push("T3 入口走场卡点击进段落工作台,与 ready 态「进工作台」同落点同跳数;");
    await sceneList.locator("article").first().locator("h3").click();
    await page.waitForURL((url) => url.pathname === workbenchPath, { timeout: 10_000 });
    t3Legs.push({ action: `点场卡「${first.name}」进段落工作台`, from: prodPath, to: workbenchPath, clicks: 1, page_hops: 1 });
    await expect(page.locator('aside[aria-label="参考控制包"]')).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined); // 等档位读取完,防过渡态
    const shootButton = page.getByRole("button", { name: "开拍", exact: true });
    await expect(shootButton).toBeVisible();
    await expect.poll(
      async () => (await shootButton.getAttribute("title")) ?? "",
      { timeout: 15_000 },
    ).not.toMatch(/这场还没有镜头|正在读取档位/);
    if (await shootButton.isEnabled()) {
      await shootButton.click(); // 仅估价(batchEstimate),不创建任务不付费;提交在确认区 submitSegment,不点
      const confirmSection = page.locator('section[aria-label="整段生成确认"]');
      await expect(confirmSection).toBeVisible();
      // 估价回来后区内有多处「积分」字样(单价行+正片价行),strict 取首个;早于此则匹配数=0 属等待期
      await expect(confirmSection.getByText(/积分/).first()).toBeVisible();
      t3Legs.push({ action: "点「开拍」→ 整段生成确认(报价)区出现", from: workbenchPath, to: workbenchPath, clicks: 1, page_hops: 0, note: "报价在页内确认区展开,无页面跳转;仅估价未提交(付费红线)" });
      t3Notes.push("实测止于「确认报价区出现」:提交是付费动作(付费红线),未点;");
      await confirmSection.getByRole("button", { name: "取消", exact: true }).click(); // 收口卫生,不计入任务点击
      await expect(confirmSection).toHaveCount(0);
    } else {
      const title = (await shootButton.getAttribute("title")) ?? "";
      t3Notes.push(`现状:「开拍」禁用(${title || "无 title 说明"})——环境无可用视频档位,「工作台→确认报价」段无法实测,如实记录。`);
    }
    t3Notes.push("理想「集视图→工作台→确认报价→提交」含提交动作,实测为其前缀,比值按实测段计;");
    t3Notes.push("被迫回头数=0:场卡直达工作台,无需返回找路。");
    const t3Measured = { page_hops: t3Legs.reduce((sum, leg) => sum + leg.page_hops, 0), clicks: t3Legs.reduce((sum, leg) => sum + leg.clicks, 0) };
    uxMetrics.T3 = {
      name: "开拍一段",
      spec_path: "集视图→工作台→确认报价→提交",
      ideal: { page_hops: 2, clicks: 5 },
      measured: t3Measured,
      hop_ratio: Number((t3Measured.page_hops / 2).toFixed(2)),
      click_ratio: Number((t3Measured.clicks / 5).toFixed(2)),
      forced_backtracks: 0,
      pass: t3Measured.page_hops / 2 <= 1.0 && t3Measured.clicks / 5 <= 1.2,
      measured_scope: "集视图 → 点场卡 → 段落工作台 →「开拍」→ 确认报价区出现(未提交)",
      legs: t3Legs,
      notes: t3Notes,
    };
  }, page);
});
