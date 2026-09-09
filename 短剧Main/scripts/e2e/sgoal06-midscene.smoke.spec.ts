import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, test as base } from "@playwright/test";
import { PlaywrightAiFixture, type PlayWrightAiFixtureType } from "@midscene/web/playwright";
import { assertProductionTargetAllowed, E2E_PRODUCTION_HOSTS } from "./production-target-guard.js";

const test = base.extend<PlayWrightAiFixtureType>(PlaywrightAiFixture());

const DEFAULT_BASE_URL = "https://shortdrama-main-test.col.com";
const artifactDir = path.resolve(process.env.SGOAL06_ARTIFACT_DIR ?? "artifacts/sgoal06-midscene");
const screenshotDir = path.join(artifactDir, "screenshots");
const summaryPath = path.join(artifactDir, "smoke-summary.json");
const DEFAULT_FEEDBACK_MAX_MS = 500;
const productionHosts = E2E_PRODUCTION_HOSTS;

type SmokeStep = {
  name: string;
  url?: string;
  ok: boolean;
  screenshot?: string;
  error?: string;
  details?: Record<string, string | number | boolean | null>;
};

type FeedbackProbe = {
  action: string;
  ok: boolean;
  observed_ms: number;
  max_ms: number;
  feedback_kind?: string;
  error?: string;
  reused_evidence?: boolean;
  source_summary?: string;
};

