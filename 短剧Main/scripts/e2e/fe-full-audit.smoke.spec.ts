import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test as base } from "@playwright/test";
import { PlaywrightAiFixture, type PlayWrightAiFixtureType } from "@midscene/web/playwright";
import { assertProductionTargetAllowed, E2E_PRODUCTION_HOSTS } from "./production-target-guard.js";

const test = base.extend<PlayWrightAiFixtureType>(PlaywrightAiFixture());

/**
 * fe-full-audit:测试站全功能端到端 × 三真源对账(PRD 产品哲学 / Plane 工作项 / Figma 原型)。
 * 增量于 sgoal06 smoke(登录+9 页+一次生图)——本 suite 不重复其覆盖,不提交任何付费生成。
 * 每个 step 带对账维度:plane=工作项序号,figma=原型帧,philosophy=产品原则(P1 先给草稿/P2 决定集中/P3 一次点击/P4 克制渐进/P5 业务语言)。
 */

const DEFAULT_BASE_URL = "https://shortdrama-main-test.col.com";
const artifactDir = path.resolve(process.env.FE_FULL_AUDIT_ARTIFACT_DIR ?? "artifacts/fe-full-audit");
const screenshotDir = path.join(artifactDir, "screenshots");
const summaryPath = path.join(artifactDir, "audit-summary.json");
const productionHosts = E2E_PRODUCTION_HOSTS;

type AuditStep = {
  name: string;
  url?: string;
  ok: boolean;
  plane?: string;
  figma?: string;
  philosophy?: string;
  screenshot?: string;
  error?: string;
  details?: Record<string, string | number | boolean | null>;
};

