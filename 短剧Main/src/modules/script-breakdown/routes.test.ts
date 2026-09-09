import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { Database } from "../../db/client.js";
import { errorBody, ForbiddenError } from "../../shared/errors.js";
import { registerScriptBreakdownRoutes } from "./routes.js";
import { ScriptBreakdownService } from "./service.js";
import { PROMPT_VERSION } from "./types.js";
import {
  AllowAllAccess,
  happyPathToolTurns,
  InMemoryScriptBreakdownRepository,
  ScriptedToolTurnGateway,
  TEST_ACTOR,
  TEST_EPISODE_ID,
  TEST_SCRIPT_TEXT,
  type ToolTurnStep,
} from "./test-doubles.js";

const ACTOR_HEADERS = { "content-type": "application/json" };
const RUN_ID = "99999999-9999-4999-8999-999999999999";

interface Harness {
  app: FastifyInstance;
  repository: InMemoryScriptBreakdownRepository;
  gateway: ScriptedToolTurnGateway;
}

async function harness(options: {
  authenticated?: boolean;
  denyCreate?: boolean;
  gatewaySteps?: ToolTurnStep[];
} = {}): Promise<Harness> {
  const repository = new InMemoryScriptBreakdownRepository();
  const gateway = new ScriptedToolTurnGateway(options.gatewaySteps ?? happyPathToolTurns());
  const access = new AllowAllAccess((action) => (
    options.denyCreate && action === "create" ? new ForbiddenError() : null
  ));
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? Number((error as { statusCode: number }).statusCode)
      : 500;
    return reply.code(statusCode).send({ ok: false, error: errorBody(error) });
  });
  if (options.authenticated !== false) {
    app.addHook("preHandler", async (request) => {
      request.authUser = { id: TEST_ACTOR.id, username: "tester", displayName: "测试用户", role: TEST_ACTOR.role };
    });
  }
  await registerScriptBreakdownRoutes(app, () => ({} as Database), {
    createService: () => new ScriptBreakdownService(repository, gateway, access),
    executeRunsInline: true,
  });
  return { app, repository, gateway };
}

async function createVersionAndRun(app: FastifyInstance) {
  const versionResponse = await app.inject({
    method: "POST",
    url: `/api/v1/episodes/${TEST_EPISODE_ID}/script-versions`,
    headers: ACTOR_HEADERS,
    payload: { title: "第一集", script_text: TEST_SCRIPT_TEXT, client_idempotency_key: "route-version-1" },
  });
  assert.equal(versionResponse.statusCode, 200, versionResponse.body);
  const version = versionResponse.json().data.version;
  const runResponse = await app.inject({
    method: "POST",
    url: `/api/v1/episodes/${TEST_EPISODE_ID}/script-breakdowns`,
    headers: ACTOR_HEADERS,
    payload: { script_version_id: version.id, target_duration_sec: 90, client_idempotency_key: "route-run-1" },
  });
  assert.equal(runResponse.statusCode, 200, runResponse.body);
  return runResponse.json().data;
}

test("路由:建版本 → 发起拆解(内联执行)→ 读进度 → 确认 → 重复确认幂等", async () => {
  const { app, repository } = await harness();
  const created = await createVersionAndRun(app);
  assert.equal(created.outcome, "created");
  assert.equal(created.run.status, "draft", "内联执行后应直接拿到草稿");
  assert.equal(created.stages.length, 0, "agent 路没有阶段,过程走事件");
  assert.ok(created.events.length > 0, "过程事件必须能从接口拿到");
  assert.equal(created.run.usage.call_count, 5, "响应走 snake_case 信封;口径是模型往返次数");

  const detail = await app.inject({ method: "GET", url: `/api/v1/script-breakdowns/${created.run.id}` });
  assert.equal(detail.statusCode, 200);
  const detailBody = detail.json().data;
  assert.equal(detailBody.run.draft.shot_candidates.length, 2);
  assert.equal(detailBody.run.prompt_version, PROMPT_VERSION);
  assert.equal(detailBody.run.current_stage, null);
  assert.equal(detailBody.run.error_message, undefined, "原始运行错误不对导演端暴露");
  assert.deepEqual(
    detailBody.events.map((event: { sequence: number }) => event.sequence),
    detailBody.events.map((_event: unknown, index: number) => index + 1),
    "事件按序号排好,导演端直接照着放",
  );
  assert.deepEqual(
    Object.keys(detailBody.events[0]).sort(),
    ["description", "occurred_at", "reason", "sequence", "status", "tool"],
    "外发形态就是白名单那几个字段",
  );
  assert.ok(
    detailBody.events.some((event: { description: string }) => /已拆出第 1 场「旧仓库」/.test(event.description)),
  );
  assert.ok(detailBody.run.draft.shot_candidates[0].candidate_id);
  assert.equal(detailBody.run.draft.asset_candidates.characters[0].gender, "女");
  assert.equal(detailBody.run.draft.shot_candidates[0].elements.camera_language, "缓慢推近");
  assert.ok(Array.isArray(detailBody.run.validation.issues));
  assert.match(detailBody.run.validation.issues[0].message, /分镜总时长和目标时长相差较大/);
  assert.doesNotMatch(detailBody.run.validation.issues[0].message, /没成|candidate_id|shot_no/);

  const confirm = await app.inject({ method: "POST", url: `/api/v1/script-breakdowns/${created.run.id}/confirm` });
  assert.equal(confirm.statusCode, 200, confirm.body);
  assert.equal(confirm.json().data.outcome, "confirmed");
  assert.equal(confirm.json().data.shot_count, 2);

  const replay = await app.inject({ method: "POST", url: `/api/v1/script-breakdowns/${created.run.id}/confirm` });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().data.outcome, "already_confirmed");
  assert.equal(repository.confirmCalls.length, 2);
});

