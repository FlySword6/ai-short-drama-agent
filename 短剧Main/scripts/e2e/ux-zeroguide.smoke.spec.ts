/**
 * UX B2 零指导完成率(R157,docs/design/ux-metrics.md 真源;Fable 2026-08-03 派单)。
 *
 * 跑法(ux-metrics.md §三.2):Midscene aiAct 只给一句任务目标,不给任何步骤——
 * AI=「第一次用的导演」代理(V-53b 自动化)。记录 成功/步数(aiAct 调用数)/
 * 走错次数(纠偏轮数),每任务 3 跑,≥2 跑成功=任务零指导完成;B2=完成任务数/6。
 * 跑完把 B2 行回填进 artifacts/kimi-ux-eval/ux-metrics.json(与 ux-baseline 同一份)。
 *
 * 付费与数据红线(硬约束,写进目标句+跑后 pg 校验双保险):
 *   - T3/T4/T5 目标句明令「看到确认界面就停,绝对不要点最终确认/提交/交付钮」;
 *   - 每跑后 pg 校验:T3/T4 无新 generation_requests、T5 无新 delivery_records,
 *     越线即红项并计入报告(交付/生成不可回滚,越线本身是重大发现);
 *   - T1 AI 新建的项目跑后软删+回收站硬删;T2/T6 前后清项目资产 refs;
 *   - T4 夹具同 ux-baseline(固定 UUID,跑前复活未读提醒,跑后删除)。
 *
 * 终点判定=本 spec 的 DOM 硬断言(不算 AI 步数):AI 停手后由 spec 验证
 * 任务终点是否真实到达,AI 自称完成不算数。
 *
 * 用法:
 *   SGOAL06_BASE_URL=http://localhost:5173 npx playwright test \
 *     --config scripts/e2e/ux-zeroguide.playwright.config.ts
 *
 * 凭据读 TEST_ENV_ADMIN_* 与 MIDSCENE_MODEL_*(共享根 .env),不打印、不写报告。
 * 属地:同 ux-baseline 一套,自建文件不碰他域。
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "@playwright/test";
import { PlaywrightAiFixture, type PlayWrightAiFixtureType } from "@midscene/web/playwright";
import pg from "pg";

const test = base.extend<PlayWrightAiFixtureType>(PlaywrightAiFixture());

const worktreeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifactDir = path.resolve(
  process.env.UX_ZEROGUIDE_ARTIFACT_DIR ?? path.join(worktreeRoot, "artifacts", "ux-zeroguide"),
);
const screenshotDir = path.join(artifactDir, "screenshots");
const resultsPath = path.join(artifactDir, "zeroguide-results.json");
const kimiEvalPath = path.join(worktreeRoot, "artifacts", "kimi-ux-eval", "ux-metrics.json");
/** 单跑 aiAct 上限:超过即判本跑失败(AI 迷路/死等),进入纠偏或收尾。 */
const AI_ACT_BUDGET_MS = Number(process.env.UX_ZEROGUIDE_ACT_BUDGET_MS ?? 360_000);

interface ZeroRun {
  run: number;
  success: boolean;
  ai_steps: number;
  wrong_turns: number;
  duration_ms: number;
  redline_ok: boolean;
  final_url: string;
  note?: string;
}
interface ZeroTask {
  task: string;
  name: string;
  goal_text: string;
  runs: ZeroRun[];
  completed: boolean;
}
const zeroTasks: Record<string, ZeroTask> = {};

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

/** 登录(幂等+抗后端热重启窗):共享 8000 由 tsx watch 提供,热重启窗口 login 会 500/断连;
    撞窗最多重试 3 次(间隔 5s)。登录不算任务动线,重试不污染六任务指标。 */
async function loginAsAdmin(page: import("@playwright/test").Page): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(`${baseUrl()}/login`, { waitUntil: "domcontentloaded" });
      if (new URL(page.url()).pathname === "/projects") return;
      // 账号框 autoComplete 按 allowRegister 合法切换(email/username,F08)，选择器改用不随之变的 data-testid。
      const userInput = page.getByTestId("login-username-input");
      const formVisible = await userInput.isVisible({ timeout: 5_000 }).catch(() => false);
      if (!formVisible) {
        await page.waitForURL((u) => u.pathname === "/projects", { timeout: 10_000 });
        return;
      }
      await userInput.fill(requiredEnv("TEST_ENV_ADMIN_USERNAME"));
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

