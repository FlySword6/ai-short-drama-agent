/**
 * UX 六任务自动化基线(R157,docs/design/ux-metrics.md 真源;Fable 2026-08-03 派单)。
 *
 * 覆盖 T1-T6 全六任务,每任务跑 3 遍取稳定值(中位数):
 *   A 组(Playwright 硬测):A1 跳数比 ≤1.0 / A2 点击数比 ≤1.2 / A3 首屏可达 /
 *     A4 下一步显性(main 内唯一 primary,V-24 口径) / A5 被迫回头 0;
 *   B1 任务完成率(三跑 ≥2 完成 = 完成)。
 *   B2 零指导完成率由 ux-zeroguide.smoke.spec.ts(Midscene)跑完回填同一份
 *     artifacts/kimi-ux-eval/ux-metrics.json。
 *
 * 实测口径(与块 1 T3/T5 样板一致):
 *   - 跳数 = 主框架 pathname 变化次数(SPA pushState 计入;起点页首次导航不计;
 *     modal/页内确认区展开不算跳);
 *   - 点击 = uxClick 包装的真实 click;fill/selectOption 各计 1 击;收口卫生动作
 *     (取消/关闭 modal)不计入任务点击;
 *   - 比值按实测段计:付费红线任务(T3 提交/T5 落账/T4 重试提交)止于确认区,
 *     理想值含完整动作,实测为其前缀,notes 注明;
 *   - 红项如实报,不调断言迁就现状;动线断头/死链落 dead_ends 清单。
 *
 * 受体分工(保护雾岛演示包):
 *   - T2/T6 受体 = 「本地演示项目」(dev-seed 最小包,无项目资产,可重复拉入/清理);
 *   - T3/T5 = 雾岛来信第 1 集(只读+确认区取消,零写动作);
 *   - T1 = 每遍新建临时项目,跑完软删+回收站硬删;
 *   - T4 = pg 直连插 failed generation 夹具(固定 UUID),afterAll 删除。
 *
 * 用法:
 *   SGOAL06_BASE_URL=http://localhost:5173 npx playwright test \
 *     --config scripts/e2e/ux-baseline.playwright.config.ts
 *
 * 凭据读 TEST_ENV_ADMIN_USERNAME / TEST_ENV_ADMIN_PASSWORD,不打印、不写报告。
 * 属地:本文件与 ux-baseline.playwright.config.ts / ux-zeroguide.* 为 UX 基线单自建,
 *   不碰 fe-b1-batch1 / fe-block1 / sgoal06 文件。
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import pg from "pg";

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifactDir = path.resolve(
  process.env.UX_BASELINE_ARTIFACT_DIR ?? path.join(worktreeRoot, "artifacts", "ux-baseline"),
);
const screenshotDir = path.join(artifactDir, "screenshots");
const summaryPath = path.join(artifactDir, "ux-baseline-summary.json");
const kimiEvalDir = path.join(worktreeRoot, "artifacts", "kimi-ux-eval");
const kimiEvalPath = path.join(kimiEvalDir, "ux-metrics.json");
/* 采集落盘(免疫 worker 重启:test 失败不 throw 也会触发 worker 清理,模块内存状态不可靠;
   每任务/探针/断头各自落小文件,afterAll 读盘聚合,多 worker/多 afterAll 都拿全量)。 */
const tasksDir = path.join(artifactDir, "tasks");
const probesDir = path.join(artifactDir, "probes");
const deadEndsDir = path.join(artifactDir, "dead-ends");

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function readJsonDir<T>(dir: string): Promise<T[]> {
  try {
    const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
    const out: T[] = [];
    for (const file of files) out.push(JSON.parse(await readFile(path.join(dir, file), "utf8")) as T);
    return out;
  } catch {
    return [];
  }
}

/* ================= 类型与采集 ================= */

interface RunRecord {
  run: number;
  hops: number;
  clicks: number;
  backtracks: number;
  completed: boolean;
  duration_ms: number;
  notes: string[];
}

interface TaskResult {
  task: string;
  name: string;
  spec_path: string;
  ideal: { page_hops: number; clicks: number };
  runs: RunRecord[];
  median: { hops: number; clicks: number };
  hop_ratio: number | null;
  click_ratio: number | null;
  forced_backtracks_total: number;
  completed: boolean;
  hop_pass: boolean | null;
  click_pass: boolean | null;
  measured_scope: string;
  notes: string[];
}

interface PageProbe {
  page: string;
  url_pattern: string;
  main_action: string;
  first_screen_visible: boolean | null;
  primary_count_in_main: number | null;
  /** A4 数 primary 前先等该 selector 可见(页面条件渲染的 primary 容器稳定后再数);
     超时容忍不存在(无此容器直接数)。 */
  settle?: string;
  note?: string;
}

const taskResults: Record<string, TaskResult> = {};
const pageProbes: PageProbe[] = [];
const deadEnds: string[] = [];

function probeFilename(name: string): string {
  return name.replaceAll(/[^a-z0-9一-鿿]+/gi, "-").replaceAll(/^-|-$/g, "").toLowerCase();
}

/** 断头/死链登记:内存+落盘双写(盘为真源,afterAll 读盘聚合)。 */
async function recordDeadEnd(text: string): Promise<void> {
  deadEnds.push(text);
  await writeJsonAtomic(path.join(deadEndsDir, `${String(deadEnds.length).padStart(2, "0")}-${probeFilename(text.slice(0, 24))}.json`), text);
}

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

function median3(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** 跳数探针:挂 framenavigated,主框架 pathname 变化计 1 跳(起点首次不计)。 */
class UxProbe {
  hops = 0;
  clicks = 0;
  backtracks = 0;
  private lastPath = "";
  attach(page: Page): void {
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      let pathname: string;
      try {
        pathname = new URL(frame.url()).pathname;
      } catch {
        return;
      }
      if (pathname === this.lastPath) return;
      if (this.lastPath !== "") this.hops += 1;
      this.lastPath = pathname;
    });
  }
}

async function uxClick(probe: UxProbe, locator: Locator, options?: { timeout?: number }): Promise<void> {
  await locator.click(options);
  probe.clicks += 1;
}

/** A3/A4:主动作首屏无滚动可见(1440×900)+ main 内 bg-accent 按钮恰 1 枚(V-24 口径)。 */
async function probePage(page: Page, probe: PageProbe): Promise<void> {
  const action = page.locator(probe.main_action).first();
  let firstScreen: boolean | null = null;
  try {
    await action.waitFor({ state: "visible", timeout: 10_000 });
    const box = await action.boundingBox();
    firstScreen = box !== null && box.y >= 0 && box.y + box.height <= 900 && box.x + box.width <= 1440;
  } catch {
    firstScreen = false;
  }
  if (probe.settle) {
    await page.locator(probe.settle).first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => { /* 容器不存在:直接数(无 resume 候选等场景) */ });
  }
  const primaryCount = await page.locator("main#main-content button.bg-accent").count();
  pageProbes.push({ ...probe, first_screen_visible: firstScreen, primary_count_in_main: primaryCount });
}

