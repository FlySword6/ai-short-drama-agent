import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, test as base, type Page, type Response } from "@playwright/test";
import { PlaywrightAiFixture, type PlayWrightAiFixtureType } from "@midscene/web/playwright";
import { assertProductionTargetAllowed, E2E_PRODUCTION_HOSTS } from "./production-target-guard.js";

const test = base.extend<PlayWrightAiFixtureType>(PlaywrightAiFixture());

const DEFAULT_BASE_URL = "https://shortdrama-main-test.col.com";
const DEFAULT_FIRST_SCREEN_MAX_MS = 3_000;
const DEFAULT_MEDIA_READ_MAX_MS = 1_500;
const DEFAULT_MEDIA_SWITCH_MAX_MS = 500;
const artifactDir = path.resolve(
  process.env.SGOAL07_ASSET_EXPERIENCE_ARTIFACT_DIR ?? "artifacts/sgoal07-asset-experience",
);
const screenshotDir = path.join(artifactDir, "screenshots");
const summaryPath = path.join(artifactDir, "experience-summary.json");
const productionHosts = E2E_PRODUCTION_HOSTS;

type ExperienceStep = {
  name: string;
  ok: boolean;
  url?: string;
  observed_ms?: number;
  max_ms?: number;
  screenshot?: string;
  error?: string;
  details?: Record<string, string | number | boolean | null>;
};

const steps: ExperienceStep[] = [];

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}（值不会输出到报告）`);
  return value;
}

function positiveMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须是正数毫秒`);
  return value;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/\u001B\[[0-9;]*m/g, "");
}

function safeBaseUrl(): string {
  const configured = process.env.SGOAL07_ASSET_EXPERIENCE_BASE_URL ?? DEFAULT_BASE_URL;
  const url = new URL(configured);
  if (!/^https?:$/.test(url.protocol)) throw new Error("SGOAL07_ASSET_EXPERIENCE_BASE_URL 必须是 http(s) 地址");
  assertProductionTargetAllowed(url, productionHosts);
  return url.origin;
}