test("路由:同一幂等键重放创建返回同一运行,不重复执行", async () => {
  const { app, gateway } = await harness();
  const first = await createVersionAndRun(app);
  const second = await createVersionAndRun(app);
  assert.equal(second.outcome, "existing");
  assert.equal(second.run.id, first.run.id);
  assert.equal(gateway.requests.length + gateway.storyboardRequests.length, 5, "重放不得再次调用模型");
});

test("路由:同集活跃草稿拒绝不同幂等键，返回 lite_run_in_flight", async () => {
  const { app } = await harness();
  await createVersionAndRun(app);
  const versionResponse = await app.inject({
    method: "POST", url: `/api/v1/episodes/${TEST_EPISODE_ID}/script-versions`, headers: ACTOR_HEADERS,
    payload: { title: "第一集修订", script_text: `${TEST_SCRIPT_TEXT}\n修订`, client_idempotency_key: "route-active-version-2" },
  });
  assert.equal(versionResponse.statusCode, 200);
  const conflict = await app.inject({
    method: "POST", url: `/api/v1/episodes/${TEST_EPISODE_ID}/script-breakdowns`, headers: ACTOR_HEADERS,
    payload: { script_version_id: versionResponse.json().data.version.id, client_idempotency_key: "route-active-run-2" },
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.deepEqual(conflict.json().error, {
    code: "lite_run_in_flight", message: "这一集正在解析中，请稍候", retryable: false, details: null,
  });
});

test("路由:放弃后不能再确认", async () => {
  const { app } = await harness();
  const created = await createVersionAndRun(app);
  const discard = await app.inject({ method: "POST", url: `/api/v1/script-breakdowns/${created.run.id}/discard` });
  assert.equal(discard.statusCode, 200);
  assert.equal(discard.json().data.run.status, "discarded");

  const confirm = await app.inject({ method: "POST", url: `/api/v1/script-breakdowns/${created.run.id}/confirm` });
  assert.equal(confirm.statusCode, 409);
});

test("路由:列表与详情按集过滤,鉴权缺失 → 401,越权 → 403,缺参数 → 400", async () => {
  const { app } = await harness();
  await createVersionAndRun(app);
  const list = await app.inject({ method: "GET", url: `/api/v1/episodes/${TEST_EPISODE_ID}/script-breakdowns` });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().data.count, 1);

  const versions = await app.inject({ method: "GET", url: `/api/v1/episodes/${TEST_EPISODE_ID}/script-versions` });
  assert.equal(versions.statusCode, 200, versions.body);
  const versionsBody = versions.json().data;
  assert.equal(versionsBody.count, 1);
  assert.equal(versionsBody.items[0].script_text, TEST_SCRIPT_TEXT, "列表应原样回读入库的剧本正文");

  const anonymous = await harness({ authenticated: false });
  const unauthorized = await anonymous.app.inject({ method: "GET", url: `/api/v1/episodes/${TEST_EPISODE_ID}/script-breakdowns` });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.json().error.code, "unauthorized");

  const denied = await harness({ denyCreate: true });
  const forbidden = await denied.app.inject({
    method: "POST",
    url: `/api/v1/episodes/${TEST_EPISODE_ID}/script-versions`,
    headers: ACTOR_HEADERS,
    payload: { script_text: TEST_SCRIPT_TEXT, client_idempotency_key: "denied-1" },
  });
  assert.equal(forbidden.statusCode, 403);

  const badBody = await app.inject({
    method: "POST",
    url: `/api/v1/episodes/${TEST_EPISODE_ID}/script-versions`,
    headers: ACTOR_HEADERS,
    payload: { script_text: "", client_idempotency_key: "short" },
  });
  assert.equal(badBody.statusCode, 400);
  assert.equal(badBody.json().error.code, "invalid_request");
});

