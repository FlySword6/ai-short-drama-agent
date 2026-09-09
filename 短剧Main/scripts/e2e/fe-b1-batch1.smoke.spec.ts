/**
 * 批次一六卡动线 E2E(R140 硬项:每张 FE 卡 DONE 前先过本文件对应 test)。
 *
 * 覆盖:
 *   卡2 LANDING  游客 /landing 三个入口按钮都开登录弹层(P-01b overlay 语义,不跳路由),登录后落到 /projects;
 *   卡1 SHELL    rail 四项导航+「生产队列」入口,项目内 48px 二级条四页签;
 *   卡3 PROJECTS 看板四列(备戏/在拍/送审/已交)全部渲染;
 *   卡4 QUEUE    /queue 队列页可读;
 *   卡5 COSTS    项目消耗页「本集已花」hero 可读;
 *   卡6 TOPICS   /topics 榜单四态之一明确呈现(不装空榜)。
 *
 * 用法:
 *   SGOAL06_BASE_URL=http://localhost:5173 npx playwright test \
 *     --config scripts/e2e/fe-b1-batch1.playwright.config.ts
 *
 * 登录走确定性 selector(与 sgoal06 同口径),Midscene 只做页面语义断言。
 * 凭据读 TEST_ENV_ADMIN_USERNAME / TEST_ENV_ADMIN_PASSWORD,不打印、不写报告。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test as base } from "@playwright/test";
import { PlaywrightAiFixture, type PlayWrightAiFixtureType } from "@midscene/web/playwright";

const test = base.extend<PlayWrightAiFixtureType>(PlaywrightAiFixture());

const artifactDir = path.resolve(process.env.FE_B1_ARTIFACT_DIR ?? "artifacts/fe-b1-batch1");
const screenshotDir = path.join(artifactDir, "screenshots");
const summaryPath = path.join(artifactDir, "batch1-summary.json");

type CardStep = { card: string; url?: string; ok: boolean; screenshot?: string; error?: string };
const steps: CardStep[] = [];

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

/** 从同源 API 拿第一个项目 id(登录后 sessionStorage 里有会话)。 */
async function firstProjectId(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(async () => {
    const token = window.sessionStorage.getItem("shortdrama_v01_token");
    if (!token) throw new Error("登录后未找到会话");
    const response = await fetch("/api/v1/projects", { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`/api/v1/projects 返回 ${response.status}`);
    const body = (await response.json()) as { data?: { items?: Array<{ id?: string }> } };
    const id = body.data?.items?.[0]?.id;
    if (!id) throw new Error("认证账号没有可用项目");
    return id;
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

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true });
  requiredEnv("TEST_ENV_ADMIN_USERNAME");
  requiredEnv("TEST_ENV_ADMIN_PASSWORD");
  requiredEnv("MIDSCENE_MODEL_API_KEY");
  requiredEnv("MIDSCENE_MODEL_NAME");
});