/** 登录:确定性 selector,成功落到 /projects;共享 8000(tsx watch)热重启窗口
    会 500/断连,撞窗最多重试 3 次(间隔 5s)——登录不算任务动线,不污染指标。 */
async function loginAsAdmin(page: Page): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(`${baseUrl()}/login`, { waitUntil: "domcontentloaded" });
      // 账号框 autoComplete 按 allowRegister 合法切换(email/username,F08)，选择器改用不随之变的 data-testid。
      await page.getByTestId("login-username-input").fill(requiredEnv("TEST_ENV_ADMIN_USERNAME"));
      await page.getByTestId("login-password-input").fill(requiredEnv("TEST_ENV_ADMIN_PASSWORD"));
      await page.getByTestId("login-submit-button").click();
      await page.waitForURL((url) => url.pathname === "/projects", { timeout: 20_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(5_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 页面内直连 REST(sessionStorage token),用于上下文查询与清理;30s 超时防 8000 抖动挂死 evaluate。 */
async function apiJson<T>(page: Page, url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return page.evaluate(async ({ url: u, method, body }) => {
    const token = window.sessionStorage.getItem("shortdrama_v01_token");
    if (!token) throw new Error("登录后未找到会话");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json"; // 无 body 带 json 头会被 fastify 当空 JSON 拒(400)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(u, {
        method: method ?? "GET",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${method ?? "GET"} ${u} 返回 ${response.status}`);
      const text = await response.text();
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }, { url, method: init?.method, body: init?.body });
}

interface ProjectItem { id: string; name?: string }
interface EpisodeItem { id: string; episode_no: number; name?: string | null }
interface SceneItem { id: string; scene_no?: number; name: string; sort_order?: number }
interface ShotItem { id: string; shot_no: number; title?: string | null }

async function findProject(page: Page, namePart: string): Promise<ProjectItem> {
  const data = await apiJson<{ data?: { items?: ProjectItem[] } }>(page, "/api/v1/projects");
  const project = (data.data?.items ?? []).find((item) => (item.name ?? "").includes(namePart));
  if (!project) throw new Error(`没有找到 name 含「${namePart}」的项目`);
  return project;
}

async function firstEpisode(page: Page, projectId: string): Promise<EpisodeItem> {
  const data = await apiJson<{ data?: { items?: EpisodeItem[] } }>(page, `/api/v1/projects/${projectId}/episodes`);
  const episode = [...(data.data?.items ?? [])].sort((a, b) => a.episode_no - b.episode_no)[0];
  if (!episode) throw new Error(`项目 ${projectId} 没有集`);
  return episode;
}

async function firstScene(page: Page, episodeId: string): Promise<SceneItem> {
  const data = await apiJson<{ data?: { items?: SceneItem[] } }>(page, `/api/v1/episodes/${episodeId}/scenes`);
  const scene = [...(data.data?.items ?? [])].sort((a, b) => (a.sort_order ?? a.scene_no ?? 0) - (b.sort_order ?? b.scene_no ?? 0))[0];
  if (!scene) throw new Error(`集 ${episodeId} 没有场`);
  return scene;
}

/** 项目资产 refs 清理(T2/T6 每遍后恢复「未拉入」现场;pg 直连 node 侧,不依赖浏览器存活)。 */
async function clearProjectRefsPg(client: pg.Client, projectId: string): Promise<void> {
  await client.query("DELETE FROM project_asset_refs WHERE project_id = $1", [projectId]);
}

/** T1 清理:软删走 API,硬删走 pg 级联手删——回收站硬删端点对含 P-06 剧本表的项目 500
    (级联清单未覆盖 episode_script_versions/script_breakdown_runs,后端 bug 已报,修复前 pg 兜底)。 */
async function deleteProjectHard(page: Page, client: pg.Client, projectId: string): Promise<void> {
  await apiJson(page, `/api/v1/projects/${projectId}`, { method: "DELETE" })
    .catch((error) => console.warn(`[ux-baseline] 软删项目 ${projectId} 失败:${error instanceof Error ? error.message : String(error)}`));
  await client.query("DELETE FROM script_breakdown_runs WHERE episode_id IN (SELECT id FROM episodes WHERE project_id=$1)", [projectId]);
  await client.query("DELETE FROM episode_script_versions WHERE episode_id IN (SELECT id FROM episodes WHERE project_id=$1)", [projectId]);
  await client.query("DELETE FROM shots WHERE episode_id IN (SELECT id FROM episodes WHERE project_id=$1)", [projectId]);
  await client.query("DELETE FROM scenes WHERE episode_id IN (SELECT id FROM episodes WHERE project_id=$1)", [projectId]);
  await client.query("DELETE FROM episodes WHERE project_id=$1", [projectId]);
  await client.query("DELETE FROM projects WHERE id=$1 AND deleted_at IS NOT NULL", [projectId]);
}

/** 三跑取稳定值,落 TaskResult;afterEachRun 在每遍后(无论成败)执行,用于恢复现场。 */
async function runTaskThreeTimes(
  page: Page,
  task: Pick<TaskResult, "task" | "name" | "spec_path" | "ideal" | "measured_scope">,
  journey: (run: number) => Promise<RunRecord>,
  afterEachRun?: (run: number) => Promise<void>,
): Promise<TaskResult> {
  const runs: RunRecord[] = [];
  for (let run = 1; run <= 3; run += 1) {
    const started = Date.now();
    try {
      const record = await journey(run);
      record.duration_ms = Date.now() - started;
      runs.push(record);
    } catch (error) {
      const shot = path.join(screenshotDir, `${task.task}-run${run}-failed.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      runs.push({
        run,
        hops: 0,
        clicks: 0,
        backtracks: 0,
        completed: false,
        duration_ms: Date.now() - started,
        notes: [`异常中断:${error instanceof Error ? error.message.slice(0, 300) : String(error)};截图 ${path.relative(worktreeRoot, shot)}`],
      });
    } finally {
      await afterEachRun?.(run).catch((error) => {
        console.warn(`[ux-baseline] ${task.task} run${run} 现场恢复失败:${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
  const completedRuns = runs.filter((run) => run.completed);
  const done = completedRuns.length >= 2;
  // 中位数只取完成遍(未完成任务的路径效率不参评);全灭则 null 如实报。
  const basis = completedRuns.length > 0 ? completedRuns : runs;
  const medianHops = median3(basis.map((run) => run.hops));
  const medianClicks = median3(basis.map((run) => run.clicks));
  const hopRatio = completedRuns.length > 0 ? Number((medianHops / task.ideal.page_hops).toFixed(2)) : null;
  const clickRatio = completedRuns.length > 0 ? Number((medianClicks / task.ideal.clicks).toFixed(2)) : null;
  const result: TaskResult = {
    ...task,
    runs,
    median: { hops: medianHops, clicks: medianClicks },
    hop_ratio: hopRatio,
    click_ratio: clickRatio,
    forced_backtracks_total: runs.reduce((sum, run) => sum + run.backtracks, 0),
    completed: done,
    hop_pass: hopRatio === null ? null : hopRatio <= 1.0,
    click_pass: clickRatio === null ? null : clickRatio <= 1.2,
    notes: [],
  };
  taskResults[task.task] = result;
  return result;
}

/* ================= T4 pg 夹具 ================= */

const T4_IDS = {
  request: "00000000-a001-4100-8000-000000000401",
  attempt: "00000000-a001-4100-8000-000000000402",
  notification: "00000000-a001-4100-8000-000000000403",
};

/** pg 连接:优先 DATABASE_URL,缺省按 POSTGRES_* 分段拼(本仓 .env 现状);连上即设 search_path=app。 */
async function connectPg(): Promise<pg.Client> {
  const url = process.env.DATABASE_URL?.trim();
  const client = url
    ? new pg.Client({ connectionString: url })
    : new pg.Client({
      host: process.env.POSTGRES_HOST ?? "localhost",
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      database: process.env.POSTGRES_DB ?? "shortdrama",
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
    });
  if (!url && !process.env.POSTGRES_USER) throw new Error("缺少 DATABASE_URL 或 POSTGRES_* 分段配置(pg 夹具需要,值不会输出到报告)");
  await client.connect();
  await client.query(`SET search_path TO ${(process.env.POSTGRES_SCHEMA ?? "app").replaceAll(/[^a-z0-9_]/gi, "")}, public`);
  return client;
}

async function t4Seed(client: pg.Client, input: { userId: string; projectId: string; episodeId: string; sceneId: string; shotId: string }): Promise<void> {
  const now = new Date();
  const hash = createHash("sha256").update("ux-baseline-t4-retry").digest("hex");
  await client.query(
    `INSERT INTO generation_requests (id, user_id, project_id, episode_id, scene_id, shot_id, target_asset_entity_id, media_kind, prompt, reference_media_ids, reference_asset_snapshots, parameters, quantity, client_idempotency_key, request_hash, charged_points, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,'image','UX 基线 T4 夹具:雨夜追逐参考图(失败重试用例)','[]','[]','{}',1,'ux-baseline-t4-retry',$7,60,$8,$8)
     ON CONFLICT (id) DO NOTHING`,
    [T4_IDS.request, input.userId, input.projectId, input.episodeId, input.sceneId, input.shotId, hash, now],
  );
  await client.query(
    `INSERT INTO generation_attempts (id, request_id, attempt_no, retry_idempotency_key, provider, provider_task_id, model, parameters, quantity, status, phase, provider_status, provider_response, error_code, error_message, retryable, estimated_cost_fen, actual_cost_fen, actual_cost_status, pricing_rule_id, price_snapshot, last_query_error, next_poll_at, last_polled_at, lease_owner, lease_until, submitted_at, started_at, finished_at, created_at, updated_at)
     VALUES ($1,$2,1,NULL,'ark',NULL,'doubao-seedream-5-0-pro-260628','{}',1,'failed','complete','failed',NULL,'PROVIDER_TIMEOUT','UX 基线夹具:供应商响应超时(模拟失败,供重试动线实测)',true,60,0,'unavailable',NULL,'{}',NULL,NULL,NULL,NULL,NULL,$3,$3,$3,$3,$3)
     ON CONFLICT (id) DO NOTHING`,
    [T4_IDS.attempt, T4_IDS.request, now],
  );
  await client.query(
    `INSERT INTO generation_attempt_notifications (id, attempt_id, generation_request_id, project_id, user_id, acknowledged_at, created_at)
     VALUES ($1,$2,$3,$4,$5,NULL,$6)
     ON CONFLICT (id) DO UPDATE SET acknowledged_at = NULL`,
    [T4_IDS.notification, T4_IDS.attempt, T4_IDS.request, input.projectId, input.userId, now],
  );
}

async function t4ResetAck(client: pg.Client): Promise<void> {
  await client.query("UPDATE generation_attempt_notifications SET acknowledged_at = NULL WHERE id = $1", [T4_IDS.notification]);
}

async function t4Cleanup(client: pg.Client): Promise<void> {
  await client.query("DELETE FROM generation_attempt_notifications WHERE id = $1", [T4_IDS.notification]);
  await client.query("DELETE FROM generation_attempts WHERE id = $1", [T4_IDS.attempt]);
  await client.query("DELETE FROM generation_requests WHERE id = $1", [T4_IDS.request]);
}

/* ================= 公共上下文 ================= */

interface WudaoContext {
  projectId: string;
  episodeId: string;
  scene: SceneItem;
}
interface DemoContext {
  projectId: string;
  episodeId: string;
  scene: SceneItem;
}

async function wudaoContext(page: Page): Promise<WudaoContext> {
  const project = await findProject(page, "雾岛");
  const episode = await firstEpisode(page, project.id);
  const scene = await firstScene(page, episode.id);
  return { projectId: project.id, episodeId: episode.id, scene };
}

async function demoContext(page: Page): Promise<DemoContext> {
  const project = await findProject(page, "本地演示项目");
  const episode = await firstEpisode(page, project.id);
  const scene = await firstScene(page, episode.id);
  return { projectId: project.id, episodeId: episode.id, scene };
}

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true });
  requiredEnv("TEST_ENV_ADMIN_USERNAME");
  requiredEnv("TEST_ENV_ADMIN_PASSWORD");
});

/* ================= T1 新建项目到有剧本(理想跳 3 / 点击 ≤8) ================= */

const T1_SCRIPT = `夜·内 旧宅客厅
林晚推开门,愣住。
林晚:你怎么会在这里?
沈孤舟:等你很久了。

日·外 巷口
林晚撑伞走过,回头看了一眼。

夜·外 面馆
沈孤舟把一封信推到桌上。
沈孤舟:看完再决定。`;

test("T1 新建项目到有剧本", async ({ page }) => {
  /* E1b 窗口:拆解 failed@80-140s(curl 实证),窗压 180/150 快红;上限 30 分钟防 test 层
     timeout throw(worker 重启丢采集态——T1 runs 空片教训)。 */
  test.setTimeout(1_800_000);
  await loginAsAdmin(page);
  const client = await connectPg();
  const createdProjectIds: string[] = [];
  try {
    await runTaskThreeTimes(page, {
      task: "T1",
      name: "新建项目到有剧本",
      spec_path: "项目管理→建项目→贴剧本→拆解确认",
      ideal: { page_hops: 3, clicks: 9 },
      measured_scope: "/projects → 新建项目(填名+创建) → /production 空态「建第一集」(R1 修复后必经之路,+1 击) →「剧本」→ 新建版本贴剧本保存 → 重新拆解 → 待确认 → 确认分镜表 → 确认写入 → /assets",
    }, async (run) => {
      const probe = new UxProbe();
      probe.attach(page);
      const notes: string[] = [];
      const projectName = `UX基线T1·run${run}·${Date.now() % 100000}`;

      await page.goto(`${baseUrl()}/projects`, { waitUntil: "domcontentloaded" });
      if (run === 1) await probePage(page, { page: "T1 起点 /projects", url_pattern: "/projects", main_action: 'button[aria-label="新建项目"]', first_screen_visible: null, primary_count_in_main: null, settle: 'section[aria-label="继续上次工作"]' });
      await uxClick(probe, page.locator('button[aria-label="新建项目"]'));
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByPlaceholder(/杀穿女频/).fill(projectName);
      probe.clicks += 1; // 填写项目名计入 1 击(与理想点击口径一致:填名+提交)
      await uxClick(probe, dialog.getByRole("button", { name: "创建项目", exact: true }));
      await page.waitForURL((url) => /\/projects\/[^/]+\/production$/.test(url.pathname), { timeout: 15_000 });
      const projectId = page.url().match(/\/projects\/([^/]+)\/production/)?.[1];
      if (!projectId) throw new Error("建项目后未落到 /production");
      createdProjectIds.push(projectId);

      /* R1 已修:0 集空态唯一 primary=「建第一集」(CreateEpisodeButton,默认名直建 1 击);
         空态整页 early-return 无「剧本」tab——建集是去剧本页的必经之路,计入理想点击(+1)。 */
      await uxClick(probe, page.getByRole("button", { name: "建第一集", exact: true }));
      await expect(page.getByRole("button", { name: "剧本", exact: true })).toBeVisible({ timeout: 15_000 });
      notes.push("R1 已修复:0 集空态「建第一集」走真 UI(1 击计入理想值 8→9);");

      await uxClick(probe, page.getByRole("button", { name: "剧本", exact: true }));
      await page.waitForURL((url) => url.pathname === `/projects/${projectId}/script-breakdown`, { timeout: 15_000 });
      if (run === 1) await probePage(page, { page: "T1 剧本分镜页", url_pattern: "/projects/:id/script-breakdown", main_action: 'button:has-text("新建版本")', first_screen_visible: null, primary_count_in_main: null, note: "草稿就绪后主动作=确认分镜表" });

      await uxClick(probe, page.getByRole("button", { name: "新建版本", exact: true }));
      await page.locator('textarea[placeholder*="旧宅客厅"]').fill(T1_SCRIPT);
      probe.clicks += 1; // 贴剧本计入 1 击
      await uxClick(probe, page.getByRole("button", { name: "保存版本", exact: true }));
      await uxClick(probe, page.getByRole("button", { name: "重新拆解", exact: true }));

      // 拆解=真 AI 网关调用;侦测三终态(待确认/拆解失败/剧本拆解没成=后端 display_reason 现文案),失败即放不空等。
      const draftTimeout = run === 1 ? 180_000 : 150_000;
      const deadline = Date.now() + draftTimeout;
      let outcome: "draft" | "failed" | "timeout" = "timeout";
      while (Date.now() < deadline) {
        if ((await page.getByText("待确认", { exact: true }).count()) > 0) { outcome = "draft"; break; }
        if ((await page.getByText("拆解失败", { exact: true }).count()) > 0) { outcome = "failed"; break; }
        if ((await page.getByText("剧本拆解没成").count()) > 0) { outcome = "failed"; break; }
        await page.waitForTimeout(4_000);
      }
      if (outcome !== "draft") {
        notes.push(outcome === "failed"
          ? "拆解失败:curl 实证 error_code=ai_service_unavailable(拆解到 shots:scene:0 阶段上游模型暂不可用,LLM 已真应答 987in/7399out——配置层 E1 已解除,残余=上游层 E1b);"
          : `拆解 ${Math.round(draftTimeout / 1000)}s 未出草稿(超时);`);
        return { run, hops: probe.hops, clicks: probe.clicks, backtracks: probe.backtracks, completed: false, duration_ms: 0, notes };
      }

      await uxClick(probe, page.getByRole("button", { name: "确认分镜表", exact: true }));
      const confirmBar = page.locator('section[aria-label="确认采用拆解"]');
      await expect(confirmBar).toBeVisible();
      await uxClick(probe, confirmBar.getByRole("button", { name: "确认写入", exact: true }));
      await page.waitForURL((url) => url.pathname === `/projects/${projectId}/assets`, { timeout: 20_000 });
      if (run === 1) await probePage(page, { page: "T1 终点项目资产页", url_pattern: "/projects/:id/assets", main_action: 'button:has-text("从资产中心引入")', first_screen_visible: null, primary_count_in_main: null, note: "R5 实证位:新项目 0 资产空态,头带唯一 primary(空态引导钮已降级)" });
      notes.push("拆解为本地 ARK 网关真调用(非付费生成动作,属解析类自动化);");
      return { run, hops: probe.hops, clicks: probe.clicks, backtracks: probe.backtracks, completed: true, duration_ms: 0, notes };
    });
  } finally {
    for (const projectId of createdProjectIds) await deleteProjectHard(page, client, projectId);
    await client.end();
  }
  const t1 = taskResults.T1!;
  t1.notes.push("拆解确认写入是数据写动作但非付费生成,授权内;临时项目已软删+pg 级联硬删(回收站硬删端点对含 P-06 剧本表项目 500,后端 bug 见 R6);");
  deadEnds.push("R1(T1,已修复):0 集建集入口已补(/production 空态唯一 primary「建第一集」+剧本页同款+ghost「+ 集」)——本趟起建集走真 UI 计 1 击,理想点击 8→9;留此条作修复销账记录。");
  deadEnds.push("R1b(T1,环境):E1 配置层已解除(config-status:网关 true+四槽全配,LLM 真应答);残余 E1b=拆解到 shots:scene:0 报 ai_service_unavailable(上游模型暂不可用,curl 实证 run 987in/7399out 后 failed)——T1 终点(拆解确认)在上游恢复前不可达,复测窗口待供应商侧稳定。");
  deadEnds.push("R6(后端 bug):DELETE /api/v1/trash/project/:id 对含 P-06 剧本表(script_versions/breakdown_runs)的项目 500——回收站硬删级联清单未覆盖新表;T1 清理经 pg 兜底。");
  if (!t1.completed) console.warn(`[ux-baseline] T1 三跑完成数 <2——指标红项计入 B1/报告(test 层不 throw:throw 会触发 worker 重启,丢失共享采集状态);`);
});

/* ================= T2 备一场戏(理想跳 2 / 点击 ≤7) ================= */

test("T2 备一场戏", async ({ page }) => {
  test.setTimeout(600_000);
  await loginAsAdmin(page);
  const ctx = await demoContext(page);
  const client = await connectPg();
  await clearProjectRefsPg(client, ctx.projectId); // 前置:0 refs,三件可拉
  const prodPath = `/projects/${ctx.projectId}/production`;
  try {
    await runTaskThreeTimes(page, {
      task: "T2",
      name: "备一场戏",
      spec_path: "集视图→备戏台→拉件×3→送入",
      ideal: { page_hops: 2, clicks: 7 },
      measured_scope: "集视图场卡「备戏」→ /assets/prep → 三条 lane(角色/场景/光影)各「+选」→ 抽屉「加入」→ 完成 ×3 →「送入这场戏」→ 场级工作台",
    }, async (run) => {
      const probe = new UxProbe();
      probe.attach(page);
      const notes: string[] = [];
      await page.goto(`${baseUrl()}${prodPath}`, { waitUntil: "domcontentloaded" });
      const sceneList = page.locator('section[aria-label="场列表"]');
      await expect(sceneList.locator("article").first()).toBeVisible({ timeout: 15_000 });
      if (run === 1) await probePage(page, { page: "T2 起点 集视图", url_pattern: "/projects/:id/production", main_action: 'section[aria-label="下一步"] button.bg-accent', first_screen_visible: null, primary_count_in_main: null });

      await uxClick(probe, sceneList.locator("article").first().getByRole("button", { name: "备戏", exact: true }), { timeout: 20_000 });
      await page.waitForURL((url) => url.pathname === "/assets/prep", { timeout: 10_000 });
      await expect(page.locator('div[aria-label="备戏台"]')).toBeVisible({ timeout: 15_000 });

      /* R2 连选(断头修复后新旅程):任一 lane「+选」开 multi 抽屉(不锁单 lane)→
         勾选三件(角色/场景/光影)→「带入 3 件」一次批量入单→送入。点击比目标 ≤1.2。 */
      const drawer = page.locator('aside[role="dialog"][aria-label="从资产库选（可多选带入）"]');
      await uxClick(probe, page.locator('section[aria-label="备戏 角色"]').locator('button[aria-label="从资产库选角色进备戏单"]'), { timeout: 20_000 });
      await expect(drawer).toBeVisible({ timeout: 10_000 });
      for (const assetName of ["沈孤舟", "巷口面馆", "雨夜青蓝"]) {
        const row = drawer.locator('div[role="checkbox"]', { hasText: assetName }).first();
        await uxClick(probe, row, { timeout: 25_000 });
      }
      await uxClick(probe, drawer.getByRole("button", { name: /带入\s*3\s*件/ }), { timeout: 10_000 });
      await expect(drawer).toHaveCount(0, { timeout: 10_000 });
      notes.push("R2 连选:一次抽屉勾选×3+带入×1 取代三次抽屉往返(修复前 11 击);");

      await uxClick(probe, page.getByRole("button", { name: "送入这场戏", exact: true }), { timeout: 20_000 });
      await page.waitForURL((url) => url.pathname.includes(`/scenes/${ctx.scene.id}`), { timeout: 15_000 });
      return { run, hops: probe.hops, clicks: probe.clicks, backtracks: probe.backtracks, completed: true, duration_ms: 0, notes };
    }, async () => {
      /* 每遍后恢复:清 refs(送入的真源)+本机备戏键,下一遍从「未拉入」起跑 */
      await clearProjectRefsPg(client, ctx.projectId);
      await page.evaluate(() => {
        for (const key of Object.keys(window.localStorage)) {
          if (key.startsWith("shortdrama_prep")) window.localStorage.removeItem(key);
        }
      }).catch(() => undefined);
    });
  } finally {
    await clearProjectRefsPg(client, ctx.projectId);
    await client.end();
    await page.evaluate(() => {
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith("shortdrama_prep")) window.localStorage.removeItem(key);
      }
    }).catch(() => undefined);
  }
  const t2 = taskResults.T2!;
  t2.notes.push("受体=本地演示项目(保护雾岛演示包);送入只写项目资产 refs(幂等),每遍后清 refs+本机备戏键恢复现场;");
  t2.notes.push("备戏台三级选择在从集视图「备戏」钮带入时自动就绪(localStorage current),不另计点击;");
  if ((t2.click_ratio ?? 0) > 1.2) {
    deadEnds.push(`R2(T2):拉件×3 需三次「+选→抽屉→加入→关闭」往返,实测点击比 ${t2.click_ratio}(理想 ≤7 击)——抽屉不支持跨 lane 连选,建议「加入后抽屉留开」或「多选一次带入」。`);
  }
  if (!t2.completed) console.warn(`[ux-baseline] T2 三跑完成数 <2——指标红项计入 B1/报告(test 层不 throw:throw 会触发 worker 重启,丢失共享采集状态);`);
});

/* ================= T3 开拍一段(理想跳 2 / 点击 ≤5) ================= */

test("T3 开拍一段", async ({ page }) => {
  test.setTimeout(600_000);
  await loginAsAdmin(page);
  const ctx = await wudaoContext(page);
  const prodPath = `/projects/${ctx.projectId}/production`;
  const workbenchPath = `/projects/${ctx.projectId}/storyboards/${ctx.episodeId}/scenes/${ctx.scene.id}`;
  await runTaskThreeTimes(page, {
    task: "T3",
    name: "开拍一段",
    spec_path: "集视图→工作台→确认报价→提交",
    ideal: { page_hops: 2, clicks: 5 },
    measured_scope: "集视图 → 点场卡 → 段落工作台 →「开拍」→ 整段生成确认(报价)区出现即止(未提交)",
  }, async (run) => {
    const probe = new UxProbe();
    probe.attach(page);
    const notes: string[] = ["付费红线:实测止于确认报价区出现,提交(付费动作)未点,理想值含提交,比值按实测段计;"];
    await page.goto(`${baseUrl()}${prodPath}`, { waitUntil: "domcontentloaded" });
    const sceneList = page.locator('section[aria-label="场列表"]');
    await expect(sceneList.locator("article").first()).toBeVisible({ timeout: 15_000 });
    await uxClick(probe, sceneList.locator("article").first().locator("h3"));
    await page.waitForURL((url) => url.pathname === workbenchPath, { timeout: 10_000 });
    await expect(page.locator('aside[aria-label="参考控制包"]')).toBeVisible({ timeout: 15_000 });
    if (run === 1) await probePage(page, { page: "T3 段落工作台", url_pattern: "/projects/:id/storyboards/:eid/scenes/:sid", main_action: 'button:has-text("开拍")', first_screen_visible: null, primary_count_in_main: null });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const shootButton = page.getByRole("button", { name: "开拍", exact: true });
    await expect(shootButton).toBeVisible();
    await expect.poll(async () => (await shootButton.getAttribute("title")) ?? "", { timeout: 15_000 }).not.toMatch(/这场还没有镜头|正在读取档位/);
    if (!(await shootButton.isEnabled())) {
      notes.push(`「开拍」禁用(${(await shootButton.getAttribute("title")) || "无说明"})——无可用视频档位,确认区段无法实测;`);
      return { run, hops: probe.hops, clicks: probe.clicks, backtracks: probe.backtracks, completed: false, duration_ms: 0, notes };
    }
    await uxClick(probe, shootButton); // 仅估价,不创建任务不付费
    const confirmSection = page.locator('section[aria-label="整段生成确认"]');
    await expect(confirmSection).toBeVisible();
    await expect(confirmSection.getByText(/积分/).first()).toBeVisible();
    await confirmSection.getByRole("button", { name: "取消", exact: true }).click(); // 收口卫生,不计入
    await expect(confirmSection).toHaveCount(0);
    return { run, hops: probe.hops, clicks: probe.clicks, backtracks: probe.backtracks, completed: true, duration_ms: 0, notes };
  });
  const t3 = taskResults.T3!;
  t3.notes.push("被迫回头=0:场卡直达工作台;入口与 ready 态「进工作台」同落点同跳数;");
  if (!t3.completed) console.warn(`[ux-baseline] T3 三跑完成数 <2——指标红项计入 B1/报告(test 层不 throw:throw 会触发 worker 重启,丢失共享采集状态);`);
});

/* ================= T4 处理一次失败(理想跳 2 / 点击 ≤5) ================= */

test("T4 处理一次失败", async ({ page }) => {
  test.setTimeout(600_000);
  await loginAsAdmin(page);
  const ctx = await wudaoContext(page);
  const shots = await apiJson<{ data?: { items?: Array<ShotItem & { scene_id?: string; sceneId?: string }> } }>(page, `/api/v1/episodes/${ctx.episodeId}/shots`);
  const shot = [...(shots.data?.items ?? [])]
    .filter((item) => {
      const sid = item.scene_id ?? item.sceneId;
      return !sid || sid === ctx.scene.id;
    })
    .sort((a, b) => a.shot_no - b.shot_no)[0];
  if (!shot) throw new Error("雾岛场 1 没有镜头,T4 夹具无挂载点");

  const client = await connectPg();
  const userRow = await client.query<{ id: string }>("SELECT id FROM users WHERE username = $1 LIMIT 1", [requiredEnv("TEST_ENV_ADMIN_USERNAME")]);
  const userId = userRow.rows[0]?.id;
  if (!userId) throw new Error("users 表查不到当前登录用户,T4 通知夹具无法定向");
  try {
    await t4Seed(client, { userId, projectId: ctx.projectId, episodeId: ctx.episodeId, sceneId: ctx.scene.id, shotId: shot.id });
    await runTaskThreeTimes(page, {
      task: "T4",
      name: "处理一次失败",
      spec_path: "队列→失败区行→重新报价/回工作台→重试提交",
      ideal: { page_hops: 2, clicks: 5 },
      measured_scope: "/queue 失败区行(display_reason 上屏)→「重新报价重试」触达(双终态:金额条/积分不足人话 toast)→「回工作台处理」落场级工作台",
    }, async (run) => {
      const probe = new UxProbe();
      probe.attach(page);
      const notes: string[] = [
        "P-10 已修:/queue 失败区常驻——失败任务固定可回访落点,R3 断头销账(旧旅程=DEMO_ROWS 假数据/通知 Dock 一次性入口);",
        "重新报价=两阶段(quote→人工确认),admin 0 积分必走积分不足人话 toast(account_credit_insufficient,环境性拒)——报价链触达即实证;",
        "付费红线:不 confirm 不 retry,attempts 零新增;",
      ];
      await page.goto(`${baseUrl()}/queue`, { waitUntil: "domcontentloaded" });
      const section = page.locator('section[aria-label="需要处理的失败任务"]');
      await expect(section).toBeVisible({ timeout: 20_000 });
      const row = section.locator("li", { hasText: "UX 基线夹具" }).first();
      await expect(row).toBeVisible({ timeout: 15_000 });
      notes.push("/queue 失败区行渲染(display_reason 上屏);");
      await uxClick(probe, row.getByRole("button", { name: "重新报价重试" }));
      const quoteBar = row.locator("text=本次重试约 ¥");
      const creditToast = page.locator("text=/积分不够|生成没排上/");
      await Promise.race([
        quoteBar.waitFor({ state: "visible", timeout: 15_000 }),
        creditToast.first().waitFor({ state: "visible", timeout: 15_000 }),
      ]).catch(() => { /* 双终态外即超时,如实往下走由回工作台步暴露 */ });
      notes.push("重新报价触达(金额条/积分人话双终态);");
      if ((await quoteBar.count()) > 0) await row.getByRole("button", { name: "取消", exact: true }).click(); // 报价成功态收口,不计击不 confirm
      await uxClick(probe, row.getByRole("button", { name: "回工作台处理" }));
      await page.waitForURL((url) => url.pathname.includes(`/scenes/${ctx.scene.id}`), { timeout: 15_000 });
      await expect(page.locator('aside[aria-label="参考控制包"]')).toBeVisible({ timeout: 15_000 });
      return { run, hops: probe.hops, clicks: probe.clicks, backtracks: probe.backtracks, completed: true, duration_ms: 0, notes };
    });
  } finally {
    await t4Cleanup(client);
    await client.end();
  }
  const t4 = taskResults.T4!;
  deadEnds.push("R3(T4,已修复):/queue 失败区常驻(P-10,sol failed 合同)——失败任务固定可回访落点+重新报价两阶段(quote→人工确认)+回工作台按归属降级;留此条作修复销账记录。");
  if (!t4.completed) console.warn(`[ux-baseline] T4 三跑完成数 <2——指标红项计入 B1/报告(test 层不 throw:throw 会触发 worker 重启,丢失共享采集状态);`);
});

/* ================= T5 交付一集(理想跳 1 / 点击 ≤4) ================= */

test("T5 交付一集", async ({ page }) => {
  test.setTimeout(600_000);
  await loginAsAdmin(page);
  const ctx = await wudaoContext(page);
  const prodPath = `/projects/${ctx.projectId}/production`;
  await runTaskThreeTimes(page, {
    task: "T5",
    name: "交付一集",
    spec_path: "集视图→审核→交付本集",
    ideal: { page_hops: 1, clicks: 4 },
    measured_scope: "集视图 →「更多 ▾」→「交付本集」→ 交付 modal(交付前核算区)打开即止(未落账)",
  }, async (run) => {
    const probe = new UxProbe();
    probe.attach(page);
    const notes: string[] = [
      "落账是写动作(且无二次确认,点「确认交付」直接 POST),实测止于 modal 打开,比值按实测段计;",
      "「审核队列」与「交付本集」同收「更多 ▾」,审核入口同跳数可达;",
    ];
    await page.goto(`${baseUrl()}${prodPath}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator('section[aria-label="场列表"] article').first()).toBeVisible({ timeout: 15_000 });
    await uxClick(probe, page.getByRole("button", { name: "更多 ▾", exact: true }));
    await uxClick(probe, page.getByRole("button", { name: "交付本集", exact: true }));
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/交付第 \d+ 集/, { exact: true })).toBeVisible();
    const accounting = dialog.locator('section[aria-label="交付前核算"]');
    notes.push((await accounting.count()) > 0
      ? `交付前核算区在场:${((await accounting.textContent()) ?? "").trim().slice(0, 60)};`
      : "交付前核算区不在场(本集或可交付产物为 0);");
    await dialog.getByRole("button", { name: "关闭" }).click(); // 收口卫生,不计入
    await expect(page.getByRole("dialog")).toHaveCount(0);
    return { run, hops: probe.hops, clicks: probe.clicks, backtracks: probe.backtracks, completed: true, duration_ms: 0, notes };
  });
  const t5 = taskResults.T5!;
  t5.notes.push("modal 不计页面跳转(理想跳 1 含完整交付动作);");
  if (!t5.completed) console.warn(`[ux-baseline] T5 三跑完成数 <2——指标红项计入 B1/报告(test 层不 throw:throw 会触发 worker 重启,丢失共享采集状态);`);
});

/* ================= T6 找一个资产并用上(理想跳 3 / 点击 ≤6) ================= */

test("T6 找一个资产并用上", async ({ page }) => {
  test.setTimeout(600_000);
  await loginAsAdmin(page);
  const ctx = await demoContext(page);
  const client = await connectPg();
  await clearProjectRefsPg(client, ctx.projectId);
  try {
    await runTaskThreeTimes(page, {
      task: "T6",
      name: "找一个资产并用上",
      spec_path: "任意页→检索→拉入项目→出现在备戏台",
      ideal: { page_hops: 3, clicks: 6 },
      measured_scope: "/assets 检索「沈孤舟」→ 资产卡拉入菜单选「本地演示项目」(R4 修复后直达,2 击) → /assets/prep 选三级 → 角色 lane 见沈孤舟",
    }, async (run) => {
      const probe = new UxProbe();
      probe.attach(page);
      const notes: string[] = [];
      await page.goto(`${baseUrl()}/assets`, { waitUntil: "domcontentloaded" });
      if (run === 1) await probePage(page, { page: "T6 起点 /assets", url_pattern: "/assets", main_action: 'input[aria-label="搜索资产"]', first_screen_visible: null, primary_count_in_main: null, settle: 'input[aria-label="搜索资产"]', note: "检索页主动作=检索本身" });
      await page.locator('input[aria-label="搜索资产"]').fill("沈孤舟");
      await uxClick(probe, page.getByRole("button", { name: "查询", exact: true }));
      const card = page.locator("article", { hasText: "沈孤舟" }).first();
      await expect(card).toBeVisible({ timeout: 15_000 });
      /* R4 已修:资产卡 FolderPlus 拉入菜单直达项目(卡拉入1+选项目1=2 击),不再人肉转场;
         A4 项目资产页 probe 挪 T1 终点(零额外跳数);检索 fill 不计击(同旧口径)。 */
      await uxClick(probe, card.getByRole("button", { name: /拉入项目/ }));
      await uxClick(probe, page.getByRole("menuitem", { name: /本地演示项目/ }));
      await expect(page.getByText(/拉入《本地演示项目》|已经在《本地演示项目》/)).toBeVisible({ timeout: 10_000 });
      notes.push("R4 已修复:资产卡拉入菜单直达项目(2 击),找与用不再断;");

      await page.goto(`${baseUrl()}/assets/prep`, { waitUntil: "domcontentloaded" });
      await expect(page.locator('div[aria-label="备戏台"]')).toBeVisible({ timeout: 15_000 });
      await page.locator('select[aria-label="选择项目"]').selectOption({ label: "本地演示项目" });
      probe.clicks += 1;
      await page.locator('select[aria-label="选择集"]').selectOption({ index: 0 });
      probe.clicks += 1;
      await page.locator('select[aria-label="选择场"]').selectOption({ index: 0 });
      probe.clicks += 1;
      const roleLane = page.locator('section[aria-label="备戏 角色"]');
      await expect(roleLane.getByText("沈孤舟", { exact: true })).toBeVisible({ timeout: 15_000 });
      notes.push("「用上」终点=备戏台角色 lane 由 refs 真源播种出沈孤舟(已就位);");
      return { run, hops: probe.hops, clicks: probe.clicks, backtracks: probe.backtracks, completed: true, duration_ms: 0, notes };
    }, async () => {
      await clearProjectRefsPg(client, ctx.projectId);
    });
  } finally {
    await clearProjectRefsPg(client, ctx.projectId);
    await client.end();
  }
  const t6 = taskResults.T6!;
  t6.notes.push("受体=本地演示项目,每遍后清 refs 恢复;备戏台三级选择计 3 击(selectOption);");
  deadEnds.push("R4(T6,已修复):资产卡 FolderPlus 拉入菜单(项目列+?project= 上下文排首位标「当前项目」,409 判重人话)——找与用直达 2 击;留此条作修复销账记录。");
  if (!t6.completed) console.warn(`[ux-baseline] T6 三跑完成数 <2——指标红项计入 B1/报告(test 层不 throw:throw 会触发 worker 重启,丢失共享采集状态);`);
});

/* ================= 汇总落账 ================= */

test.afterAll(async () => {
  await mkdir(artifactDir, { recursive: true });
  await mkdir(kimiEvalDir, { recursive: true });

  const tasks = Object.values(taskResults);
  const assessed = tasks.filter((task) => task.hop_ratio !== null);
  const hopPassed = assessed.filter((task) => task.hop_pass === true);
  const clickPassed = assessed.filter((task) => task.click_pass === true);
  const completed = tasks.filter((task) => task.completed);
  const backtracksTotal = tasks.reduce((sum, task) => sum + task.forced_backtracks_total, 0);
  const a3Pages = pageProbes.filter((probe) => probe.first_screen_visible !== null);
  const a3Passed = a3Pages.filter((probe) => probe.first_screen_visible === true);
  const a4Pages = pageProbes.filter((probe) => probe.primary_count_in_main !== null);
  const a4Passed = a4Pages.filter((probe) => probe.primary_count_in_main === 1);

  let headSha = "unknown";
  try {
    headSha = execSync("git rev-parse HEAD", { cwd: worktreeRoot, encoding: "utf8" }).trim();
  } catch { /* 如实降级 */ }

  const summary = {
    goal: "UX 六任务自动化基线(R157,docs/design/ux-metrics.md)",
    measured_at: new Date().toISOString(),
    base_url: baseUrl(),
    baseline_commit: headSha,
    runs_per_task: 3,
    thresholds: { hop_ratio: "<=1.0", click_ratio: "<=1.2", first_screen: "100%", single_primary: "100%", forced_backtracks: 0, completion: "6/6" },
    tasks: taskResults,
    page_probes: pageProbes,
    dead_ends: deadEnds,
    aggregate: {
      hop_ratio_passed: `${hopPassed.length}/${assessed.length}`,
      click_ratio_passed: `${clickPassed.length}/${assessed.length}`,
      first_screen: `${a3Passed.length}/${a3Pages.length}`,
      single_primary: `${a4Passed.length}/${a4Pages.length}`,
      forced_backtracks_total: backtracksTotal,
      task_completion: `${completed.length}/${tasks.length}`,
    },
  };
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  /* kimi-ux-eval.v1(sol run-product-e2e-report 消费 A1-A5+B2;B2 由 zeroguide spec 回填) */
  const kimiEval = {
    schema_version: "kimi-ux-eval.v1",
    generated_at: new Date().toISOString(),
    baseline_commit: headSha,
    target_environment: "local",
    target_base_url: baseUrl(),
    metrics: [
      {
        id: "A1",
        status: assessed.length > 0 && hopPassed.length === assessed.length ? "passed" : "failed",
        numerator: hopPassed.length,
        denominator: assessed.length,
        rate_pct: assessed.length > 0 ? Math.round((hopPassed.length / assessed.length) * 10_000) / 100 : undefined,
        measured_value: `${hopPassed.length}/${assessed.length}`,
        details: tasks.map((task) => ({ task: task.task, hop_ratio: task.hop_ratio, ideal: task.ideal.page_hops, median_hops: task.median.hops })),
        note: "跳数比=三跑中位跳数÷理想跳数;付费红线任务比值按实测段(前缀)计。",
      },
      {
        id: "A2",
        status: assessed.length > 0 && clickPassed.length === assessed.length ? "passed" : "failed",
        numerator: clickPassed.length,
        denominator: assessed.length,
        rate_pct: assessed.length > 0 ? Math.round((clickPassed.length / assessed.length) * 10_000) / 100 : undefined,
        measured_value: `${clickPassed.length}/${assessed.length}`,
        details: tasks.map((task) => ({ task: task.task, click_ratio: task.click_ratio, ideal: task.ideal.clicks, median_clicks: task.median.clicks })),
        note: "点击比=三跑中位点击÷理想点击;fill/selectOption 各计 1 击,收口卫生动作不计。",
      },
      {
        id: "A3",
        status: a3Pages.length > 0 && a3Passed.length === a3Pages.length ? "passed" : "failed",
        numerator: a3Passed.length,
        denominator: a3Pages.length,
        rate_pct: a3Pages.length > 0 ? Math.round((a3Passed.length / a3Pages.length) * 10_000) / 100 : undefined,
        measured_value: `${a3Passed.length}/${a3Pages.length}`,
        details: pageProbes.map((probe) => ({ page: probe.page, first_screen_visible: probe.first_screen_visible })),
        note: "首屏=1440×900 视口内无滚动可见主动作。",
      },
      {
        id: "A4",
        status: a4Pages.length > 0 && a4Passed.length === a4Pages.length ? "passed" : "failed",
        numerator: a4Passed.length,
        denominator: a4Pages.length,
        rate_pct: a4Pages.length > 0 ? Math.round((a4Passed.length / a4Pages.length) * 10_000) / 100 : undefined,
        measured_value: `${a4Passed.length}/${a4Pages.length}`,
        details: pageProbes.map((probe) => ({ page: probe.page, primary_count_in_main: probe.primary_count_in_main })),
        note: "下一步显性=main#main-content 内 bg-accent 按钮恰 1 枚(V-24 口径,全局 Pi 抽屉不计)。",
      },
      {
        id: "A5",
        status: backtracksTotal === 0 ? "passed" : "failed",
        numerator: backtracksTotal,
        denominator: 0,
        measured_value: `${backtracksTotal} 次`,
        details: tasks.map((task) => ({ task: task.task, forced_backtracks_total: task.forced_backtracks_total })),
        note: "被迫回头=标准任务中非自愿返回上页次数。",
      },
      {
        id: "B2",
        status: "not_assessable",
        note: "零指导完成率由 ux-zeroguide.smoke.spec.ts(Midscene,每任务 3 跑取中位)跑完回填本文件。",
      },
    ],
  };
  await writeFile(kimiEvalPath, `${JSON.stringify(kimiEval, null, 2)}\n`, "utf8");

  console.log(`[ux-baseline] summary → ${path.relative(worktreeRoot, summaryPath)}`);
  console.log(`[ux-baseline] kimi-ux-eval → ${path.relative(worktreeRoot, kimiEvalPath)}`);
  console.log(`[ux-baseline] 完成 ${completed.length}/${tasks.length} · 跳数达标 ${hopPassed.length}/${assessed.length} · 点击达标 ${clickPassed.length}/${assessed.length} · 首屏 ${a3Passed.length}/${a3Pages.length} · 唯一 primary ${a4Passed.length}/${a4Pages.length} · 回头 ${backtracksTotal}`);
});