async function failureScreenshot(page: Page, name: string): Promise<string> {
  const file = path.join(screenshotDir, `${name}-failed.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  return file;
}

function assetListResponse(response: Response): boolean {
  const url = new URL(response.url());
  return url.pathname === "/api/v1/assets" && url.searchParams.get("scope") === "common";
}

function mediaVersionsResponse(response: Response): boolean {
  const url = new URL(response.url());
  return /^\/api\/v1\/assets\/[^/]+\/versions$/.test(url.pathname);
}

function responseItemCount(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === "object"
    ? record.data as Record<string, unknown>
    : record;
  return Array.isArray(data.items) ? data.items.length : null;
}

async function login(page: Page, baseUrl: string): Promise<void> {
  const username = requiredEnv("TEST_ENV_ADMIN_USERNAME");
  const password = requiredEnv("TEST_ENV_ADMIN_PASSWORD");
  const step: ExperienceStep = { name: "login", ok: false, url: `${baseUrl}/login` };
  try {
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
    /* 账号框 autoComplete 按 allowRegister 合法切换(email/username,F08),不能拿它当选择器;
       用不随展示属性变化的 data-testid。fill/click 显式给 20s 上限(与下面 waitForURL 一致)——
       元素真找不到时 20s 就报错,而不是把整条用例的超时额度全耗在这一步，
       导致 catch 块里补救截图的那句来不及跑完(2026-08-05 首跑故障的间接诱因)。 */
    await page.getByTestId("login-username-input").fill(username, { timeout: 20_000 });
    await page.getByTestId("login-password-input").fill(password, { timeout: 20_000 });
    await page.getByTestId("login-submit-button").click({ timeout: 20_000 });
    await page.waitForURL((url) => url.pathname === "/projects", { timeout: 20_000 });
    step.ok = true;
    step.url = page.url();
  } catch (error) {
    step.error = errorMessage(error);
    step.screenshot = await failureScreenshot(page, step.name);
    throw error;
  } finally {
    steps.push(step);
  }
}

async function recordAiAssertion(
  page: Page,
  agentForPage: PlayWrightAiFixtureType["agentForPage"],
  name: string,
  assertion: string,
): Promise<void> {
  const step: ExperienceStep = { name, ok: false, url: page.url() };
  try {
    const agent = await agentForPage(page);
    await agent.aiAssert(assertion);
    step.ok = true;
  } catch (error) {
    step.error = errorMessage(error);
    step.screenshot = await failureScreenshot(page, name);
  }
  steps.push(step);
}

test.afterAll(async () => {
  await mkdir(artifactDir, { recursive: true });
  const thresholds = {
    common_asset_first_screen_max_ms: positiveMs(
      "SGOAL07_ASSET_FIRST_SCREEN_MAX_MS",
      DEFAULT_FIRST_SCREEN_MAX_MS,
    ),
    media_versions_read_max_ms: positiveMs(
      "SGOAL07_MEDIA_READ_MAX_MS",
      DEFAULT_MEDIA_READ_MAX_MS,
    ),
    media_switch_max_ms: positiveMs(
      "SGOAL07_MEDIA_SWITCH_MAX_MS",
      DEFAULT_MEDIA_SWITCH_MAX_MS,
    ),
  };
  await writeFile(summaryPath, `${JSON.stringify({
    goal: "S-goal-07 common asset experience assertions",
    base_url: safeBaseUrl(),
    ok: steps.every((step) => step.ok),
    thresholds,
    steps,
    reports: {
      playwright_json: path.join(artifactDir, "playwright-results.json"),
      midscene_html_directory: path.join(artifactDir, "midscene", "report"),
    },
  }, null, 2)}\n`, "utf8");
});

test("S-goal-07: 通用资产首屏、媒体读取与版本切换体验", async ({ page, agentForPage }) => {
  await mkdir(screenshotDir, { recursive: true });
  requiredEnv("MIDSCENE_MODEL_API_KEY");
  requiredEnv("MIDSCENE_MODEL_NAME");

  const baseUrl = safeBaseUrl();
  const firstScreenMaxMs = positiveMs("SGOAL07_ASSET_FIRST_SCREEN_MAX_MS", DEFAULT_FIRST_SCREEN_MAX_MS);
  const mediaReadMaxMs = positiveMs("SGOAL07_MEDIA_READ_MAX_MS", DEFAULT_MEDIA_READ_MAX_MS);
  const mediaSwitchMaxMs = positiveMs("SGOAL07_MEDIA_SWITCH_MAX_MS", DEFAULT_MEDIA_SWITCH_MAX_MS);

  await login(page, baseUrl);

  const listStep: ExperienceStep = {
    name: "common_asset_first_screen",
    ok: false,
    url: `${baseUrl}/assets?scope=common`,
    max_ms: firstScreenMaxMs,
  };
  let listUsable = false;
  let listStartedAt = performance.now();
  const listResponses: Response[] = [];
  const captureListResponse = (response: Response): void => {
    if (assetListResponse(response)) listResponses.push(response);
  };
  try {
    const assetCenterButton = page.getByRole("button", { name: "资产中心", exact: true });
    await expect(assetCenterButton).toBeVisible({ timeout: 10_000 });
    await assetCenterButton.click();
    await page.waitForURL((url) => url.pathname === "/assets" && url.searchParams.get("scope") === "personal");
    page.on("response", captureListResponse);
    listStartedAt = performance.now();
    await page.getByRole("tab", { name: "通用", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/assets" && url.searchParams.get("scope") === "common");
    const cards = page.locator('button[aria-label^="查看 "][aria-label$=" 详情"]');
    await expect(cards.first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[aria-label="正在读取资产"]')).toHaveCount(0);
    page.off("response", captureListResponse);
    if (listResponses.length === 0) throw new Error("没有观测到通用资产列表响应");
    await Promise.all(listResponses.map((response) => response.finished()));
    listStep.observed_ms = Math.round(performance.now() - listStartedAt);
    const pageSizes = [...new Set(listResponses.map((response) => (
      new URL(response.url()).searchParams.get("page_size") ?? "missing"
    )))];
    const payloads = await Promise.all(listResponses.map((response) => response.json().catch(() => null)));
    const returnedItemCount = payloads
      .map(responseItemCount)
      .filter((count): count is number => count !== null)
      .reduce((total, count) => total + count, 0);
    const cardCount = await cards.count();
    const requestShapeOk = listResponses.length === 1 && pageSizes.length === 1 && pageSizes[0] === "24";
    listUsable = listResponses.every((response) => response.ok()) && cardCount > 0;
    listStep.details = {
      response_statuses: listResponses.map((response) => response.status()).join(","),
      request_count: listResponses.length,
      requested_page_sizes: pageSizes.join(","),
      returned_item_count: returnedItemCount,
      visible_card_count: cardCount,
      request_shape_ok: requestShapeOk,
    };
    listStep.ok = listUsable
      && requestShapeOk
      && cardCount > 0
      && listStep.observed_ms <= firstScreenMaxMs;
    if (!listStep.ok) listStep.screenshot = await failureScreenshot(page, listStep.name);
  } catch (error) {
    page.off("response", captureListResponse);
    listStep.observed_ms = Math.round(performance.now() - listStartedAt);
    listStep.error = errorMessage(error);
    listStep.screenshot = await failureScreenshot(page, listStep.name);
  }
  steps.push(listStep);

  if (listUsable) {
    await recordAiAssertion(
      page,
      agentForPage,
      "common_asset_visual_assertion",
      "这是通用资产浏览页。首屏已经结束加载，能看到可识别的资产卡片和预览，不是白屏、骨架屏或错误页。",
    );
  } else {
    steps.push({
      name: "common_asset_visual_assertion",
      ok: false,
      url: page.url(),
      error: "前置的通用资产列表未达到可用状态，未调用 Midscene",
    });
  }

  const mediaReadStep: ExperienceStep = {
    name: "asset_media_versions_read",
    ok: false,
    url: page.url(),
    max_ms: mediaReadMaxMs,
  };
  const mediaReadStartedAt = performance.now();
  let mediaUsable = false;
  try {
    if (!listUsable) throw new Error("前置的通用资产列表未达到可用状态");
    const firstCard = page.locator('button[aria-label^="查看 "][aria-label$=" 详情"]').first();
    const versionsResponsePromise = page.waitForResponse(mediaVersionsResponse, { timeout: 30_000 });
    await firstCard.click();
    const response = await versionsResponsePromise;
    await response.finished();
    const dialog = page.getByRole("dialog");
    const versionList = page.locator('[role="list"][aria-label="媒体版本列表"]');
    const versionButtons = dialog.locator('button[aria-label^="预览"]');
    const versionFigures = dialog.locator("figure");
    await expect.poll(async () => Math.max(
      await versionButtons.count(),
      await versionFigures.count(),
    )).toBeGreaterThan(0);
    mediaReadStep.observed_ms = Math.round(performance.now() - mediaReadStartedAt);
    const interactiveVersionCount = await versionButtons.count();
    const figureCount = await versionFigures.count();
    const versionCount = Math.max(interactiveVersionCount, figureCount);
    mediaUsable = response.ok() && versionCount >= 2;
    mediaReadStep.details = {
      response_status: response.status(),
      media_version_count: versionCount,
      interactive_version_count: interactiveVersionCount,
      semantic_version_list_present: await versionList.count() > 0,
    };
    mediaReadStep.ok = response.ok()
      && versionCount >= 2
      && mediaReadStep.observed_ms <= mediaReadMaxMs;
    if (!mediaReadStep.ok) mediaReadStep.screenshot = await failureScreenshot(page, mediaReadStep.name);
  } catch (error) {
    mediaReadStep.observed_ms = Math.round(performance.now() - mediaReadStartedAt);
    mediaReadStep.error = errorMessage(error);
    mediaReadStep.screenshot = await failureScreenshot(page, mediaReadStep.name);
  }
  steps.push(mediaReadStep);

  if (mediaUsable) {
    await recordAiAssertion(
      page,
      agentForPage,
      "asset_detail_visual_assertion",
      "资产详情弹窗已打开，主预览区域和媒体版本缩略图清晰可见；不是一直停在读取状态或错误状态。",
    );
  } else {
    steps.push({
      name: "asset_detail_visual_assertion",
      ok: false,
      url: page.url(),
      error: "前置的媒体版本列表未达到可用状态，未调用 Midscene",
    });
  }

  const switchStep: ExperienceStep = {
    name: "asset_media_switch",
    ok: false,
    url: page.url(),
    max_ms: mediaSwitchMaxMs,
  };
  try {
    if (!mediaUsable) throw new Error("前置的媒体版本列表未达到可用状态");
    const versionList = page.locator('[role="list"][aria-label="媒体版本列表"]');
    const versionButtons = page.getByRole("dialog").locator('button[aria-label^="预览"]');
    expect(
      await versionButtons.count(),
      "当前部署没有两个可操作的媒体版本控件，无法完成切换",
    ).toBeGreaterThanOrEqual(2);
    const preview = versionList.locator("xpath=preceding-sibling::div[1]");
    const first = versionButtons.nth(0);
    const second = versionButtons.nth(1);

    await first.click();
    await expect(first).toHaveAttribute("aria-pressed", "true");
    const firstPreview = await preview.innerHTML();

    const switchStartedAt = performance.now();
    await second.click();
    await expect(second).toHaveAttribute("aria-pressed", "true");
    await expect(first).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => preview.innerHTML()).not.toBe(firstPreview);
    switchStep.observed_ms = Math.round(performance.now() - switchStartedAt);
    switchStep.details = {
      selection_moved: true,
      main_preview_changed: true,
    };
    switchStep.ok = switchStep.observed_ms <= mediaSwitchMaxMs;
    if (!switchStep.ok) switchStep.screenshot = await failureScreenshot(page, switchStep.name);
  } catch (error) {
    switchStep.error = errorMessage(error);
    switchStep.screenshot = await failureScreenshot(page, switchStep.name);
  }
  steps.push(switchStep);

  const failures = steps.filter((step) => !step.ok).map((step) => ({
    name: step.name,
    observed_ms: step.observed_ms,
    max_ms: step.max_ms,
    error: step.error,
    screenshot: step.screenshot,
  }));
  expect(failures, "失败详情和绝对截图路径见 experience-summary.json").toEqual([]);
});