test.afterAll(async () => {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify({
    goal: "FE 批次一六卡动线(R140)",
    base_url: baseUrl(),
    ok: steps.every((step) => step.ok),
    steps,
  }, null, 2)}\n`, "utf8");
});

test("卡2 LANDING:游客三入口开登录弹层,登录落 /projects", async ({ page, agentForPage }) => {
  await record("card2-landing", async () => {
    for (const name of ["进入片场", "先看一集怎么拍", "登录"] as const) {
      await page.goto(`${baseUrl()}/landing`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name, exact: true }).click();
      // P-01b overlay 语义(DC 2026-08-02 裁定):弹层浮在落地页上,URL 不跳。
      await expect(page.locator(".landing-login-overlay .login-panel")).toBeVisible({ timeout: 5_000 });
      expect(new URL(page.url()).pathname, "弹层不跳路由").toBe("/landing");
      await page.keyboard.press("Escape");
      await expect(page.locator(".landing-login-overlay")).toHaveCount(0);
    }
    // 重开弹层做质量断言(等入场动画 0.62s 落定)
    await page.getByRole("button", { name: "进入片场", exact: true }).click();
    const overlay = page.locator(".landing-login-overlay");
    // 账号框 autoComplete 按 allowRegister 合法切换(email/username,F08)，选择器改用不随之变的 data-testid。
    await expect(overlay.getByTestId("login-username-input")).toBeVisible({ timeout: 10_000 });
    await expect(overlay.getByTestId("login-password-input")).toBeVisible();
    await page.waitForTimeout(700);
    const panelOpacity = await page.evaluate(() => getComputedStyle(document.querySelector(".landing-login-overlay .login-panel")!).opacity);
    expect(panelOpacity, "登录卡不得有 opacity=0 隐藏态").toBe("1");
    // 可点性硬闸门(P0-v2 口径,弹层上下文):提交钮中心点击点的最顶元素必须是按钮自身。
    const submitClickable = await page.evaluate(() => {
      const btn = document.querySelector<HTMLElement>('.landing-login-overlay [data-testid="login-submit-button"]')!;
      const r = btn.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return top === btn || btn.contains(top);
    });
    expect(submitClickable, "登录按钮须真正可点(点击点无遮挡)").toBe(true);
    const agent = await agentForPage(page);
    await agent.aiAssert("落地页上弹出登录卡片弹层:落地页内容在背景中压暗,登录表单(账号、密码输入框和登录按钮)在弹层内居中清晰可见且处于可交互状态,没有被任何元素遮挡,无需滚动。");
    // /login 整页版防回归(P0-v2 闸门口径保留):直访不超高、表单完整落首屏(深链 redirect 仍在用)。
    await page.goto(`${baseUrl()}/login`, { waitUntil: "domcontentloaded" });
    const viewportHeight = page.viewportSize()?.height ?? 720;
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(scrollHeight, "/login 整页版不得超出首屏(超高=氛围层回流占位)").toBeLessThanOrEqual(viewportHeight);
    const formBox = await page.getByTestId("login-password-input").boundingBox();
    expect(formBox, "密码框须有几何").toBeTruthy();
    expect(formBox!.y + formBox!.height, "/login 表单须完整落在首屏,无需滚动").toBeLessThanOrEqual(viewportHeight);
    await loginAsAdmin(page);
    await expect(page.locator("main").first()).toBeVisible();
  }, page);
});

test("卡1 SHELL:rail 四项+队列入口+项目内二级条", async ({ page, agentForPage }) => {
  await loginAsAdmin(page);
  await record("card1-shell", async () => {
    const rail = page.locator('nav[aria-label="全站导航"]');
    await expect(rail).toBeVisible();
    for (const label of ["项目管理", "资产中心", "数据看板"] as const) {
      await expect(rail.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    // rail 导航真点击:资产中心 → 数据看板 → 回项目管理
    await rail.getByRole("button", { name: "资产中心", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/assets", { timeout: 5_000 });
    await rail.getByRole("button", { name: "数据看板", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/dashboard", { timeout: 5_000 });
    await rail.getByRole("button", { name: "项目管理", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/projects", { timeout: 5_000 });
    // 队列入口
    await rail.getByRole("button", { name: /生产队列/ }).click();
    await page.waitForURL((url) => url.pathname === "/queue", { timeout: 5_000 });
    // 项目内二级条:四页签
    const projectId = await firstProjectId(page);
    /* 块 2:旧 /storyboards 深链应换乘到生产页(redirect 生效即此断言)。 */
    await page.goto(`${baseUrl()}/projects/${projectId}/storyboards`, { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => url.pathname === `/projects/${projectId}/production`, { timeout: 5_000 });
    for (const tab of ["生产", "剧本", "资产", "消耗"] as const) {
      await expect(page.getByRole("button", { name: tab, exact: true }).first()).toBeVisible();
    }
    const agent = await agentForPage(page);
    await agent.aiAssert("首屏可见:页面左侧有一条窄导航栏,包含若干导航入口;当前是项目内的生产页面,核心内容无需滚动即可读。");
  }, page);
});

test("卡3 PROJECTS:看板四列渲染", async ({ page, agentForPage }) => {
  await loginAsAdmin(page);
  await record("card3-projects-board", async () => {
    await page.goto(`${baseUrl()}/projects`, { waitUntil: "domcontentloaded" });
    for (const column of ["备戏列", "在拍列", "送审列", "已交列"] as const) {
      await expect(page.locator(`section[aria-label="${column}"]`)).toBeVisible();
    }
    const agent = await agentForPage(page);
    await agent.aiAssert("首屏可见:这是项目管理页,项目按备戏、在拍、送审、已交四列看板排布,无需滚动。");
  }, page);
});

test("卡4 QUEUE:/queue 队列页可读", async ({ page, agentForPage }) => {
  await loginAsAdmin(page);
  await record("card4-queue", async () => {
    await page.goto(`${baseUrl()}/queue`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("main").first()).toBeVisible();
    const agent = await agentForPage(page);
    await agent.aiAssert("首屏可见:这是生产队列页面,展示排队或生成中的任务状态,或给出明确的空状态说明。");
  }, page);
});

test("卡5 COSTS:项目消耗页本集已花 hero", async ({ page, agentForPage }) => {
  await loginAsAdmin(page);
  await record("card5-costs", async () => {
    const projectId = await firstProjectId(page);
    await page.goto(`${baseUrl()}/projects/${projectId}/costs`, { waitUntil: "domcontentloaded" });
    // 有消耗=「本集已花」hero;零消耗=如实空态「还没有消耗」(不伪造数据,两态都算动线通)。
    const hero = page.locator('section[aria-label="本集已花"]');
    const empty = page.getByText("还没有消耗");
    await expect(hero.or(empty).first()).toBeVisible({ timeout: 15_000 });
    const agent = await agentForPage(page);
    await agent.aiAssert("首屏可见:这是项目消耗页面,能看到本集已花的大数字,或给出还没有消耗的明确空状态。");
  }, page);
});

test("卡6 TOPICS:/topics 四态之一明确呈现", async ({ page, agentForPage }) => {
  await loginAsAdmin(page);
  await record("card6-topics", async () => {
    await page.goto(`${baseUrl()}/topics`, { waitUntil: "domcontentloaded" });
    // 四态任一:热度榜 / 尚未配置 / 暂时读不到;不许装空榜白屏。
    const board = page.locator('ul[aria-label="热度榜"]');
    const unconfigured = page.getByText("选题雷达尚未配置");
    const failed = page.getByText("榜单暂时读不到");
    await expect(board.or(unconfigured).or(failed).first()).toBeVisible({ timeout: 15_000 });
    const agent = await agentForPage(page);
    await agent.aiAssert("首屏可见:这是短剧热度榜页面,展示榜单内容,或给出榜单暂时读不到/尚未配置的明确状态说明。");
  }, page);
});

test("卡7 ASSETS-BROWSE:通用库排序/媒体/高级面板+URL 全条件", async ({ page, agentForPage }) => {
  await loginAsAdmin(page);
  await record("card7-assets-browse", async () => {
    await page.goto(`${baseUrl()}/assets?scope=common`, { waitUntil: "domcontentloaded" });
    // 常驻控件:排序两档 / 媒体三档 / 筛选按钮(高级面板入口)。
    const sortSelect = page.locator('select[aria-label="排序"]');
    const mediaSelect = page.locator('select[aria-label="媒体"]');
    await expect(sortSelect).toBeVisible();
    await expect(mediaSelect).toBeVisible();
    // 排序切换写 URL(条件全 URL,链接可分享)且回第 1 页。
    await sortSelect.selectOption("newest");
    await page.waitForURL((url) => url.searchParams.get("sort") === "newest" && !url.searchParams.has("page"), { timeout: 5_000 });
    await mediaSelect.selectOption("model3d");
    await page.waitForURL((url) => url.searchParams.get("media") === "model3d", { timeout: 5_000 });
    // 高级面板:细类/风格标签/来源资产库可见;角色因子仅大类=角色时出现(本步不展开)。
    await page.getByRole("button", { name: /^筛选/ }).click();
    const panel = page.locator('div[aria-label="高级筛选"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator('select[aria-label="细类"]')).toBeVisible();
    await expect(panel.locator('select[aria-label="来源资产库"]')).toBeVisible();
    // 结果区:资产卡网格 / 第一天引导 / 筛选空态,三态之一明确呈现,不许白屏。
    const grid = page.locator('div[class*="grid"]').first();
    const firstDay = page.getByText("把设定图拖进来");
    const noMatch = page.getByText("没有匹配的资产");
    await expect(grid.or(firstDay).or(noMatch).first()).toBeVisible({ timeout: 15_000 });
    const agent = await agentForPage(page);
    await agent.aiAssert("首屏可见:这是通用资产库浏览页,有搜索框、排序与媒体筛选控件和高级筛选面板;结果区展示资产卡片或明确的空状态。");
  }, page);
});

test("批次二子卡1 P-04:段落工作台骨架三栏+段落头带", async ({ page, agentForPage }) => {
  await loginAsAdmin(page);
  await record("b2-p04-skeleton", async () => {
    // 直达段落工作台(场=段落):项目→集→场,id 从同源 API 读
    const { projectId, episodeId, sceneId } = await page.evaluate(async () => {
      const token = window.sessionStorage.getItem("shortdrama_v01_token");
      const req = async (url: string) => (await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json()) as { data?: { items?: Array<{ id?: string }> } };
      const projects = (await req("/api/v1/projects")).data?.items ?? [];
      const pid = projects[0]?.id!;
      const episodes = (await req(`/api/v1/projects/${pid}/episodes`)).data?.items ?? [];
      const eid = episodes[0]?.id!;
      const scenes = (await req(`/api/v1/episodes/${eid}/scenes`)).data?.items ?? [];
      return { projectId: pid, episodeId: eid, sceneId: scenes[0]?.id! };
    });
    await page.goto(`${baseUrl()}/projects/${projectId}/storyboards/${episodeId}/scenes/${sceneId}`, { waitUntil: "domcontentloaded" });
    // 三栏:参考控制包(词表驱动行位,条数不写死——色卡条后端词表未播种,线上=接口条数)/
    // 段落结构(本场镜头行)/编译稿(两层)
    const pack = page.locator('aside[aria-label="参考控制包"]');
    const struct = page.locator('section[aria-label="段落结构"]');
    const draft = page.locator('aside[aria-label="编译稿"]');
    await expect(pack).toBeVisible();
    await expect(struct).toBeVisible();
    await expect(draft).toBeVisible();
    await expect(pack.getByText("角色", { exact: true })).toBeVisible();
    await expect(pack.getByText("场景", { exact: true })).toBeVisible();
    await expect(pack.getByText("道具", { exact: true })).toBeVisible();
    await expect(pack.getByText("音频", { exact: true })).toBeVisible();
    await expect(struct.locator("li").first()).toBeVisible();
    await expect(draft.getByText("包级 · 自动")).toBeVisible();
    await expect(draft.getByText("镜头结构 · 逐镜")).toBeVisible();
    // 段落头带:←段落列表/共 N 镜/就位计数/已自动保存
    await expect(page.getByRole("button", { name: "段落列表" })).toBeVisible();
    await expect(page.getByText(/共 \d+ 镜/)).toBeVisible();
    await expect(page.getByText(/控制包 \d+\/\d+ 就位/)).toBeVisible();
    const agent = await agentForPage(page);
    await agent.aiAssert("首屏可见:这是一个段落级工作台,页面分为参考控制包、段落结构(镜头列表)、编译稿三栏,顶部有段落标题和镜头数。");
  }, page);
});

test("批次二子卡2 P-04:编译稿两层+段落表联动", async ({ page, agentForPage }) => {
  await loginAsAdmin(page);
  await record("b2-p04-compile", async () => {
    const { projectId, episodeId, sceneId } = await page.evaluate(async () => {
      const token = window.sessionStorage.getItem("shortdrama_v01_token");
      const req = async (url: string) => (await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json()) as { data?: { items?: Array<{ id?: string }> } };
      const projects = (await req("/api/v1/projects")).data?.items ?? [];
      const pid = projects[0]?.id!;
      const episodes = (await req(`/api/v1/projects/${pid}/episodes`)).data?.items ?? [];
      const eid = episodes[0]?.id!;
      const scenes = (await req(`/api/v1/episodes/${eid}/scenes`)).data?.items ?? [];
      return { projectId: pid, episodeId: eid, sceneId: scenes[0]?.id! };
    });
    await page.goto(`${baseUrl()}/projects/${projectId}/storyboards/${episodeId}/scenes/${sceneId}`, { waitUntil: "domcontentloaded" });
    // 词表驱动 Lane Row:本地词表 8 条(条数不硬编码断言行数,断标题与「选」钮在场)
    const pack = page.locator('aside[aria-label="参考控制包"]');
    await expect(pack.getByRole("button", { name: "从项目资产选角色" })).toBeVisible();
    await expect(pack.getByText("默认按音效参考")).toBeVisible();
    await expect(page.getByText(/控制包 \d+\/\d+ 就位/)).toBeVisible();
    // 编译稿两层:包级·自动(空态或汇总)+镜头结构·逐镜(本场每镜一行)
    const draft = page.locator('aside[aria-label="编译稿"]');
    await expect(draft.getByText("包级 · 自动")).toBeVisible();
    await expect(draft.getByText(/控制包就位后|参考控制包——/)).toBeVisible();
    await expect(draft.getByText("镜头结构 · 逐镜")).toBeVisible();
    const perShot = draft.locator("li");
    await expect(perShot.first()).toBeVisible();
    // 段落表联动:点首行(行选择钮=行内第一枚按钮,第二枚是重生成入口) → aria-pressed + 右栏首行高亮态
    const struct = page.locator('section[aria-label="段落结构"]');
    const firstRow = struct.locator("li").first().locator("button").first();
    await firstRow.click();
    await expect(firstRow).toHaveAttribute("aria-pressed", "true");
    const agent = await agentForPage(page);
    await agent.aiAssert("首屏可见:段落工作台的编译稿栏有包级自动和逐镜两层内容,参考控制包栏有按组的参考条目与就位计数。");
  }, page);
});


test("批次二子卡3 P-04:段落版本条+时间轴+逐镜重生成(无档禁用)", async ({ page }) => {
  await loginAsAdmin(page);
  await record("b2-p04-regen", async () => {
    const { projectId, episodeId, sceneId } = await page.evaluate(async () => {
      const token = window.sessionStorage.getItem("shortdrama_v01_token");
      const req = async (url: string) => (await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json()) as { data?: { items?: Array<{ id?: string }> } };
      const projects = (await req("/api/v1/projects")).data?.items ?? [];
      const pid = projects[0]?.id!;
      const episodes = (await req(`/api/v1/projects/${pid}/episodes`)).data?.items ?? [];
      const eid = episodes[0]?.id!;
      const scenes = (await req(`/api/v1/episodes/${eid}/scenes`)).data?.items ?? [];
      return { projectId: pid, episodeId: eid, sceneId: scenes[0]?.id! };
    });
    await page.goto(`${baseUrl()}/projects/${projectId}/storyboards/${episodeId}/scenes/${sceneId}`, { waitUntil: "domcontentloaded" });
    // 段落版本条:空态如实(本地无生成记录);时间轴格数=本场镜数
    const versions = page.locator('section[aria-label="段落版本与时间轴"]');
    await expect(versions).toBeVisible();
    await expect(versions.getByText(/还没有整段生成的版本|v1/)).toBeVisible();
    const struct = page.locator('section[aria-label="段落结构"]');
    const rowCount = await struct.locator("li").count();
    await expect(versions.locator('div[role="listitem"]')).toHaveCount(rowCount);
    // 逐镜重生成钮:每行一枚;档位双态自适应(2026-08-02 dev 库 seed 视频档后环境前提变化):
    // 无档→禁用(裁决 4,不静默用本地档,也不给误提交路径);有档→可点且点开确认区(不静默提交)。
    const regenButtons = struct.getByRole("button", { name: /^(重生成|生成)$/ });
    expect(await regenButtons.count()).toBe(rowCount);
    const activeVideoTiers = await page.evaluate(async () => {
      const token = window.sessionStorage.getItem("shortdrama_v01_token");
      const res = await fetch("/api/v1/generation/capability-tiers?media_type=video", { headers: { Authorization: `Bearer ${token}` } });
      const json = (await res.json()) as { data?: { tiers?: Array<{ status?: string }> } };
      return (json.data?.tiers ?? []).filter((tier) => tier.status === "active").length;
    });
    if (activeVideoTiers === 0) {
      await expect(regenButtons.first()).toBeDisabled();
    } else {
      await expect(regenButtons.first()).toBeEnabled();
      await regenButtons.first().click();
      const confirmBox = page.locator('[aria-label*="重生成确认"]');
      await expect(confirmBox).toBeVisible();
      await confirmBox.getByRole("button", { name: "取消", exact: true }).click();
      await expect(confirmBox).toHaveCount(0);
      // 点开/收起确认区会推走视口,aiAssert 断「首屏」前先回顶部
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    /* AI 软闸退役(2026-08-02):本卡要素全部有 DOM 硬断言(版本条可见/时间轴格数=镜数/
       每行重生成钮=行数),同页同言 Midscene 两次判断相反(波动),按「AI 软闸让位 DOM 硬判」
       先例不再复述 aiAssert。 */
  }, page);
});

test("批次二子卡3b P-04:整段开拍+先出样片入口(无档禁用)", async ({ page }) => {
  await loginAsAdmin(page);
  await record("b2-p04-segment-submit", async () => {
    const { projectId, episodeId, sceneId } = await page.evaluate(async () => {
      const token = window.sessionStorage.getItem("shortdrama_v01_token");
      const req = async (url: string) => (await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json()) as { data?: { items?: Array<{ id?: string }> } };
      const projects = (await req("/api/v1/projects")).data?.items ?? [];
      const pid = projects[0]?.id!;
      const episodes = (await req(`/api/v1/projects/${pid}/episodes`)).data?.items ?? [];
      const eid = episodes[0]?.id!;
      const scenes = (await req(`/api/v1/episodes/${eid}/scenes`)).data?.items ?? [];
      return { projectId: pid, episodeId: eid, sceneId: scenes[0]?.id! };
    });
    await page.goto(`${baseUrl()}/projects/${projectId}/storyboards/${episodeId}/scenes/${sceneId}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined); // 等档位读取完,防「正在读取」竞态
    // 头带右侧:先出样片(Ghost)+开拍(Primary,SPEC 主动作);本地未配档→禁用(裁决 4,不给误提交路径)
    const sampleButton = page.getByRole("button", { name: "先出样片", exact: true });
    const shootButton = page.getByRole("button", { name: "开拍", exact: true });
    await expect(sampleButton).toBeVisible();
    await expect(shootButton).toBeVisible();
    // 等开拍钮进入稳定态再分支:shots 异步加载期间 title=「这场还没有镜头…」,
    // 档位读取期间=「正在读取档位」,都是过渡态;稳定后 enabled=有档,disabled=无档。
    await expect.poll(
      async () => (await shootButton.getAttribute("title")) ?? "",
      { timeout: 15_000 },
    ).not.toMatch(/这场还没有镜头|正在读取档位/);
    if (await shootButton.isDisabled()) {
      // 无档口径(裁决 4):禁用+title 如实说明原因
      await expect(sampleButton).toBeDisabled();
      await expect(shootButton).toHaveAttribute("title", /视频档位未配置|正在读取档位/);
    } else {
      // 有档口径:可点;点开拍=仅估价(openSeg→batchEstimate,不创建任务不付费,
      // 提交在确认区 submitSegment),断确认区真相行(估价积分)后取消——付费红线不踩。
      await expect(sampleButton).toBeEnabled();
      await shootButton.click();
      const confirmSection = page.locator('section[aria-label="整段生成确认"]');
      await expect(confirmSection).toBeVisible();
      await expect(confirmSection.getByText(/积分/)).toBeVisible();
      await confirmSection.getByRole("button", { name: "取消", exact: true }).click();
      await expect(confirmSection).toHaveCount(0);
      // 点开/收起确认区会推走视口,aiAssert 断「首屏」前先回顶部
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    // 确认区不点开不渲染(无假按钮、无静默默认)
    await expect(page.locator('section[aria-label="整段生成确认"]')).toHaveCount(0);
    /* AI 软闸退役(同子卡 3):两钮在场/双态行为均有 DOM 硬断言,Midscene 波动不复述。 */
  }, page);
});