async function apiJson<T>(page: import("@playwright/test").Page, url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  return page.evaluate(async ({ url: u, method, body }) => {
    const token = window.sessionStorage.getItem("shortdrama_v01_token");
    if (!token) throw new Error("登录后未找到会话");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = "application/json"; // 无 body 带 json 头会被 fastify 当空 JSON 拒(400)
    const response = await fetch(u, {
      method: method ?? "GET",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method ?? "GET"} ${u} 返回 ${response.status}`);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }, { url, method: init?.method, body: init?.body });
}

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

/** aiAct 带预算:超时按本跑迷路处理,不让单跑拖死整个 test。 */
async function aiActWithBudget(agent: { aiAct: (prompt: string) => Promise<unknown> }, prompt: string): Promise<{ outcome: "done" | "timeout" | "error"; message?: string }> {
  try {
    await Promise.race([
      agent.aiAct(prompt),
      new Promise((_, reject) => { setTimeout(() => reject(new Error("ai-act-budget-exceeded")), AI_ACT_BUDGET_MS); }),
    ]);
    return { outcome: "done" };
  } catch (error) {
    if (error instanceof Error && error.message === "ai-act-budget-exceeded") return { outcome: "timeout" };
    /* 抛错记真 message(基线教训:只记「抛错」时分不清 AI 拒答/模型端抖动/元素找不到) */
    return { outcome: "error", message: (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200) };
  }
}

/** 零指导单跑:目标句一次 + 失败时最多一轮纠偏;终点由 verify 硬断言。 */
async function zeroAttempt(input: {
  page: import("@playwright/test").Page;
  agentForPage: PlayWrightAiFixtureType["agentForPage"];
  run: number;
  goal: string;
  verify: () => Promise<void>;
  redline?: () => Promise<boolean>;
}): Promise<ZeroRun> {
  const { page, run, goal } = input;
  const started = Date.now();
  let aiSteps = 0;
  let wrongTurns = 0;
  let success = false;
  let note: string | undefined;

  const agent = await input.agentForPage(page);
  const first = await aiActWithBudget(agent, goal);
  aiSteps += 1;
  if (first.outcome !== "done") note = `首轮 aiAct ${first.outcome === "timeout" ? "超预算(迷路/死等)" : `抛错:${first.message ?? "自称做不到"}`}`;
  try {
    await input.verify();
    success = true;
  } catch {
    if (first.outcome === "done") {
      // AI 自称做完但终点没到=走错,给一轮纠偏
      wrongTurns += 1;
      aiSteps += 1;
      const second = await aiActWithBudget(agent, `刚才的尝试没有到达目标。重新观察当前页面状态,继续完成这个目标:${goal}`);
      if (second.outcome !== "done") note = `纠偏轮 aiAct ${second.outcome === "timeout" ? "超预算" : `抛错:${second.message ?? ""}`}`;
      try {
        await input.verify();
        success = true;
      } catch (error) {
        note = `${note ? `${note};` : ""}终点判定未过:${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
      }
    } else {
      note = `${note ? `${note};` : ""}首轮未正常结束且终点未到,不再纠偏;`;
    }
  }

  let redlineOk = true;
  if (input.redline) {
    redlineOk = await input.redline().catch(() => false);
    if (!redlineOk) note = `${note ? `${note};` : ""}红线校验失败:检测到真实提交/落账痕迹(重大发现);`;
  }
  return { run, success, ai_steps: aiSteps, wrong_turns: wrongTurns, duration_ms: Date.now() - started, redline_ok: redlineOk, final_url: page.url(), note };
}

/** 结果落盘(读-改-写 merge):worker 因 test 崩溃重启会丢内存采集态,
    每 test 结束即增量 merge 落盘,afterAll 再汇总结算。 */
async function flushZeroResults(): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  let existing: Record<string, ZeroTask> = {};
  try {
    const raw = JSON.parse(await readFile(resultsPath, "utf8")) as { tasks?: Record<string, ZeroTask> };
    existing = raw.tasks ?? {};
  } catch { /* 首写 */ }
  const tasks = { ...existing, ...zeroTasks };
  const completed = Object.values(tasks).filter((task) => task.completed);
  const results = {
    goal: "UX B2 零指导完成率(ux-metrics.md §三.2:Midscene 只给任务目标,每任务 3 跑)",
    measured_at: new Date().toISOString(),
    base_url: baseUrl(),
    ai_act_budget_ms: AI_ACT_BUDGET_MS,
    tasks,
    aggregate: {
      zero_guidance_completion: `${completed.length}/${Object.keys(tasks).length}`,
      redline_violations: Object.values(tasks).flatMap((task) => task.runs.filter((run) => !run.redline_ok).map((run) => `${task.task}-run${run.run}`)),
    },
  };
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
}