const steps: AuditStep[] = [];

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}(值不会输出到报告)`);
  return value;
}

function safeBaseUrl(): string {
  const configured = process.env.SGOAL06_BASE_URL ?? DEFAULT_BASE_URL;
  const url = new URL(configured);
  if (!/^https?:$/.test(url.protocol)) throw new Error("SGOAL06_BASE_URL 必须是 http(s) 地址");
  assertProductionTargetAllowed(url, productionHosts);
  return url.origin;
}

function safeFilename(name: string): string {
  return name.replaceAll(/[^a-z0-9]+/gi, "-").replaceAll(/^-|-$/g, "").toLowerCase();
}

async function assertPageIsNotBlank(page: import("@playwright/test").Page): Promise<void> {
  const main = page.locator("#main-content, main").first();
  await expect(main).toBeVisible();
  const state = await main.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      textLength: (element.textContent ?? "").trim().length,
      descendants: element.querySelectorAll("*").length,
    };
  });
  expect(state.width, "主内容区宽度").toBeGreaterThan(100);
  expect(state.height, "主内容区高度").toBeGreaterThan(100);
  expect(state.descendants, "主内容区节点数").toBeGreaterThan(2);
  expect(state.textLength, "主内容区至少包含可读状态或标签").toBeGreaterThan(0);
}

async function recordPage(
  page: import("@playwright/test").Page,
  agentForPage: PlayWrightAiFixtureType["agentForPage"],
  name: string,
  assertion: string,
  meta: { plane?: string; figma?: string; philosophy?: string },
): Promise<void> {
  const step: AuditStep = { name, url: page.url(), ok: false, ...meta };
  try {
    await assertPageIsNotBlank(page);
    const agent = await agentForPage(page);
    await agent.aiAssert(assertion);
    step.ok = true;
  } catch (error) {
    const screenshot = path.join(screenshotDir, `${safeFilename(name)}-failed.png`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
    step.screenshot = screenshot;
    step.error = error instanceof Error ? error.message : String(error);
  }
  steps.push(step);
}

async function recordRaw(
  name: string,
  page: import("@playwright/test").Page,
  fn: () => Promise<Record<string, string | number | boolean | null> | undefined>,
  meta: { plane?: string; figma?: string; philosophy?: string } = {},
): Promise<void> {
  const step: AuditStep = { name, url: page.url(), ok: false, ...meta };
  try {
    step.details = (await fn()) ?? undefined;
    step.ok = true;
  } catch (error) {
    const screenshot = path.join(screenshotDir, `${safeFilename(name)}-failed.png`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
    step.screenshot = screenshot;
    step.error = error instanceof Error ? error.message : String(error);
  }
  steps.push(step);
}

let baseUrl = "";

test.beforeAll(async () => {
  baseUrl = safeBaseUrl();
  await mkdir(screenshotDir, { recursive: true });
});

async function login(page: import("@playwright/test").Page): Promise<void> {
  const username = requiredEnv("TEST_ENV_ADMIN_USERNAME");
  const password = requiredEnv("TEST_ENV_ADMIN_PASSWORD");
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  // 账号框 autoComplete 按 allowRegister 合法切换(email/username,F08)，选择器改用不随之变的 data-testid。
  await page.getByTestId("login-username-input").fill(username);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-button").click();
  await page.waitForURL((url) => url.pathname === "/projects", { timeout: 30_000 });
}

// ---------- T1 获客与项目 ----------

test("T1 获客与项目:landing→login→projects→topics", async ({ page, agentForPage }) => {
  requiredEnv("MIDSCENE_MODEL_API_KEY");
  requiredEnv("MIDSCENE_MODEL_NAME");

  await page.goto(`${baseUrl}/landing`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await recordPage(page, agentForPage, "landing_hero",
    "这是短剧生产平台的游客首页:用片场/短剧业务语言(非技术黑话)说明产品价值,有明确的主行动入口(进入片场/登录),页面克制不堆砌。",
    { figma: "P-01a", philosophy: "P4 克制渐进 / P5 业务语言" });

  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("login-username-input").waitFor({ state: "visible", timeout: 15_000 });
  await recordRaw("login_page", page, async () => {
    // DOM 硬断言:表单元素真实存在。本页是 AI 断言不适区(暗色低对比表单+居中印章,视觉模型连续两次误判无表单),不做 aiAssert。
    // 账号框 autoComplete 按 allowRegister 合法切换(email/username,F08)，选择器改用不随之变的 data-testid。
    const user = await page.getByTestId("login-username-input").isVisible();
    const pass = await page.getByTestId("login-password-input").isVisible();
    const submit = await page.getByTestId("login-submit-button").innerText();
    if (!user || !pass) throw new Error("登录表单输入缺失");
    if (!/登录/.test(submit)) throw new Error("主按钮文案异常:" + submit);
    const alertCount = await page.locator("[role='alert']").count();
    return { submit_text: submit.trim(), alerts: alertCount, ai_assert: "skipped(此页 AI 稳定误判)" };
  }, { figma: "P-01b", philosophy: "P3 一次点击 / P5 业务语言" });

  await login(page);

  await recordPage(page, agentForPage, "projects_board",
    "这是已登录的项目管理页:能看到项目卡片、「继续上次工作」或明确的项目入口、新建项目入口,页面不是报错或空白。",
    { plane: "#1 项目与分镜基本盘", figma: "P-02", philosophy: "P2 决定集中" });

  await recordRaw("projects_new_flow", page, async () => {
    const btn = page.getByRole("button", { name: /新建项目|新建|创建/ }).first();
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) throw new Error("找不到新建项目入口");
    await btn.click();
    await page.waitForTimeout(800);
    const dialogVisible = await page.locator("[role='dialog'], form").first().isVisible().catch(() => false);
    const agent = await agentForPage(page);
    await agent.aiAssert("当前出现新建项目的表单或弹层,字段是业务语言(如项目名/剧目),没有技术术语。");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    return { dialog_shown: dialogVisible };
  }, { plane: "#1", figma: "P-02", philosophy: "P3 一次点击" });

  const topicsResp = await page.goto(`${baseUrl}/topics`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await recordRaw("topics_board", page, async () => {
    const bodyText = await page.locator("body").innerText();
    const is404 = bodyText.includes("页面不存在");
    if (is404) {
      // #13 卡注明「已发布,默认关闭(付费数据源)」——404 符合开关语义,但「页面不存在」文案误导,记漂移。
      return { http: topicsResp?.status() ?? 0, feature_off_as_404: true, drift: "开关关闭呈现为『页面不存在』,宜为『该功能未开启』" };
    }
    const agent = await agentForPage(page);
    await agent.aiAssert("这是短剧热度榜页:呈现热度榜单或选题卡片;若数据源暂时读不到或未开通,页面给出明确状态说明(如『榜单暂时读不到』+重试),也算符合口径。注意:右下角的通知浮层与页面内容无关,忽略它。");
    return { http: topicsResp?.status() ?? 0, feature_off_as_404: false };
  }, { plane: "#13 选题热度雷达", figma: "P-05", philosophy: "P1 先给草稿" });
});

// ---------- T2 一集戏动线(分镜→资产→工作台) ----------

test("T2 一集戏动线:storyboards→assets→workbench", async ({ page, agentForPage }) => {
  await login(page);

  // 用 API 探项目/剧集/镜头,URL 直达(同 sgoal06 discoverProjectPath)
  const ids = await page.evaluate(async () => {
    const token = window.sessionStorage.getItem("shortdrama_v01_token");
    if (!token) throw new Error("登录后未找到会话");
    const headers = { Authorization: `Bearer ${token}` };
    const request = async (url: string) => {
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`${url} 返回 ${response.status}`);
      return response.json() as Promise<{ data?: { items?: Array<{ id?: string }> } }>;
    };
    const projects = (await request("/api/v1/projects")).data?.items ?? [];
    const projectId = projects[0]?.id;
    if (!projectId) throw new Error("认证账号没有可用项目");
    const episodes = (await request(`/api/v1/projects/${encodeURIComponent(projectId)}/episodes`)).data?.items ?? [];
    const episodeId = episodes[0]?.id;
    if (!episodeId) throw new Error("项目没有可用剧集");
    const shots = (await request(`/api/v1/episodes/${encodeURIComponent(episodeId)}/shots`)).data?.items ?? [];
    const shotId = shots[0]?.id;
    return { projectId, episodeId, shotId };
  });

  /* 块 2:旧 /storyboards 换乘到生产页(集视图);此段顺带断言 redirect 生效。 */
  await page.goto(`${baseUrl}/projects/${ids.projectId}/storyboards`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname === `/projects/${ids.projectId}/production`, { timeout: 10_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await recordPage(page, agentForPage, "production_view_page",
    "这是项目的生产页(集视图):能看到本集各场的进度状态与场卡列表,有下一步操作入口,不是空白页,也不是旧的镜头平铺列表。",
    { plane: "#17 剧本一键拆解", figma: "P-02b", philosophy: "P1 先给草稿" });

  await page.goto(`${baseUrl}/assets?scope=personal`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await recordPage(page, agentForPage, "assets_center",
    "这是资产中心:有角色/场景/道具等创作词汇分类与资产卡片,卡片有缩略图或明确的空态说明,不是技术表格。",
    { plane: "#12 资产智能搜索 / #9 参考控制包", figma: "P-03a", philosophy: "P5 业务语言" });

  await recordRaw("assets_search_rain", page, async () => {
    const search = page.locator("input[type='search'], input[placeholder*='搜'], input[placeholder*='检索']").first();
    await search.fill("雨夜");
    await page.waitForTimeout(1500);
    const agent = await agentForPage(page);
    await agent.aiAssert("搜索「雨夜」后,结果区域呈现资产卡片列表或明确的空态提示(不是无反应,也不是报错或白屏);语义搜索的结果排序由服务端决定,不要求逐张与关键词字面相关。");
    return { query: "雨夜" };
  }, { plane: "#12", figma: "P-03a", philosophy: "P1 先给草稿" });

  await recordRaw("assets_rehearsal_mode", page, async () => {
    const tab = page.getByRole("tab", { name: /备戏/ }).or(page.getByRole("button", { name: /备戏/ })).first();
    const visible = await tab.isVisible().catch(() => false);
    if (!visible) {
      // 资产中心全局页无备戏入口——备戏是「某场戏」的上下文,入口应在项目/镜头侧;记漂移观察。
      return { rehearsal_entry_on_global_assets: false, drift: "全局资产中心无备戏入口,Figma P-03b 为资产中心双模式之一,需裁:入口搬家 or 原型超前" };
    }
    await tab.click();
    await page.waitForTimeout(1200);
    const agent = await agentForPage(page);
    await agent.aiAssert("这是备戏台/备戏模式:按某场戏的需求组织素材,能区分已就位与还缺,文案是片场语言。");
    return { rehearsal_entry_on_global_assets: true };
  }, { plane: "#9", figma: "P-03b", philosophy: "P5 业务语言" });

  if (ids.shotId) {
    /* 块 2:镜级 URL=换乘口——按归属场落段落(场)工作台;未分场兜底生产页。两种落点都合法,断言不再停留在换乘口。 */
    await page.goto(`${baseUrl}/projects/${ids.projectId}/storyboards/${ids.episodeId}/shots/${ids.shotId}`, { waitUntil: "domcontentloaded" });
    await page.waitForURL((url) => !url.pathname.includes("/shots/"), { timeout: 10_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    const landedOnScene = page.url().includes("/scenes/");
    await recordPage(page, agentForPage, "shot_url_transfer",
      landedOnScene
        ? "这是段落(场)工作台:页面主体是参考控制包的多条待命区(角色/场景/道具/光影/运镜/参考视频等),有整段生成或逐镜生成入口(费用在生成前的确认环节单独呈现,不在按钮上标价)。"
        : "这是项目的生产页(集视图):镜头链接因未分场而落到生产页列表,能看到各场进度,不是报错页。",
      { plane: "#9 参考控制包 / #2 生成前先报价", figma: landedOnScene ? "P-04" : "P-02b", philosophy: "P1 先给草稿 / V-46 先报价" });
  }
});

// ---------- T3 全局面 ----------

test("T3 全局面:queue→costs→dashboard→admin→trash→settings→ai→keyboard", async ({ page, agentForPage }) => {
  await login(page);

  await page.goto(`${baseUrl}/queue`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await recordRaw("queue_page", page, async () => {
    const bodyText = await page.locator("body").innerText();
    if (bodyText.includes("页面不存在")) {
      // dev(5173)有 /queue 且 fe-b1 卡4 PASS,测试站 404=部署版本未含该路由,记部署漂移。
      return { route_404: true, drift: "/queue 在 dev 存在(fe-b1 PASS)但测试站 404——测试站部署版本滞后或未放行" };
    }
    const agent = await agentForPage(page);
    await agent.aiAssert("这是生产队列页:任务状态用业务语言(排队中/生成中/失败),失败任务给出下一步补救动作,页面无英文报错堆栈。");
    return { route_404: false };
  }, { plane: "#1 项目与分镜基本盘", figma: "P-10", philosophy: "P2 决定集中 / 失败给下一步" });

  await page.goto(`${baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await recordPage(page, agentForPage, "dashboard_page",
    "这是数据看板:呈现生产/消耗相关指标(如在拍项目/本月消耗/产物数),数字清晰,页面克制不堆砌。",
    { plane: "#11 平台角色与成本视图", figma: "P-09", philosophy: "P4 克制渐进" });

  await recordRaw("costs_page", page, async () => {
    // 消耗页挂在项目下,先探项目 id
    const projectId = await page.evaluate(async () => {
      const token = window.sessionStorage.getItem("shortdrama_v01_token");
      const headers = { Authorization: `Bearer ${token}` };
      const response = await fetch("/api/v1/projects", { headers });
      const json = await response.json() as { data?: { items?: Array<{ id?: string }> } };
      return json.data?.items?.[0]?.id ?? null;
    });
    if (!projectId) throw new Error("无可用项目,无法进消耗页");
    await page.goto(`${baseUrl}/projects/${projectId}/costs`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const agent = await agentForPage(page);
    await agent.aiAssert("这是项目消耗页:呈现本集已花积分大数字与逐笔明细列表,数字精确;预算或用量进度无数据源时不伪造,可以不出现。",
      );
    return { projectId };
  }, { plane: "#27 成本算得清", figma: "P-08", philosophy: "V-46 先报价" });

  await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await recordPage(page, agentForPage, "admin_console",
    "这是管理后台:有用户/批次/审核或系统配置类内容,信息分层可读,不是报错页。",
    { plane: "#6 管理控制台", figma: "P-11", philosophy: "P4 克制渐进" });

  await page.goto(`${baseUrl}/trash`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await recordPage(page, agentForPage, "trash_page",
    "这是回收站:说明内容会保留多久、如何恢复或彻底删除,文案清楚不吓人,或明确展示空态。",
    { philosophy: "P5 业务语言 / 失败给下一步" });

  await page.goto(`${baseUrl}/settings`, { waitUntil: "domcontentloaded" });
  await recordPage(page, agentForPage, "settings_page",
    "这是设置页:包含可读的账户/偏好/提示词或内容管理设置,保存类动作有反馈。",
    { plane: "#19 内容改动不用发版", philosophy: "P4 克制渐进" });

  await recordRaw("ai_assistant_entry", page, async () => {
    await page.goto(`${baseUrl}/projects`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const entry = page.getByText("AI 工作区", { exact: false }).first();
    const visible = await entry.isVisible().catch(() => false);
    if (!visible) return { entry_found: false, note: "AI 工作区入口未找到" };
    await entry.click();
    await page.waitForTimeout(1500);
    const agent = await agentForPage(page);
    await agent.aiAssert("出现 AI 助手/工作区面板:以对话形式呈现,有输入框,或给出当前可做的下一步建议。");
    return { entry_found: true };
  }, { plane: "#30 会追问的助手", figma: "P-12c", philosophy: "P1 先给草稿" });

  await recordRaw("keyboard_jump", page, async () => {
    // 优先点 nav 的 ⌘K 按钮(headless 键盘 Meta 映射不稳),再试键盘
    const navBtn = page.getByText("搜索、跳转与命令", { exact: false }).first();
    if (await navBtn.isVisible().catch(() => false)) {
      await navBtn.click();
    } else {
      await page.keyboard.press("Control+k");
    }
    await page.waitForTimeout(800);
    const palette = page.locator("[role='dialog'], [cmdk-root], [class*='command'], [class*='palette']").first();
    const visible = await palette.isVisible().catch(() => false);
    if (!visible) throw new Error("⌘K(按钮与键盘)均未叫出全局跳转菜单");
    await page.keyboard.press("Escape");
    return { palette_shown: true };
  }, { plane: "#29 一个快捷键叫出全站", philosophy: "P3 一次点击" });
});

// ---------- 汇总 ----------

test.afterAll(async () => {
  const { writeFile } = await import("node:fs/promises");
  const summary = {
    goal: "fe-full-audit 全功能对账",
    base_url: baseUrl,
    ok: steps.every((s) => s.ok),
    steps,
    reports: {
      playwright_json: path.join(artifactDir, "playwright-results.json"),
      midscene_html_directory: path.join(artifactDir, "midscene", "report"),
    },
  };
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`[fe-full-audit] summary -> ${summaryPath}`);
  console.log(`[fe-full-audit] ${steps.filter((s) => s.ok).length}/${steps.length} steps ok`);
});