test("路由:不存在的运行 → 404 标准信封", async () => {
  const { app } = await harness();
  const response = await app.inject({ method: "GET", url: `/api/v1/script-breakdowns/${RUN_ID}` });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "not_found");
});

test("路由:拆解失败只返回业务文案,不暴露内部字段、行号或厂商报错", async () => {
  const { app } = await harness({
    gatewaySteps: [{ error: new Error("Ark: chat completion failed with status 503") }],
  });
  const created = await createVersionAndRun(app);

  assert.equal(created.run.status, "failed");
  assert.match(created.run.display_reason, /剧本拆解没成/);
  // 给导演看的那句话里不许有厂商名、状态码、英文报错,也不许指向已经不存在的
  // 「失败步骤」——阶段机退场之后界面上没有那个东西了。
  assert.doesNotMatch(created.run.display_reason, /[A-Za-z0-9]/);
  assert.doesNotMatch(created.run.display_reason, /失败步骤/);
  assert.equal(created.run.error_message, undefined, "原始运行错误不对导演端暴露");
  // 内部字段名不许出现在整个信封里。这里只列内部专有名词:状态码那种短数字
  // 串会撞上 UUID 的十六进制,拿它当判据只会做出一条时灵时不灵的用例。
  const serialized = JSON.stringify(created);
  assert.doesNotMatch(serialized, /scene_divisions|start_line_index|content_length|looks_like_markdown/);
  assert.doesNotMatch(serialized, /chat completion|upstream|Ark:/);
});

test("对外文案里不许再让人去打开失败步骤:阶段机退场后界面上没有那个东西", () => {
  const source = readFileSync(
    path.resolve("src/modules/script-breakdown/routes.ts"),
    "utf8",
  );
  // 只看真会送出去的字符串字面量,注释里提这四个字是在解释为什么不能提。
  const literals = source.match(/"[^"\n]*"/g) ?? [];
  assert.deepEqual(
    literals.filter((literal) => literal.includes("失败步骤")),
    [],
    "让人去打开一个不存在的东西,比不说还糟",
  );
});

test("路由:被退回的那一步用人话说清怎么改,不带内部字段名", async () => {
  const turns = happyPathToolTurns();
  const { app } = await harness({
    gatewaySteps: [
      turns[0]!,
      // 模型把第二场接错了行:工作台退回,导演端看到的是一句人话
      {
        toolCalls: [{
          name: "add_scene",
          arguments: { name: "天台", summary: "第二场", start_line_index: 3, end_line_index: 3 },
        }],
      },
      ...turns.slice(1),
    ],
  });
  const created = await createVersionAndRun(app);

  const rejected = created.events.filter((event: { status: string }) => event.status === "rejected");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /这一场要从第 0 行开始/);
  assert.doesNotMatch(rejected[0].description, /[A-Za-z]/);
  assert.doesNotMatch(JSON.stringify(created.events), /start_line_index|scene_divisions/);
});

test("路由:轮询可以只取新事件,不用每次把几十条全量重发", async () => {
  const { app } = await harness();
  const created = await createVersionAndRun(app);
  assert.ok(created.events.length >= 5);

  const incremental = await app.inject({
    method: "GET",
    url: `/api/v1/script-breakdowns/${created.run.id}?since_sequence=${created.events.length - 2}`,
  });
  assert.equal(incremental.statusCode, 200, incremental.body);
  const events = incremental.json().data.events;
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event: { sequence: number }) => event.sequence),
    [created.events.length - 1, created.events.length],
  );
});

test("路由:旧提示词版本拒绝续跑且不动已有事件", async () => {
  const { app, repository, gateway } = await harness({
    gatewaySteps: [{ error: new Error("upstream 503") }],
  });
  const created = await createVersionAndRun(app);
  assert.equal(created.run.status, "failed");
  repository.runs.get(created.run.id)!.promptVersion = "script-breakdown.v1";
  const eventsBefore = structuredClone(await repository.listFillEvents(created.run.id));
  const gatewayCallsBefore = gateway.requests.length;

  const response = await app.inject({
    method: "POST",
    url: `/api/v1/script-breakdowns/${created.run.id}/resume`,
  });

  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "prompt_version_outdated");
  assert.deepEqual(await repository.listFillEvents(created.run.id), eventsBefore);
  assert.equal(gateway.requests.length, gatewayCallsBefore);
});