test("批次二 P-06:剧本分镜两栏+待确认链路(头带三钮)", async ({ page, agentForPage }) => {
  await loginAsAdmin(page);
  await record("b2-p06-script", async () => {
    const projectId = await firstProjectId(page);
    await page.goto(`${baseUrl()}/projects/${projectId}/script-breakdown`, { waitUntil: "domcontentloaded" });
    // 头带三钮(SPEC 组件):导入 docx(后端端点未落地→禁用+如实 title)/重新拆解/确认分镜表(主动作 1 处)
    const docxButton = page.getByRole("button", { name: "导入 docx", exact: true });
    const rebreakButton = page.getByRole("button", { name: "重新拆解", exact: true });
    const confirmButton = page.getByRole("button", { name: "确认分镜表", exact: true });
    await expect(docxButton).toBeVisible();
    await expect(docxButton).toBeDisabled();
    await expect(rebreakButton).toBeVisible();
    await expect(confirmButton).toBeVisible();
    // 两栏(SPEC 验收基准):左剧本原文右拆解草稿
    const original = page.locator('aside[aria-label="剧本原文"]');
    const draft = page.locator('section[aria-label="拆解草稿"]');
    await expect(original).toBeVisible();
    await expect(draft).toBeVisible();
    // 确认分镜表:无草稿运行时禁用(不给误写入路径);页内确认条不点开不渲染
    await expect(confirmButton).toBeDisabled();
    await expect(page.locator('section[aria-label="确认采用拆解"]')).toHaveCount(0);
    // 左栏真实链路:新建版本→粘贴文本→保存→版本 chip 在场(vN,不重写已有版本号断言)
    await original.getByRole("button", { name: "新建版本" }).click();
    await original.locator("textarea").fill("夜·内 旧宅客厅\n林晚推开门,愣住。\n林晚:你怎么会在这里?");
    await original.getByRole("button", { name: "保存版本" }).click();
    await expect(original.getByRole("button", { name: /^v\d+/ }).first()).toBeVisible({ timeout: 10_000 });
    // 原文区:scriptText 已在 dev 亮灯(SCRIPT-VERSIONS-SCRIPT-TEXT-DONE)——pre 必显正文
    await expect(original.locator("pre")).toBeVisible({ timeout: 10_000 });
    await expect(original.locator("pre")).toContainText("林晚推开门");
    const agent = await agentForPage(page);
    await agent.aiAssert("首屏可见:这是剧本分镜页,左栏是剧本原文区,右栏是拆解草稿区,顶部有导入 docx、重新拆解、确认分镜表按钮,无需滚动即可读。");
  }, page);
});