const steps: SmokeStep[] = [];
const feedbackProbes: FeedbackProbe[] = [];

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}（值不会输出到报告）`);
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

async function waitForBusinessReady(
  readyLocator: import("@playwright/test").Locator,
): Promise<void> {
  await expect(readyLocator.first()).toBeVisible({
    timeout: Number(process.env.SGOAL06_PAGE_READY_TIMEOUT_MS ?? 30_000),
  });
}

async function recordPage(
  page: import("@playwright/test").Page,
  agentForPage: PlayWrightAiFixtureType["agentForPage"],
  name: string,
  assertion: string,
  readyLocator?: import("@playwright/test").Locator,
): Promise<void> {
  const step: SmokeStep = { name, url: page.url(), ok: false };
  try {
    if (readyLocator) await waitForBusinessReady(readyLocator);
    await assertPageIsNotBlank(page);
    // Midscene 不参与登录输入；只在页面已认证后的可见内容上做自然语言断言。
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

async function performWithVisibleFeedback(
  page: import("@playwright/test").Page,
  action: "request_image_generation" | "confirm_image_generation",
  perform: () => Promise<void>,
): Promise<void> {
  const startedAt = performance.now();
  const probe: FeedbackProbe = {
    action,
    ok: false,
    observed_ms: 0,
    max_ms: DEFAULT_FEEDBACK_MAX_MS,
  };
  try {
    const before = await page.evaluate((actionName) => {
      const visible = (element: Element | undefined): boolean => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) > 0
          && rect.width > 0
          && rect.height > 0;
      };
      const buttons = [...document.querySelectorAll("button")];
      const alert = [...document.querySelectorAll("[role='alert']")].find(visible);
      const status = document.body.innerText.match(/已提交|生成中|提交中|处理中/u)?.[0] ?? "";
      const confirm = buttons.find((button) => button.textContent?.trim() === "确认费用并生成");
      const generate = buttons.find((button) => button.textContent?.trim() === "确认生成") as HTMLButtonElement | undefined;
      return JSON.stringify({
        actionName,
        alert: alert?.textContent?.trim() ?? "",
        status,
        confirmVisible: visible(confirm),
        generatePending: visible(generate) && (generate?.disabled === true || generate?.getAttribute("aria-busy") === "true"),
      });
    }, action);
    await perform();
    const handle = await page.waitForFunction(({ actionName, previous }) => {
      const visible = (element: Element | undefined): boolean => {
        if (!(element instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) > 0
          && rect.width > 0
          && rect.height > 0;
      };
      const bodyText = document.body.innerText;
      const alert = [...document.querySelectorAll("[role='alert']")].find(visible);
      const buttons = [...document.querySelectorAll("button")];
      const confirm = buttons.find((button) => button.textContent?.trim() === "确认费用并生成");
      const generate = buttons.find((button) => button.textContent?.trim() === "确认生成") as HTMLButtonElement | undefined;
      const status = bodyText.match(/已提交|生成中|提交中|处理中/u)?.[0] ?? "";
      const current = JSON.stringify({
        actionName,
        alert: alert?.textContent?.trim() ?? "",
        status,
        confirmVisible: visible(confirm),
        generatePending: visible(generate) && (generate?.disabled === true || generate?.getAttribute("aria-busy") === "true"),
      });
      if (current === previous) return null;
      if (alert) return "alert";
      if (status) return "status_text";
      if (actionName === "request_segment_generation" && visible(confirm)) return "cost_confirmation";
      if (actionName === "confirm_segment_generation" && !visible(generate)) return "confirmation_closed";
      if (visible(generate) && (generate?.disabled === true || generate?.getAttribute("aria-busy") === "true")) {
        return "button_pending";
      }
      return null;
    }, { actionName: action, previous: before }, { timeout: DEFAULT_FEEDBACK_MAX_MS });
    probe.feedback_kind = await handle.jsonValue() as string;
    probe.ok = true;
  } catch (error) {
    probe.error = error instanceof Error ? error.message : String(error);
    if (!probe.error.includes("Timeout")) throw error;
  } finally {
    probe.observed_ms = Math.round(performance.now() - startedAt);
    feedbackProbes.push(probe);
  }
}

async function discoverProjectPath(page: import("@playwright/test").Page): Promise<{ projectId: string; episodeId: string; shotId: string; sceneId: string }> {
  return page.evaluate(async () => {
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
    if (!shotId) throw new Error("剧集没有可用镜头");
    /* sgoal06 块 3:段落工作台交互需要 sceneId(场=段落),镜级换乘验证仍用 shotId。 */
    const scenes = (await request(`/api/v1/episodes/${encodeURIComponent(episodeId)}/scenes`)).data?.items ?? [];
    const sceneId = scenes[0]?.id;
    if (!sceneId) throw new Error("剧集没有可用场景(段落)");
    return { projectId, episodeId, shotId, sceneId };
  });
}

async function submitOneSegmentGeneration(
  page: import("@playwright/test").Page,
  ids: { projectId: string; episodeId: string; sceneId: string },
  baseUrl: string,
): Promise<void> {
  const step: SmokeStep = { name: "segment_generation_once", url: page.url(), ok: false };
  try {
    /* sgoal06 块 3 改造(2026-08-03):生成从段落语境自然发起——段落工作台逐镜重生成
       (单任务=最便宜档),旧镜级单图表单从动线与冒烟里退役。
       付费保护语义不变:一次点击只建一个任务,无重试分支无循环;低于复核阈值直接提交,
       若服务端仍要求复核,只确认这张已报价任务一次。 */
    await page.goto(`${baseUrl}/projects/${ids.projectId}/storyboards/${ids.episodeId}/scenes/${ids.sceneId}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "开拍", exact: true }).waitFor({ state: "visible", timeout: 30_000 });

    /* 逐镜入口:每镜行尾 ghost 钮(已有产物=「重生成」,无=「生成」),一次点击一个任务。 */
    const regen = page.getByRole("button", { name: /^(重生成|生成)$/ }).first();
    await expect(regen).toBeEnabled();
    await performWithVisibleFeedback(page, "request_segment_generation", () => regen.click());

    /* 页内确认区:真相条+档位档价+该镜依据;报价金额与档位截图留证(判据 3)。 */
    const confirmArea = page.locator('[aria-label*="重生成确认"]').first();
    await expect(confirmArea).toBeVisible({ timeout: 10_000 });
    const quoteLine = (await confirmArea.innerText()).replaceAll(/\s+/g, " ").trim().slice(0, 200);
    await page.screenshot({ path: path.join(screenshotDir, "segment-quote-confirm.png"), fullPage: true });

    const confirm = page.getByRole("button", { name: "确认生成", exact: true });
    await expect(confirm).toBeEnabled();
    const sinceIso = new Date(Date.now() - 120_000).toISOString();
    await performWithVisibleFeedback(page, "confirm_segment_generation", () => confirm.click());

    /* 提交结果:成功=「镜头 #N 已提交,队列处理中」toast;页面明确失败(含人话原因)也记链到达;
       超复核阈值→按钮转「确认费用并生成」,只再确认一次同一张已报价任务。 */
    const outcomeTimeout = Number(process.env.SGOAL06_GENERATION_OUTCOME_TIMEOUT_MS ?? 45_000);
    const submittedPromise = page.waitForFunction(() => {
      const text = document.body.innerText;
      if (/镜头 #\d+ 已提交/.test(text) || text.includes("已提交,队列处理中")) return "submitted";
      const alert = document.querySelector("[role='alert']")?.textContent?.trim();
      if (alert) return `failed:${alert}`;
      return null;
    }, undefined, { timeout: outcomeTimeout }).then((handle) => handle.jsonValue() as Promise<string>);

    const review = page.getByRole("button", { name: "确认费用并生成", exact: true });
    const reviewPromise = review.waitFor({ state: "visible", timeout: outcomeTimeout })
      .then(() => performWithVisibleFeedback(page, "confirm_segment_generation", () => review.click()))
      .catch(() => new Promise<never>(() => undefined));
    const first = await Promise.race([
      submittedPromise.then((value) => ({ kind: "outcome" as const, value })),
      reviewPromise.then(() => ({ kind: "reviewed" as const })),
    ]);
    const submitted = first.kind === "outcome" ? first.value : await submittedPromise;

    /* 产物回填:轮询本项目提交时刻后的最新任务到终态(succeeded/failed);
       超时记 timeout(链已到达,回填未等到,如实)。回填后重载页面截版本条留证。 */
    const refillTimeout = Number(process.env.SGOAL06_SEGMENT_REFILL_TIMEOUT_MS ?? 360_000);
    const refill = await page.evaluate(
      async ({ projectId, since, timeoutMs }) => {
        const token = window.sessionStorage.getItem("shortdrama_v01_token");
        if (!token) return "no_token";
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/generations`, { headers: { Authorization: `Bearer ${token}` } });
          if (response.ok) {
            const body = await response.json() as { data?: { items?: Array<{ status?: string; created_at?: string }> } };
            const latest = (body.data?.items ?? [])
              .filter((task) => String(task.created_at ?? "") >= since)
              .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0];
            if (latest?.status === "succeeded") return "succeeded";
            if (latest?.status === "failed") return "failed";
          }
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        }
        return "timeout";
      },
      { projectId: ids.projectId, since: sinceIso, timeoutMs: refillTimeout },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "开拍", exact: true }).waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
    await page.screenshot({ path: path.join(screenshotDir, "segment-outcome.png"), fullPage: true });

    step.url = page.url();
    step.ok = true;
    step.details = {
      chain_reached: true,
      outcome: submitted.startsWith("failed:") ? "failed" : submitted,
      failure_reason: submitted.startsWith("failed:") ? submitted.slice("failed:".length) : null,
      refill_outcome: refill,
      quote_line: quoteLine,
      paid_once: true,
    };
  } catch (error) {
    const screenshot = path.join(screenshotDir, "segment-generation-once-failed.png");
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
    step.screenshot = screenshot;
    step.error = error instanceof Error ? error.message : String(error);
  }
  steps.push(step);
}

async function reusePriorGenerationEvidence(baseUrl: string): Promise<boolean> {
  const configured = process.env.SGOAL06_REUSE_GENERATION_EVIDENCE?.trim();
  if (!configured) return false;
  const evidencePath = path.resolve(configured);
  const prior = JSON.parse(await readFile(evidencePath, "utf8")) as {
    base_url?: unknown;
    steps?: Array<{ name?: unknown; ok?: unknown; details?: Record<string, unknown> }>;
    feedback_probes?: Array<{
      action?: unknown;
      ok?: unknown;
      observed_ms?: unknown;
      max_ms?: unknown;
      feedback_kind?: unknown;
    }>;
  };
  if (prior.base_url !== baseUrl) throw new Error("历史生图证据与本次测试站不一致");
  const generation = prior.steps?.find((step) => step.name === "segment_generation_once");
  if (generation?.ok !== true || generation.details?.chain_reached !== true) {
    throw new Error("历史生成证据未证明生成链已到达");
  }
  steps.push({
    name: "segment_generation_once",
    url: pageUrlFromEvidence(prior.steps),
    ok: true,
    details: {
      chain_reached: true,
      outcome: typeof generation.details.outcome === "string" ? generation.details.outcome : "recorded",
      reused_evidence: true,
      source_summary: evidencePath,
    },
  });
  for (const probe of prior.feedback_probes ?? []) {
    if (
      typeof probe.action === "string"
      && typeof probe.observed_ms === "number"
      && typeof probe.max_ms === "number"
    ) {
      feedbackProbes.push({
        action: probe.action,
        ok: probe.ok === true,
        observed_ms: probe.observed_ms,
        max_ms: probe.max_ms,
        ...(typeof probe.feedback_kind === "string" ? { feedback_kind: probe.feedback_kind } : {}),
        reused_evidence: true,
        source_summary: evidencePath,
      });
    }
  }
  return true;
}

function pageUrlFromEvidence(stepsFromEvidence: Array<{ name?: unknown; details?: Record<string, unknown> }> | undefined): string | undefined {
  const generation = stepsFromEvidence?.find((step) => step.name === "segment_generation_once") as { url?: unknown } | undefined;
  return typeof generation?.url === "string" ? generation.url : undefined;
}

test.afterAll(async () => {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify({
    goal: "S-goal-06 Midscene smoke",
    base_url: safeBaseUrl(),
    ok: steps.every((step) => step.ok),
    steps,
    feedback_probes: feedbackProbes,
    reports: {
      playwright_json: path.join(artifactDir, "playwright-results.json"),
      midscene_html_directory: path.resolve(process.env.MIDSCENE_RUN_DIR ?? path.join(artifactDir, "midscene"), "report"),
    },
  }, null, 2)}\n`, "utf8");
});