async function runZeroTask(
  page: import("@playwright/test").Page,
  agentForPage: PlayWrightAiFixtureType["agentForPage"],
  task: Omit<ZeroTask, "runs" | "completed">,
  hooks: {
    verify: () => Promise<void>;
    beforeEach?: (run: number) => Promise<void>;
    afterEach?: (run: number) => Promise<void>;
    redline?: () => Promise<boolean>;
  },
): Promise<void> {
  const runs: ZeroRun[] = [];
  for (let run = 1; run <= 3; run += 1) {
    await hooks.beforeEach?.(run);
    await loginAsAdmin(page);
    const record = await zeroAttempt({ page, agentForPage, run, goal: task.goal_text, verify: hooks.verify, redline: hooks.redline });
    if (!record.success) {
      await page.screenshot({ path: path.join(screenshotDir, `${task.task}-run${run}-failed.png`), fullPage: true }).catch(() => undefined);
    }
    runs.push(record);
    await hooks.afterEach?.(run);
  }
  const result: ZeroTask = { ...task, runs, completed: runs.filter((item) => item.success).length >= 2 };
  zeroTasks[task.task] = result;
  /* 落盘免疫 worker 重启(同 ux-baseline 架构):afterAll 读盘聚合 */
  await mkdir(path.join(artifactDir, "tasks"), { recursive: true });
  const file = path.join(artifactDir, "tasks", `${task.task}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await rename(temporary, file);
  await flushZeroResults();
}

/* ---------- 上下文助手 ---------- */

async function findProject(page: import("@playwright/test").Page, namePart: string): Promise<{ id: string; name?: string }> {
  const data = await apiJson<{ data?: { items?: Array<{ id: string; name?: string }> } }>(page, "/api/v1/projects");
  const project = (data.data?.items ?? []).find((item) => (item.name ?? "").includes(namePart));
  if (!project) throw new Error(`没有找到 name 含「${namePart}」的项目`);
  return project;
}

async function listProjectIds(page: import("@playwright/test").Page): Promise<Set<string>> {
  const data = await apiJson<{ data?: { items?: Array<{ id: string }> } }>(page, "/api/v1/projects");
  return new Set((data.data?.items ?? []).map((item) => item.id));
}

async function clearProjectRefsPg(client: pg.Client, projectId: string): Promise<void> {
  await client.query("DELETE FROM project_asset_refs WHERE project_id = $1", [projectId]);
}

const T4_IDS = {
  request: "00000000-a001-4100-8000-000000000401",
  attempt: "00000000-a001-4100-8000-000000000402",
  notification: "00000000-a001-4100-8000-000000000403",
};

test.beforeAll(async () => {
  await mkdir(screenshotDir, { recursive: true });
  requiredEnv("TEST_ENV_ADMIN_USERNAME");
  requiredEnv("TEST_ENV_ADMIN_PASSWORD");
  requiredEnv("MIDSCENE_MODEL_API_KEY");
  requiredEnv("MIDSCENE_MODEL_NAME");
});

/* ================= T1 新建项目到有剧本 ================= */

test("B2-T1 新建项目到有剧本(零指导)", async ({ page, agentForPage }) => {
  test.setTimeout(1_450_000);
  await loginAsAdmin(page);
  const beforeIds = await listProjectIds(page);
  await runZeroTask(page, agentForPage, {
    task: "T1",
    name: "新建项目到有剧本",
    goal_text: "在这个短剧制作系统里新建一个项目(名字你起,带上「零指导」三个字),给这个项目贴上一段你自己编的两三场的短剧剧本,完成剧本拆解并确认,让项目正式拥有剧本分镜。完成后停在确认完成的页面。",
  }, {
    verify: async () => {
      await page.waitForURL((url) => /\/projects\/[^/]+\/assets$/.test(url.pathname), { timeout: 20_000 });
    },
  });
  // 清理:diff 出 AI 建的项目,软删(API)+pg 级联硬删(回收站硬删端点对含 P-06 剧本表项目 500,兜底)
  // 注意:AI 可能已把会话玩丢(登出/清 sessionStorage),先确保登录态再 diff
  await loginAsAdmin(page);
  const afterIds = await listProjectIds(page);
  const client = await connectPg();
  try {
    for (const id of afterIds) {
      if (beforeIds.has(id)) continue;
      await apiJson(page, `/api/v1/projects/${id}`, { method: "DELETE" }).catch(() => undefined);
      await client.query("DELETE FROM script_breakdown_runs WHERE episode_id IN (SELECT id FROM episodes WHERE project_id=$1)", [id]);
      await client.query("DELETE FROM episode_script_versions WHERE episode_id IN (SELECT id FROM episodes WHERE project_id=$1)", [id]);
      await client.query("DELETE FROM shots WHERE episode_id IN (SELECT id FROM episodes WHERE project_id=$1)", [id]);
      await client.query("DELETE FROM scenes WHERE episode_id IN (SELECT id FROM episodes WHERE project_id=$1)", [id]);
      await client.query("DELETE FROM episodes WHERE project_id=$1", [id]);
      await client.query("DELETE FROM projects WHERE id=$1 AND deleted_at IS NOT NULL", [id]);
    }
  } finally {
    await client.end();
  }
});

/* ================= T2 备一场戏 ================= */

test("B2-T2 备一场戏(零指导)", async ({ page, agentForPage }) => {
  test.setTimeout(1_200_000);
  await loginAsAdmin(page);
  const demo = await findProject(page, "本地演示项目");
  const client = await connectPg();
  try {
    await clearProjectRefsPg(client, demo.id);
    await runZeroTask(page, agentForPage, {
      task: "T2",
      name: "备一场戏",
      goal_text: "把「本地演示项目」第 1 集的第 1 场戏备好:从资产库拉三件参考(角色、场景、光影各一件)放进这场戏的备戏单,然后「送入这场戏」。完成后停在它带你去的页面。",
    }, {
      verify: async () => {
        await page.waitForURL((url) => url.pathname.includes("/scenes/"), { timeout: 20_000 });
      },
      afterEach: async () => { await clearProjectRefsPg(client, demo.id); },
    });
    await clearProjectRefsPg(client, demo.id);
  } finally {
    await client.end();
  }
});

/* ================= T3 开拍一段(付费红线:止步确认区) ================= */

test("B2-T3 开拍一段(零指导)", async ({ page, agentForPage }) => {
  test.setTimeout(1_200_000);
  const client = await connectPg();
  let runStart = new Date();
  try {
    await runZeroTask(page, agentForPage, {
      task: "T3",
      name: "开拍一段",
      goal_text: "把《雾岛来信》第 1 集的「巷口雨夜」这一场推进到开拍:进入这场戏的段落工作台,点「开拍」,走到出现确认报价的区域。看到确认报价区域出现就算到达目标,立刻停在那里——绝对不要点「确认开拍」「确认出样片」或任何最终提交按钮,那会产生真实费用。",
    }, {
      beforeEach: async () => { runStart = new Date(); },
      verify: async () => {
        await expect(page.locator('section[aria-label="整段生成确认"]')).toBeVisible({ timeout: 20_000 });
      },
      redline: async () => {
        const result = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM generation_requests WHERE created_at > $1", [runStart]);
        return Number(result.rows[0]?.count ?? "0") === 0;
      },
    });
  } finally {
    await client.end();
  }
});

/* ================= T4 处理一次失败(付费红线:止步确认区) ================= */

test("B2-T4 处理一次失败(零指导)", async ({ page, agentForPage }) => {
  test.setTimeout(1_200_000);
  await loginAsAdmin(page);
  const wudao = await findProject(page, "雾岛");
  const episodes = await apiJson<{ data?: { items?: Array<{ id: string; episode_no: number }> } }>(page, `/api/v1/projects/${wudao.id}/episodes`);
  const episode = [...(episodes.data?.items ?? [])].sort((a, b) => a.episode_no - b.episode_no)[0]!;
  const scenes = await apiJson<{ data?: { items?: Array<{ id: string; sort_order?: number }> } }>(page, `/api/v1/episodes/${episode.id}/scenes`);
  const scene = [...(scenes.data?.items ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))[0]!;
  const shots = await apiJson<{ data?: { items?: Array<{ id: string; shot_no: number }> } }>(page, `/api/v1/episodes/${episode.id}/shots`);
  const shot = [...(shots.data?.items ?? [])].sort((a, b) => a.shot_no - b.shot_no)[0]!;

  const client = await connectPg();
  const userRow = await client.query<{ id: string }>("SELECT id FROM users WHERE username = $1 LIMIT 1", [requiredEnv("TEST_ENV_ADMIN_USERNAME")]);
  const userId = userRow.rows[0]?.id;
  if (!userId) throw new Error("users 表查不到当前登录用户");
  const now = new Date();
  const hash = createHash("sha256").update("ux-baseline-t4-retry").digest("hex");
  await client.query(
    `INSERT INTO generation_requests (id, user_id, project_id, episode_id, scene_id, shot_id, target_asset_entity_id, media_kind, prompt, reference_media_ids, reference_asset_snapshots, parameters, quantity, client_idempotency_key, request_hash, charged_points, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,'image','UX 基线 T4 夹具:雨夜追逐参考图(失败重试用例)','[]','[]','{}',1,'ux-baseline-t4-retry',$7,60,$8,$8)
     ON CONFLICT (id) DO NOTHING`,
    [T4_IDS.request, userId, wudao.id, episode.id, scene.id, shot.id, hash, now],
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
    [T4_IDS.notification, T4_IDS.attempt, T4_IDS.request, wudao.id, userId, now],
  );

  let runStart = new Date();
  try {
    await runZeroTask(page, agentForPage, {
      task: "T4",
      name: "处理一次失败",
      goal_text: "这个系统里刚有一条生成任务失败了(留意页面右下角的任务提醒)。找到这条失败的任务,打开它对应的镜头,把那个镜头推进到「重生成/生成」的确认界面。看到确认界面出现就算到达目标,立刻停下——绝对不要点「确认生成」或任何最终提交按钮,那会产生真实费用。",
    }, {
      beforeEach: async (run) => {
        runStart = new Date();
        await client.query("UPDATE generation_attempt_notifications SET acknowledged_at = NULL WHERE id = $1", [T4_IDS.notification]);
        void run;
      },
      verify: async () => {
        await expect(page.locator('div[aria-label$="重生成确认"]')).toBeVisible({ timeout: 20_000 });
      },
      redline: async () => {
        const result = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM generation_requests WHERE created_at > $1", [runStart]);
        return Number(result.rows[0]?.count ?? "0") === 0;
      },
    });
  } finally {
    await client.query("DELETE FROM generation_attempt_notifications WHERE id = $1", [T4_IDS.notification]);
    await client.query("DELETE FROM generation_attempts WHERE id = $1", [T4_IDS.attempt]);
    await client.query("DELETE FROM generation_requests WHERE id = $1", [T4_IDS.request]);
    await client.end();
  }
});

/* ================= T5 交付一集(落账红线:止步 modal) ================= */

test("B2-T5 交付一集(零指导)", async ({ page, agentForPage }) => {
  test.setTimeout(1_200_000);
  const client = await connectPg();
  let runStart = new Date();
  try {
    await runZeroTask(page, agentForPage, {
      task: "T5",
      name: "交付一集",
      goal_text: "把《雾岛来信》第 1 集推进到交付:在这个项目的生产页找到「交付本集」入口,打开交付确认窗口。看到交付确认窗口(里面有交付前核算信息)出现就算到达目标,立刻停下——绝对不要点「确认交付」「先交已就绪」或任何最终交付按钮,那会直接落账不可撤回。",
    }, {
      beforeEach: async () => { runStart = new Date(); },
      verify: async () => {
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText(/交付第 \d+ 集/, { exact: true })).toBeVisible({ timeout: 20_000 });
      },
      redline: async () => {
        const result = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM delivery_records WHERE created_at > $1", [runStart]);
        return Number(result.rows[0]?.count ?? "0") === 0;
      },
    });
  } finally {
    await client.end();
  }
});

/* ================= T6 找一个资产并用上 ================= */

test("B2-T6 找一个资产并用上(零指导)", async ({ page, agentForPage }) => {
  test.setTimeout(1_200_000);
  await loginAsAdmin(page);
  const demo = await findProject(page, "本地演示项目");
  const client = await connectPg();
  try {
    await clearProjectRefsPg(client, demo.id);
    await runZeroTask(page, agentForPage, {
      task: "T6",
      name: "找一个资产并用上",
      goal_text: "把资产库里的「沈孤舟」拉进「本地演示项目」,让它成为这个项目可用的角色参考。完成后停在你确认它已经进项目的页面。",
    }, {
      verify: async () => {
        // 「用上」终点=备戏台角色 lane 由 refs 真源播种出沈孤舟(spec 判定动作,不计 AI 步数)
        await page.goto(`${baseUrl()}/assets/prep`, { waitUntil: "domcontentloaded" });
        await expect(page.locator('div[aria-label="备戏台"]')).toBeVisible({ timeout: 15_000 });
        await page.locator('select[aria-label="选择项目"]').selectOption({ label: "本地演示项目" });
        await page.locator('select[aria-label="选择集"]').selectOption({ index: 0 });
        await page.locator('select[aria-label="选择场"]').selectOption({ index: 0 });
        await expect(page.locator('section[aria-label="备戏 角色"]').getByText("沈孤舟", { exact: true })).toBeVisible({ timeout: 15_000 });
      },
      afterEach: async () => { await clearProjectRefsPg(client, demo.id); },
    });
    await clearProjectRefsPg(client, demo.id);
  } finally {
    await client.end();
  }
});

/* ================= 汇总:B2 回填 kimi-ux-eval ================= */

test.afterAll(async () => {
  await mkdir(artifactDir, { recursive: true });
  let tasks = Object.values(zeroTasks);
  try {
    const dir = path.join(artifactDir, "tasks");
    const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
    if (files.length > 0) {
      tasks = [];
      for (const file of files) tasks.push(JSON.parse(await readFile(path.join(dir, file), "utf8")) as ZeroTask);
    }
  } catch { /* 盘空则用内存 */ }
  const completed = tasks.filter((task) => task.completed);
  const results = {
    goal: "UX B2 零指导完成率(ux-metrics.md §三.2:Midscene 只给任务目标,每任务 3 跑)",
    measured_at: new Date().toISOString(),
    base_url: baseUrl(),
    ai_act_budget_ms: AI_ACT_BUDGET_MS,
    tasks: Object.fromEntries(tasks.map((task) => [task.task, task])),
    aggregate: {
      zero_guidance_completion: `${completed.length}/${tasks.length}`,
      redline_violations: tasks.flatMap((task) => task.runs.filter((run) => !run.redline_ok).map((run) => `${task.task}-run${run.run}`)),
    },
  };
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");

  /* 回填 kimi-ux-eval 的 B2 行(同一份文件,ux-baseline 已写好 A 组) */
  let raw: Record<string, unknown> = {
    schema_version: "kimi-ux-eval.v1",
    generated_at: new Date().toISOString(),
    baseline_commit: "unknown",
    target_environment: "local",
    target_base_url: baseUrl(),
    metrics: [],
  };
  try {
    raw = JSON.parse(await readFile(kimiEvalPath, "utf8")) as Record<string, unknown>;
  } catch { /* 缺文件则新建骨架 */ }
  const metrics = Array.isArray(raw.metrics) ? raw.metrics as Array<Record<string, unknown>> : [];
  const b2Index = metrics.findIndex((item) => item.id === "B2");
  const b2 = {
    id: "B2",
    status: tasks.length > 0 && completed.length === tasks.length ? "passed" : "failed",
    numerator: completed.length,
    denominator: tasks.length,
    rate_pct: tasks.length > 0 ? Math.round((completed.length / tasks.length) * 10_000) / 100 : undefined,
    measured_value: `${completed.length}/${tasks.length}`,
    details: tasks.map((task) => ({
      task: task.task,
      completed: task.completed,
      runs: task.runs.map((run) => ({ success: run.success, ai_steps: run.ai_steps, wrong_turns: run.wrong_turns, duration_ms: run.duration_ms, redline_ok: run.redline_ok, note: run.note })),
    })),
    note: "零指导=Midscene aiAct 只给任务目标一句话;≥2/3 跑成功=任务完成;步数=aiAct 调用数,走错=纠偏轮数;付费任务目标句带停止线+pg 越线校验。",
  };
  if (b2Index >= 0) metrics[b2Index] = b2;
  else metrics.push(b2);
  raw.metrics = metrics;
  raw.generated_at = new Date().toISOString();
  await mkdir(path.dirname(kimiEvalPath), { recursive: true });
  await writeFile(kimiEvalPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

  console.log(`[ux-zeroguide] results → ${path.relative(worktreeRoot, resultsPath)}`);
  console.log(`[ux-zeroguide] B2 回填 → ${path.relative(worktreeRoot, kimiEvalPath)}`);
  console.log(`[ux-zeroguide] 零指导完成 ${completed.length}/${tasks.length};红线违例 ${results.aggregate.redline_violations.length} 起`);
});