test("批次二 P-07:项目资产定妆两件套+通用库推荐", async ({ page, agentForPage }) => {
  await loginAsAdmin(page);
  await record("b2-p07-assets", async () => {
    const projectId = await firstProjectId(page);
    await page.goto(`${baseUrl()}/projects/${projectId}/assets`, { waitUntil: "domcontentloaded" });
    // 两段(SPEC 手搭件):定妆两件套(角色就绪)+通用库推荐(拉入项目)
    const makeup = page.locator('section[aria-label="定妆两件套"]');
    const recs = page.locator('section[aria-label="通用库推荐"]');
    await expect(makeup).toBeVisible();
    await expect(recs).toBeVisible();
    // 三视图明示标注口径在场(SPEC:仅供人看不入生成参考)
    await expect(makeup.getByText(/三视图仅供人看/)).toBeVisible();
    // 两件套:角色卡(就绪 x/2 或缺失警示)或如实空态,两态之一
    const cards = makeup.locator('div[aria-label$="定妆就绪"]');
    const empty = makeup.getByText("项目还没有角色资产");
    await expect(cards.first().or(empty).first()).toBeVisible({ timeout: 15_000 });
    // 推荐行:综合排序前 4(每行一枚拉入项目 Ghost)或如实空态/读不到,三态之一
    const rows = recs.locator("li");
    const noRecs = recs.getByText("通用库还没有可推荐的资产");
    const failed = recs.getByText("推荐暂时读不到");
    await expect(rows.first().or(noRecs).or(failed).first()).toBeVisible({ timeout: 15_000 });
    if (await rows.count() > 0) {
      await expect(rows.first().getByRole("button", { name: /^(拉入项目|已引入)$/ })).toBeVisible();
    }
    // 既有 chrome 不破:本剧资产 h1+从资产中心引入主钮
    await expect(page.getByRole("heading", { name: "本剧资产" })).toBeVisible();
    await expect(page.getByRole("button", { name: "从资产中心引入" }).first()).toBeVisible();
    const agent = await agentForPage(page);
    await agent.aiAssert("首屏可见:这是项目资产页,顶部有定妆两件套角色就绪区(角色卡片或空态说明)和通用库推荐区(推荐行或明确的空态说明),下方是资产筛选区,以及资产卡网格或明确的新手引导空状态。");
  }, page);
});