test("S-goal-06: 登录后的九项 Midscene 冒烟与单次生图提交", async ({ page, agentForPage }) => {
  const baseUrl = safeBaseUrl();
  await mkdir(screenshotDir, { recursive: true });
  const username = requiredEnv("TEST_ENV_ADMIN_USERNAME");
  const password = requiredEnv("TEST_ENV_ADMIN_PASSWORD");
  requiredEnv("MIDSCENE_MODEL_API_KEY");
  requiredEnv("MIDSCENE_MODEL_NAME");

  const login: SmokeStep = { name: "login", url: `${baseUrl}/login`, ok: false };
  try {
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
    /* 账号框 autoComplete 按 allowRegister 合法切换(email/username,F08),不能拿它当选择器;
       用不随展示属性变化的 data-testid。fill/click 显式给 20s 上限(与下面 waitForURL 一致)——
       元素真找不到时 20s 就报错,而不是把整条用例的 900s 超时额度全耗在这一步，
       导致 catch 块里补救截图的那句来不及跑完(2026-08-05 首跑故障的间接诱因)。 */
    await page.getByTestId("login-username-input").fill(username, { timeout: 20_000 });
    await page.getByTestId("login-password-input").fill(password, { timeout: 20_000 });
    await page.getByTestId("login-submit-button").click({ timeout: 20_000 });
    await page.waitForURL((url) => url.pathname === "/projects", { timeout: 20_000 });
    login.ok = true;
    login.url = page.url();
  } catch (error) {
    const screenshot = path.join(screenshotDir, "login-failed.png");
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
    login.screenshot = screenshot;
    login.error = error instanceof Error ? error.message : String(error);
    steps.push(login);
    throw error;
  }
  steps.push(login);

  await recordPage(page, agentForPage, "projects", "这是已登录的项目管理页，能看到项目工作入口而不是登录表单。");
  const ids = await discoverProjectPath(page);

  /* 块 2:旧 /storyboards 换乘到生产页(集视图);「更多 ▾」为集视图恒在锚点。 */
  await page.goto(`${baseUrl}/projects/${ids.projectId}/storyboards`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => url.pathname === `/projects/${ids.projectId}/production`, { timeout: 10_000 });
  await recordPage(
    page,
    agentForPage,
    "production_view",
    "这是当前项目的生产页(集视图),能看到本集各场进度与场卡,页面已加载可读的项目生产内容。",
    page.getByRole("button", { name: /更多/ }),
  );

  /* 块 2:镜级 URL=换乘口,按归属场落段落(场)工作台。 */
  await page.goto(`${baseUrl}/projects/${ids.projectId}/storyboards/${ids.episodeId}/shots/${ids.shotId}`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => !url.pathname.includes("/shots/"), { timeout: 10_000 });
  await recordPage(
    page,
    agentForPage,
    "segment_workbench",
    "这是段落(场)工作台或生产页:能看到参考控制包待命区或各场进度,不是报错页。",
  );
  if (!await reusePriorGenerationEvidence(baseUrl)) {
    await submitOneSegmentGeneration(page, ids, baseUrl);
  }

  await page.goto(`${baseUrl}/assets?scope=personal`, { waitUntil: "domcontentloaded" });
  await recordPage(page, agentForPage, "personal_assets", "这是已登录用户的个人资产中心，页面能看到资产范围或资产管理内容。");

  await page.goto(`${baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
  await recordPage(
    page,
    agentForPage,
    "dashboard",
    "这是数据看板页面，包含已加载的数据看板内容或其明确空状态。",
    page.getByRole("button", { name: "刷新数据", exact: true }),
  );

  await page.goto(`${baseUrl}/settings`, { waitUntil: "domcontentloaded" });
  await recordPage(page, agentForPage, "settings", "这是设置页面，包含可读的设置或提示词管理内容。");

  await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
  await recordPage(
    page,
    agentForPage,
    "admin",
    "这是已加载的管理员控制台，能看到成本、团队、用户分组等管理页签和成本数据。",
    page.getByRole("button", { name: "导出 CSV", exact: true }),
  );

  await page.goto(`${baseUrl}/projects/${ids.projectId}/director`, { waitUntil: "domcontentloaded" });
  await recordPage(
    page,
    agentForPage,
    "project_director",
    "这是当前项目的 3D 导演台，包含已加载的导演台画布或其明确可读状态。",
    page.locator(".ds-viewport canvas"),
  );

  expect(steps.filter((step) => !step.ok), "失败步骤见 smoke-summary.json 的绝对截图路径").toEqual([]);
});