test("批次二 P-03b:备戏台四行+送入这场戏真链(就位涨)", async ({ page, agentForPage }) => {
  await loginAsAdmin(page);
  await record("b2-p03b-prep", async () => {
    const ids = await page.evaluate(async () => {
      const token = window.sessionStorage.getItem("shortdrama_v01_token");
      const req = async (url: string) => (await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json()) as { data?: { items?: Array<{ id?: string }> } };
      const projects = (await req("/api/v1/projects")).data?.items ?? [];
      const pid = projects[0]?.id!;
      const episodes = (await req(`/api/v1/projects/${pid}/episodes`)).data?.items ?? [];
      const eid = episodes[0]?.id!;
      const scenes = (await req(`/api/v1/episodes/${eid}/scenes`)).data?.items ?? [];
      return { projectId: pid, episodeId: eid, sceneId: scenes[0]?.id! };
    });
    await page.goto(`${baseUrl()}/assets/prep`, { waitUntil: "domcontentloaded" });
    // 结构:tab(检索→P-03a/备戏 current)+三级选择器+送入这场戏(空备戏单禁用)
    await expect(page.locator('div[aria-label="备戏台"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "检索", exact: true })).toBeVisible();
    await expect(page.locator('select[aria-label="选择项目"]')).toBeVisible();
    await expect(page.locator('select[aria-label="选择场"]')).toBeVisible();
    const sendButton = page.getByRole("button", { name: "送入这场戏", exact: true });
    await expect(sendButton).toBeVisible();
    await expect(sendButton).toBeDisabled();
    // 备戏行×4(SPEC 实体×2/抽象×1/动态×1)
    for (const label of ["备戏 角色", "备戏 场景", "备戏 光影", "备戏 参考视频"] as const) {
      await expect(page.locator(`section[aria-label="${label}"]`)).toBeVisible();
    }
    const counter = page.locator('p[aria-label="备戏单计数"]');
    await expect(counter).toBeVisible();
    const before = Number((await counter.textContent())?.match(/已就位 (\d+)/)?.[1] ?? "-1");
    expect(before, "计数行应给出已就位数").toBeGreaterThanOrEqual(0);
    // 真链备件:同源 API 建空资产(光影类)→备戏单 localStorage 暂存(裁定③口径)
    const stagedName = `E2E 备戏件 ${Date.now() % 100000}`;
    await page.evaluate(async ({ sceneId, name }) => {
      const token = window.sessionStorage.getItem("shortdrama_v01_token");
      // S17-B:建档 POST 可能因索引服务缺配置回假 500,实体其实已写——回查兜底拿 id
      await fetch("/api/v1/asset-ingest/json/assets", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ assets: [{ asset_kind: "lighting", name }] }),
      }).catch(() => undefined);
      const response = await fetch(`/api/v1/assets?scope=personal&query=${encodeURIComponent(name)}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await response.json() as { data?: { items?: Array<{ id?: string; name?: string }> } };
      const assetId = (body.data?.items ?? []).find((item) => item.name === name)?.id ?? body.data?.items?.[0]?.id;
      if (!assetId) throw new Error("建空资产失败");
      window.localStorage.setItem(`shortdrama_prep_v1:${sceneId}`, JSON.stringify([{ assetId, name, lane: "lighting" }]));
    }, { sceneId: ids.sceneId, name: stagedName });
    await page.reload({ waitUntil: "domcontentloaded" });
    // 待传 1+送入转亮;虚位教学(还缺行)与就位条目不装
    await expect(page.locator('p[aria-label="备戏单计数"]')).toContainText("已拉 1 件");
    await expect(sendButton).toBeEnabled();
    // 送入这场戏→真链(addProjectAsset→seedLanes)→P-04 工作台;工件在参考控制包现身
    await sendButton.click();
    await page.waitForURL((url) => url.pathname.includes(`/scenes/${ids.sceneId}`), { timeout: 15_000 });
    await expect(page.locator('aside[aria-label="参考控制包"]')).toBeVisible();
    await expect(page.locator('aside[aria-label="参考控制包"]').getByText(stagedName)).toBeVisible({ timeout: 10_000 });
    // 回备戏台:已就位 +1(端到端真链,不做假搬运)
    await page.goto(`${baseUrl()}/assets/prep`, { waitUntil: "domcontentloaded" });
    await expect(page.locator('p[aria-label="备戏单计数"]')).toContainText(`已就位 ${before + 1}`, { timeout: 10_000 });
    const agent = await agentForPage(page);
    await agent.aiAssert("首屏可见:这是备戏台页面,顶部有检索/备戏页签和项目/集/场选择器与「送入这场戏」按钮,下方是角色、场景、光影、参考视频四个备戏行,每行显示已就位条目或空缺提示。");
  }, page);
});

test("批次二收尾:镜头级工作台 lanes 跨页预写存活(StrictMode 双跑不冲刷)", async ({ page }) => {
  await loginAsAdmin(page);
  await record("b2-sibling-lanes", async () => {
    // 复现结论=不犯:镜头级只有动作时点 save(commitLanes/attachItemToLane),无 lanesState 监听 save effect,
    // mount 双跑只读不写;本 test 锁防回潮——预写 workshop 条目,首次进入与二次进入都必须存活。
    const ids = await page.evaluate(async () => {
      const token = window.sessionStorage.getItem("shortdrama_v01_token");
      const req = async (url: string) => (await (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json()) as { data?: { items?: Array<{ id?: string }> } };
      const projects = (await req("/api/v1/projects")).data?.items ?? [];
      const pid = projects[0]?.id!;
      const episodes = (await req(`/api/v1/projects/${pid}/episodes`)).data?.items ?? [];
      const eid = episodes[0]?.id!;
      const shots = (await req(`/api/v1/episodes/${eid}/shots`)).data?.items ?? [];
      return { projectId: pid, episodeId: eid, shotId: shots[0]?.id! };
    });
    const url = `${baseUrl()}/projects/${ids.projectId}/storyboards/${ids.episodeId}/shots/${ids.shotId}`;
    const storageKey = `shortdrama_lanes_v2:${ids.shotId}`;
    const payload = JSON.stringify({ workshopItems: { camera_motion: [{ id: "note:camera_motion", name: "E2E 预写运镜", kind: "text", origin: "workshop" }] } });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.evaluate(({ key, value }) => window.localStorage.setItem(key, value), { key: storageKey, value: payload });
    // 首进(mount+StrictMode 双跑):条目须渲染且仓不被冲
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("E2E 预写运镜")).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate((key) => window.localStorage.getItem(key), storageKey)).toContain("E2E 预写运镜");
    // 二进(再来一遍双跑):仍须存活
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByText("E2E 预写运镜")).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate((key) => window.localStorage.getItem(key), storageKey)).toContain("E2E 预写运镜");
  }, page);
});
