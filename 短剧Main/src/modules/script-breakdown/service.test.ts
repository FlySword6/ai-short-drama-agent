import assert from "node:assert/strict";
import { setImmediate as timersSetImmediate } from "node:timers/promises";
import test from "node:test";
import { AppError, ConflictError, ForbiddenError } from "../../shared/errors.js";
import { AiGatewayService } from "../ai/service.js";
import type {
  AiCallRepository,
  AiCompletionProvider,
  AiProviderToolTurn,
  AiToolTurnRequest,
} from "../ai/types.js";
import { ScriptBreakdownService } from "./service.js";
import { PROMPT_VERSION, type ScriptBreakdownDraft } from "./types.js";
import {
  AllowAllAccess,
  FAKE_BREAKDOWN_MODEL,
  happyPathToolTurns,
  InMemoryScriptBreakdownRepository,
  ScriptedToolTurnGateway,
  storyboardCompletionJson,
  TEST_ACTOR,
  TEST_EPISODE_ID,
  TEST_PROJECT_ID,
  TEST_SCRIPT_TEXT,
  type ToolTurnStep,
} from "./test-doubles.js";

const IDEM = "idem-key-0001";
const fixedNow = () => new Date("2026-07-25T08:00:00.000Z");

function setup(steps: ToolTurnStep[]) {
  const repository = new InMemoryScriptBreakdownRepository();
  const gateway = new ScriptedToolTurnGateway(steps);
  const access = new AllowAllAccess();
  const service = new ScriptBreakdownService(repository, gateway, access, { now: fixedNow });
  return { repository, gateway, access, service };
}

async function createVersionAndRun(
  service: ScriptBreakdownService,
  input: { scriptText?: string; targetDurationSec?: number | null; idem?: string } = {},
) {
  const versionResult = await service.createScriptVersion(TEST_ACTOR, TEST_EPISODE_ID, {
    title: "第一集",
    scriptText: input.scriptText ?? TEST_SCRIPT_TEXT,
    clientIdempotencyKey: `${input.idem ?? IDEM}-version`,
  });
  const runResult = await service.createRun(TEST_ACTOR, TEST_EPISODE_ID, {
    scriptVersionId: versionResult.version.id,
    targetDurationSec: input.targetDurationSec ?? null,
    clientIdempotencyKey: `${input.idem ?? IDEM}-run`,
  });
  return { version: versionResult.version, run: runResult.run, runOutcome: runResult.outcome };
}

test("完整执行:阶段①填场次资产,阶段②一次拆镜,正式表写路径一次都没被调用", async () => {
  const { repository, gateway, service } = setup(happyPathToolTurns());
  const { run } = await createVersionAndRun(service);
  await service.executeRun(run.id, TEST_ACTOR.id);

  const fresh = await service.getRun(TEST_ACTOR, run.id);
  assert.equal(fresh.run.status, "draft");
  assert.equal(fresh.run.modelName, FAKE_BREAKDOWN_MODEL);
  assert.equal(fresh.run.promptVersion, PROMPT_VERSION);
  // 草稿区内容齐全,编号与候选 ID 都由服务端分配
  assert.equal(fresh.run.draft.storySummary, "林雪与周行在天台对峙。");
  assert.equal(fresh.run.draft.sceneDivisions?.length, 2);
  assert.equal(fresh.run.draft.assetCandidates?.characters.length, 2);
  assert.equal(fresh.run.draft.assetCandidates?.characters[0]?.gender, "女");
  assert.deepEqual(fresh.run.draft.assetCandidates?.characters[0]?.personalityTags, ["克制", "坚定"]);
  // P6:分镜来自阶段②单次结构化输出(2 个 segment = 2 个分镜),不再由 agent 逐镜填
  assert.equal(fresh.run.draft.shotCandidates?.length, 2);
  assert.deepEqual(
    fresh.run.draft.shotCandidates?.map((shot) => shot.candidateId),
    ["shot_001", "shot_002"],
  );
  // 每镜成文提示词拆镜时渲染落 videoPrompt;skill 全维度落 storyboardDetail
  assert.ok(fresh.run.draft.shotCandidates?.[0]?.videoPrompt?.trim(), "阶段②成文提示词要落 video_prompt");
  assert.ok(fresh.run.draft.shotCandidates?.[0]?.storyboardDetail, "skill 全维度落 storyboard_detail");
  assert.equal(fresh.run.draft.shotCandidates?.[0]?.elements?.cameraLanguage, "缓慢推近");
  // 记账口径:阶段①每轮一条 + 阶段②一条,与网关往返一一对应
  const totalCalls = gateway.requests.length + gateway.storyboardRequests.length;
  assert.equal(fresh.run.usage.callCount, totalCalls);
  assert.equal(fresh.run.usage.totalInputTokens, 120 * totalCalls);
  assert.equal(fresh.run.usage.totalOutputTokens, 60 * totalCalls);
  // 边界:整个执行没有任何正式表写入动作(confirmRun 是唯一正式写路径)
  assert.equal(repository.confirmCalls.length, 0, "草稿执行不得触发正式表写入");
  // 阶段①每一轮都带用途、项目、运行关联与执行围栏——不是只有第一轮带
  assert.ok(gateway.requests.length >= 4);
  for (const request of gateway.requests) {
    assert.equal(request.purpose, "script_breakdown_enrich");
    assert.equal(request.projectId, TEST_PROJECT_ID);
    assert.equal(request.relatedObject?.type, "script_breakdown_run");
    assert.equal(request.relatedObject?.id, fresh.run.id);
    assert.equal(request.executionFence?.type, "script_breakdown_run");
    assert.equal(request.executionFence?.runId, fresh.run.id);
    assert.ok(request.executionFence?.token, "每一轮都要带执行围栏,不能只有第一轮带");
    assert.equal(request.thinking, "disabled", "拆解结构化任务必须关闭深度思考，避免输出失控与超时");
    assert.equal(request.maxTokens, gateway.stageBudget, "预算由网关按用途算出,同一次运行不许漂移");
    assert.ok(request.tools.length > 0, "工具表必须送到网关");
  }
  // 阶段②单次往返带拆镜用途与同一围栏
  assert.equal(gateway.storyboardRequests.length, 1);
  const storyboardRequest = gateway.storyboardRequests[0]!;
  assert.equal(storyboardRequest.purpose, "script_breakdown_storyboard");
  assert.equal(storyboardRequest.projectId, TEST_PROJECT_ID);
  assert.equal(storyboardRequest.executionFence?.runId, fresh.run.id);
  assert.ok(storyboardRequest.system.includes("跨模型统一影视分镜生成约束规范"), "阶段② system 带 skill 全文");
});

test("阶段②网关失败当场按真实原因关账,不把 run 留在 running 等回收器(§2 P6)", async () => {
  const { repository, gateway, service } = setup(happyPathToolTurns());
  // 与真实网关同形:供应商超时被网关收成 AppError 后抛出(publicAiError)。
  gateway.complete = async () => {
    throw new AppError(504, "ai_request_timeout", "AI 处理超时了，这次没有完成，请稍后重试。", true);
  };
  const { run } = await createVersionAndRun(service, { idem: "storyboard-fail-closeout" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const fresh = (await repository.getRun(run.id))!;
  assert.equal(fresh.status, "failed", "异常不许穿出执行器让 run 停在 running");
  assert.equal(fresh.errorCode, "ai_request_timeout", "关账带真实原因,不留给回收器扣 worker_timeout");
  assert.equal(fresh.errorMessage, "AI 处理超时了，这次没有完成，请稍后重试。");
});

test("阶段②长调用期间执行令牌心跳持续 touch,回收器不会误杀(#282)", async () => {
  const repository = new InMemoryScriptBreakdownRepository();
  const gateway = new ScriptedToolTurnGateway(happyPathToolTurns());
  const originalComplete = gateway.complete.bind(gateway);
  const originalUpdate = repository.updateRunExecution.bind(repository);
  let duringStageCall = false;
  let heartbeats = 0;
  repository.updateRunExecution = async (input) => {
    if (duringStageCall) heartbeats += 1;
    return originalUpdate(input);
  };
  // 测的就是 setInterval 对平台时钟的真实行为(无假时钟可用):阶段②调用
  // 等第三次心跳**到达**才放行——门由心跳事件打开,不睡固定时长。
  // 每次让出用 timers/promises 的 setImmediate:它带引用,能撑住事件循环
  // 等生产那个 unref() 的心跳到期(纯 Promise 链到不了定时器相位)。
  gateway.complete = async (input) => {
    duringStageCall = true;
    let yields = 0;
    while (heartbeats < 3) {
      yields += 1;
      assert.ok(yields <= 20_000, "心跳等不到:三次心跳应在有限让出内到达");
      await timersSetImmediate();
    }
    duringStageCall = false;
    return originalComplete(input);
  };
  const service = new ScriptBreakdownService(repository, gateway, new AllowAllAccess(), {
    now: fixedNow,
    stageHeartbeatIntervalMs: 5,
  });
  const { run } = await createVersionAndRun(service, { idem: "storyboard-heartbeat" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const fresh = (await repository.getRun(run.id))!;
  assert.equal(fresh.status, "draft", "阶段②照常完成,心跳不干扰主执行");
  assert.ok(heartbeats >= 3, `心跳要在长调用期间持续 tick(实际 ${heartbeats} 次)`);
});

test("自动确认(一键生成本集默认采用):草稿定稿后续调 confirmRun,run 直接落 confirmed(§2 P2)", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  const { run } = await createVersionAndRun(service, { idem: "auto-confirm" });
  await service.executeRun(run.id, TEST_ACTOR.id, { autoConfirm: true });

  const fresh = await service.getRun(TEST_ACTOR, run.id);
  assert.equal(fresh.run.status, "confirmed", "autoConfirm 在草稿定稿后确认,无人工采用步骤");
  assert.equal(repository.confirmCalls.length, 1, "自动确认仍走 confirmRun 唯一正式写路径");
});

test("状态机:未完成不能确认,确认后不能放弃,放弃后不能确认", async () => {
  const { service } = setup(happyPathToolTurns());
  const { run } = await createVersionAndRun(service);

  await assert.rejects(
    service.confirmRun(TEST_ACTOR, run.id),
    (error: unknown) => error instanceof ConflictError && error.code === "run_not_confirmable",
  );

  await service.executeRun(run.id, TEST_ACTOR.id);
  const confirmed = await service.confirmRun(TEST_ACTOR, run.id);
  assert.equal(confirmed.outcome, "confirmed");
  assert.equal(confirmed.sceneCount, 2);
  assert.equal(confirmed.shotCount, 2);

  await assert.rejects(
    service.discardRun(TEST_ACTOR, run.id),
    (error: unknown) => error instanceof ConflictError && error.code === "run_not_discardable",
  );
});

test("确认幂等:重复确认返回同一结果,不重复建行", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  const { run } = await createVersionAndRun(service);
  await service.executeRun(run.id, TEST_ACTOR.id);

  const first = await service.confirmRun(TEST_ACTOR, run.id);
  const second = await service.confirmRun(TEST_ACTOR, run.id);
  assert.equal(first.outcome, "confirmed");
  assert.equal(second.outcome, "already_confirmed");
  assert.equal(second.sceneCount, first.sceneCount);
  assert.equal(second.shotCount, first.shotCount);
  // 第二次确认走的是已确认短路,没有携带映射建行
  assert.equal(repository.confirmCalls.length, 2);
  assert.equal(repository.confirmCalls[1]?.mapping.scenes.length, 0);
});

test("创建幂等:同一幂等键重放返回同一运行,不产生新运行", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  const first = await createVersionAndRun(service);
  const second = await createVersionAndRun(service);
  assert.equal(second.runOutcome, "existing");
  assert.equal(second.run.id, first.run.id);
  assert.equal(repository.runs.size, 1);
  assert.equal(repository.versions.size, 1);
});

test("同一幂等键提交不同内容 → 409 idempotency_conflict", async () => {
  const { service } = setup(happyPathToolTurns());
  await createVersionAndRun(service);
  await assert.rejects(
    service.createScriptVersion(TEST_ACTOR, TEST_EPISODE_ID, {
      title: null,
      scriptText: "完全不同的剧本。",
      clientIdempotencyKey: `${IDEM}-version`,
    }),
    (error: unknown) => error instanceof ConflictError && error.code === "idempotency_conflict",
  );
});

test("活跃运行守卫:同集 queued/running/draft 拒绝不同幂等键，failed 与终态可重建", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  const first = await createVersionAndRun(service, { idem: "active-run-first" });
  const nextVersion = await service.createScriptVersion(TEST_ACTOR, TEST_EPISODE_ID, {
    title: "第一集修订", scriptText: `${TEST_SCRIPT_TEXT}\n修订`, clientIdempotencyKey: "active-run-next-version",
  });
  for (const status of ["queued", "running", "draft"] as const) {
    repository.runs.get(first.run.id)!.status = status;
    await assert.rejects(
      service.createRun(TEST_ACTOR, TEST_EPISODE_ID, {
        scriptVersionId: nextVersion.version.id, targetDurationSec: null, clientIdempotencyKey: `active-run-${status}`,
      }),
      (error: unknown) => error instanceof ConflictError && error.code === "lite_run_in_flight" && error.message === "这一集正在解析中，请稍候",
    );
  }
  for (const status of ["failed", "confirmed", "discarded", "superseded"] as const) {
    repository.runs.get(first.run.id)!.status = status;
    const result = await service.createRun(TEST_ACTOR, TEST_EPISODE_ID, {
      scriptVersionId: nextVersion.version.id, targetDurationSec: null, clientIdempotencyKey: `active-run-${status}`,
    });
    assert.equal(result.outcome, "created", `${status} 不是活跃运行，应允许显式重建`);
    repository.runs.delete(result.run.id);
  }
});

test("failed 续跑:同集有新活跃 run 时返回 lite_run_in_flight，活跃 run 终态后仍可重试", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  const failed = await createVersionAndRun(service, { idem: "resume-conflict-failed" });
  repository.runs.get(failed.run.id)!.status = "failed";
  const nextVersion = await service.createScriptVersion(TEST_ACTOR, TEST_EPISODE_ID, {
    title: "第一集再修订",
    scriptText: `${TEST_SCRIPT_TEXT}\n再次修订`,
    clientIdempotencyKey: "resume-conflict-next-version",
  });
  const active = await service.createRun(TEST_ACTOR, TEST_EPISODE_ID, {
    scriptVersionId: nextVersion.version.id,
    targetDurationSec: null,
    clientIdempotencyKey: "resume-conflict-active",
  });

  await assert.rejects(
    service.resumeRun(TEST_ACTOR, failed.run.id),
    (error: unknown) => error instanceof ConflictError
      && error.code === "lite_run_in_flight"
      && error.message === "这一集正在解析中，请稍候",
  );

  repository.runs.get(active.run.id)!.status = "discarded";
  const resumed = await service.resumeRun(TEST_ACTOR, failed.run.id);
  assert.equal(resumed.status, "queued");
  assert.equal(resumed.errorCode, null);
});

test("活跃运行守卫:不同 episode 可并行创建", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  const secondEpisodeId = "44444444-4444-4444-8444-444444444444";
  repository.episodes.set(secondEpisodeId, {
    id: secondEpisodeId, projectId: TEST_PROJECT_ID, status: "active", deletedAt: null,
  });
  const [firstVersion, secondVersion] = await Promise.all([
    service.createScriptVersion(TEST_ACTOR, TEST_EPISODE_ID, {
      title: "第一集", scriptText: TEST_SCRIPT_TEXT, clientIdempotencyKey: "parallel-episode-version-1",
    }),
    service.createScriptVersion(TEST_ACTOR, secondEpisodeId, {
      title: "第二集", scriptText: TEST_SCRIPT_TEXT, clientIdempotencyKey: "parallel-episode-version-2",
    }),
  ]);
  const results = await Promise.all([
    service.createRun(TEST_ACTOR, TEST_EPISODE_ID, {
      scriptVersionId: firstVersion.version.id, targetDurationSec: null, clientIdempotencyKey: "parallel-episode-run-1",
    }),
    service.createRun(TEST_ACTOR, secondEpisodeId, {
      scriptVersionId: secondVersion.version.id, targetDurationSec: null, clientIdempotencyKey: "parallel-episode-run-2",
    }),
  ]);
  assert.deepEqual(results.map((result) => result.outcome), ["created", "created"]);
});

test("权限:非项目创作成员不能创建运行", async () => {
  const repository = new InMemoryScriptBreakdownRepository();
  const gateway = new ScriptedToolTurnGateway(happyPathToolTurns());
  const access = new AllowAllAccess((action) => action === "create" ? new ForbiddenError() : null);
  const service = new ScriptBreakdownService(repository, gateway, access, { now: fixedNow });
  await assert.rejects(
    service.createScriptVersion(TEST_ACTOR, TEST_EPISODE_ID, {
      title: null,
      scriptText: TEST_SCRIPT_TEXT,
      clientIdempotencyKey: "idem-key-deny",
    }),
    (error: unknown) => error instanceof ForbiddenError,
  );
  assert.equal(repository.versions.size, 0);
});

/**
 * 断点续跑。旧路的检查点是「阶段」,agent 路没有阶段了——替代依据是草稿
 * 本身,粒度从「每个阶段」细到「每次成功填充」。所以这里要证明的不只是
 * 「能接着跑」,还有「中途挂掉时数据库里真的留下了填到哪」。
 */
test("断点续跑:中途一次往返挂掉,已经填进去的内容从数据库读得回来", async () => {
  const turns = happyPathToolTurns();
  const { repository, service } = setup([
    ...turns.slice(0, 3),
    { error: new AppError(502, "provider_error", "provider boom", true) },
  ]);
  const { run } = await createVersionAndRun(service, { idem: "resume-checkpoint" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  // 从数据库读回来的,不是从内存里传下来的
  const failed = (await repository.getRun(run.id))!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "provider_error");
  assert.equal(failed.draft.storySummary, "林雪与周行在天台对峙。");
  assert.equal(failed.draft.sceneDivisions?.length, 2, "挂掉之前填好的两场必须已经落库");
  assert.equal(failed.draft.assetCandidates?.characters.length, 2);
  assert.equal(failed.draft.shotCandidates, undefined, "还没拆到镜头");
  assert.equal(failed.usage.callCount, 3, "已经发生的三次付费往返要计进账");
});

test("断点续跑:接着填后面的,已经填好的不重做——连模型重发都被挡住", async () => {
  const turns = happyPathToolTurns();
  const { repository, service } = setup([
    ...turns.slice(0, 3),
    { error: new AppError(502, "provider_error", "provider boom", true) },
  ]);
  const { run } = await createVersionAndRun(service, { idem: "resume-no-redo" });
  await service.executeRun(run.id, TEST_ACTOR.id);
  const draftBefore = structuredClone((await repository.getRun(run.id))!.draft);

  // 续跑时模型手上没有「刚才发到哪」,把梗概、场次、角色又发了一遍,
  // 然后才接着拆镜头。已经填好的都必须被挡回去,不能变成第二份。
  const resumedGateway = new ScriptedToolTurnGateway([
    turns[0]!,
    turns[1]!,
    turns[2]!,
    turns[3]!,
    turns[4]!,
  ]);
  const resumed = new ScriptBreakdownService(repository, resumedGateway, new AllowAllAccess(), { now: fixedNow });
  await resumed.resumeRun(TEST_ACTOR, run.id);
  await resumed.executeRun(run.id, TEST_ACTOR.id);

  const after = (await repository.getRun(run.id))!;
  assert.equal(after.status, "draft");
  assert.equal(after.draft.sceneDivisions?.length, 2, "场次不许被重做成四场");
  assert.equal(after.draft.assetCandidates?.characters.length, 2, "角色不许被重做");
  assert.equal(after.draft.assetCandidates?.scenes.length, 2);
  assert.equal(after.draft.assetCandidates?.props.length, 1);
  assert.equal(after.draft.shotCandidates?.length, 2, "续跑补上的是镜头");
  assert.deepEqual(after.draft.sceneDivisions, draftBefore.sceneDivisions);
  // 用量跨两次执行累计,不是清零重算
  assert.ok(after.usage.callCount > 3, "续跑的往返要接着记账");
  // 续跑时喂给模型的提示里要说清「接着上次继续」
  assert.match(
    resumedGateway.requests[0]?.messages[0]?.content ?? "",
    /接着上次继续/,
  );
});

test("断点续跑:事件流跨两次执行只有一条,序号连续不从头再来", async () => {
  const turns = happyPathToolTurns();
  const { repository, service } = setup([
    ...turns.slice(0, 3),
    { error: new AppError(502, "provider_error", "provider boom", true) },
  ]);
  const { run } = await createVersionAndRun(service, { idem: "resume-events" });
  await service.executeRun(run.id, TEST_ACTOR.id);
  const firstPass = await repository.listFillEvents(run.id);
  assert.equal(firstPass.length, 10, "梗概 1 + 场 2 + 资产 7");

  const resumed = new ScriptBreakdownService(
    repository,
    new ScriptedToolTurnGateway(turns.slice(3)),
    new AllowAllAccess(),
    { now: fixedNow },
  );
  await resumed.resumeRun(TEST_ACTOR, run.id);
  await resumed.executeRun(run.id, TEST_ACTOR.id);

  const all = await repository.listFillEvents(run.id);
  assert.ok(all.length > firstPass.length, "续跑产生的事件要接在后面");
  assert.deepEqual(all.map((event) => event.sequence), all.map((_event, index) => index + 1));
  assert.deepEqual(all.slice(0, firstPass.length).map((e) => e.description), firstPass.map((e) => e.description));
});

/**
 * 过程事件落库与白名单。
 *
 * 白名单不是洁癖:出口对面是数据库和导演端,而模型侧能拿到的东西里有两类
 * 绝不能过去——一次拆解会产生 600 多条带真实推理内容的思考事件,以及
 * 「入参没读全」时那段可能夹着剧本原文的报文片段。
 */
const THINKING_MARKER = "我先在心里过一遍:这一场应该这么拆……";
const SCRIPT_LEAK_MARKER = "林雪:我不会再等。";

function noisyToolTurns(): ToolTurnStep[] {
  return happyPathToolTurns().map((step, index) => ({
    ...step,
    // 每一轮都带一段模型自述。它是模型说的话,不是填充动作,不该进事件流。
    text: `${THINKING_MARKER}(第 ${index + 1} 轮)`,
  }));
}
test("过程事件落库:三种状态都留下人话,导演端读得到一条能排序的流", async () => {
  const turns = happyPathToolTurns();
  const { service } = setup([
    turns[0]!,
    turns[1]!,
    // 一轮里既有读不出的,也有会被工作台退回的(场景接不上)
    {
      toolCalls: [{ name: "add_scene", arguments: { name: "空场", summary: "x", start_line_index: 9, end_line_index: 9 } }],
      unreadable: [{ name: "add_character", argumentsExcerpt: SCRIPT_LEAK_MARKER }],
    },
    turns[2]!,
    turns[3]!,
  ]);
  const { run } = await createVersionAndRun(service, { idem: "fill-events" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const detail = await service.getRun(TEST_ACTOR, run.id);
  const statuses = new Set(detail.events.map((event) => event.status));
  assert.deepEqual([...statuses].sort(), ["accepted", "rejected", "unreadable"]);
  assert.deepEqual(detail.events.map((e) => e.sequence), detail.events.map((_e, i) => i + 1));
  for (const event of detail.events) {
    assert.ok(event.description.trim().length > 0, "每条事件都要有能给用户看的话");
    assert.doesNotMatch(event.description, /[A-Za-z]/, "对外说人话:不留英文报错与内部字段名");
  }
  assert.ok(
    detail.events.some((event) => /已拆出第 1 场「旧仓库」/.test(event.description)),
    "「剧本被慢慢拆开」这件事要有数据支撑",
  );
  // 事件行不许混进阶段列表:混进去导演端每轮询一次就多出几十个「步骤」
  assert.equal(detail.stages.length, 0);
});

test("事件白名单:只有约定的那几个字段能出这道门", async () => {
  const { repository, service } = setup(noisyToolTurns());
  const { run } = await createVersionAndRun(service, { idem: "event-whitelist" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const events = await repository.listFillEvents(run.id);
  assert.ok(events.length > 0);
  for (const event of events) {
    assert.deepEqual(
      Object.keys(event).sort(),
      ["description", "occurredAt", "reason", "sequence", "status", "tool"],
      "出库形态是白名单:多一个字段就得先改投影函数,顺带被 review 看见",
    );
  }
});

test("事件白名单:模型的自述与读不出的报文片段都不落库、不外发", async () => {
  const noisy = noisyToolTurns();
  const { repository, service } = setup([
    noisy[0]!,
    noisy[1]!,
    { text: THINKING_MARKER, unreadable: [{ name: "add_character", argumentsExcerpt: SCRIPT_LEAK_MARKER }] },
    noisy[2]!,
    noisy[3]!,
    noisy[4]!,
  ]);
  const { run } = await createVersionAndRun(service, { idem: "event-no-thinking" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const detail = await service.getRun(TEST_ACTOR, run.id);
  const serialized = JSON.stringify(detail.events);
  assert.ok(!serialized.includes(THINKING_MARKER), "模型的自述不是填充动作,不该出现在事件流里");
  assert.ok(!serialized.includes(SCRIPT_LEAK_MARKER), "读不出的报文片段可能夹着剧本原文,绝不能落库");
  // 事件条数等于「真的发生过的填充动作」,不随模型说了多少话增长
  const toolShaped = detail.events.filter((event) => event.status !== "unreadable").length;
  const unreadable = detail.events.filter((event) => event.status === "unreadable").length;
  assert.equal(detail.events.length, toolShaped + unreadable);
  assert.equal(unreadable, 1);

  // 落库的原始 JSON 里同样没有
  const raw = JSON.stringify(repository.stagesByRun.get(run.id));
  assert.ok(!raw.includes(THINKING_MARKER));
  assert.ok(!raw.includes(SCRIPT_LEAK_MARKER));
});

/** 失败关账、闸门与围栏:不管走哪条路,这几件都必须照做。 */

test("中途失败先关账再收摊:已经产生的用量算进去,不是丢掉", async () => {
  const turns = happyPathToolTurns();
  const { repository, service } = setup([
    ...turns.slice(0, 2),
    { error: new AppError(502, "provider_error", "provider boom", true) },
  ]);
  const { run } = await createVersionAndRun(service, { idem: "fail-closeout" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const fresh = (await repository.getRun(run.id))!;
  assert.equal(fresh.status, "failed");
  assert.equal(fresh.errorCode, "provider_error");
  assert.equal(fresh.usage.callCount, 2, "失败之前的两次付费往返不能丢");
  assert.equal(fresh.usage.totalInputTokens, 240);
  assert.equal(repository.confirmCalls.length, 0);
});

test("执行途中被外部放弃:立刻停手,不再发付费往返,也不覆盖放弃状态", async () => {
  const turns = happyPathToolTurns();
  const repository = new InMemoryScriptBreakdownRepository();
  const gateway = new ScriptedToolTurnGateway(turns);
  const service = new ScriptBreakdownService(repository, gateway, new AllowAllAccess(), { now: fixedNow });
  const { run } = await createVersionAndRun(service, { idem: "discard-midrun" });

  const originalRunToolTurn = gateway.runToolTurn.bind(gateway);
  let calls = 0;
  gateway.runToolTurn = async (input) => {
    calls += 1;
    const result = await originalRunToolTurn(input);
    // 第二轮之后导演在界面上点了放弃
    if (calls === 2) await repository.discardRun({ runId: run.id, actorId: TEST_ACTOR.id, now: fixedNow() });
    return result;
  };

  await service.executeRun(run.id, TEST_ACTOR.id);

  const fresh = (await repository.getRun(run.id))!;
  assert.equal(fresh.status, "discarded", "放弃状态不许被执行器覆盖成 failed");
  assert.equal(fresh.errorCode, null);
  assert.equal(calls, 2, "放弃之后不许再发付费往返");
});

test("轮次预算用完:如实记成预算用完,已经填好的留着可以续跑", async () => {
  const turns = happyPathToolTurns();
  const { repository, service } = setup(turns.slice(0, 2));
  const { run } = await createVersionAndRun(service, { idem: "turn-budget" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const fresh = (await repository.getRun(run.id))!;
  assert.equal(fresh.status, "failed");
  // 一次拆解最多花多少钱是有确定上界的,不靠模型自己不说话来停
  assert.ok(fresh.usage.callCount <= 60, `往返次数必须有硬上限,实际 ${fresh.usage.callCount}`);
  assert.equal(fresh.draft.sceneDivisions?.length, 2, "已经填好的留着,续跑接着来");
});

test("旧提示词版本不能拿新规则静默续跑", async () => {
  const { repository, gateway, service } = setup(happyPathToolTurns());
  const { run } = await createVersionAndRun(service, { idem: "prompt-version" });
  repository.runs.get(run.id)!.promptVersion = "script-breakdown.v1";

  await service.executeRun(run.id, TEST_ACTOR.id);

  const fresh = (await repository.getRun(run.id))!;
  assert.equal(fresh.status, "failed");
  assert.equal(fresh.errorCode, "prompt_version_outdated");
  assert.equal(gateway.requests.length, 0, "版本不一致时不得调用模型");
});

test("旧提示词版本的草稿不能绕过 v2 四栏直接确认", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  const { run } = await createVersionAndRun(service, { idem: "prompt-version-confirm" });
  await service.executeRun(run.id, TEST_ACTOR.id);
  repository.runs.get(run.id)!.promptVersion = "script-breakdown.v1";

  await assert.rejects(
    service.confirmRun(TEST_ACTOR, run.id),
    (error: unknown) => (error as { code?: string }).code === "prompt_version_outdated",
  );
  assert.equal(repository.confirmCalls.length, 0, "旧草稿不得写入缺少 breakdown_elements 的正式分镜");
});

test("旧提示词版本拒绝续跑,且拒绝前不动已有事件", async () => {
  const { repository, service } = setup([
    { error: new AppError(502, "provider_error", "provider boom", true) },
  ]);
  const { run } = await createVersionAndRun(service, { idem: "old-resume" });
  await service.executeRun(run.id, TEST_ACTOR.id);
  repository.runs.get(run.id)!.promptVersion = "script-breakdown.v1";
  const before = structuredClone(await repository.listFillEvents(run.id));

  await assert.rejects(
    service.resumeRun(TEST_ACTOR, run.id),
    (error: unknown) => error instanceof ConflictError && error.code === "prompt_version_outdated",
  );

  assert.deepEqual(await repository.listFillEvents(run.id), before);
});

test("剧集在执行前已不可用:如实关账,不抛异常了事,也不调用模型", async () => {
  const { repository, gateway, service } = setup(happyPathToolTurns());
  const { run } = await createVersionAndRun(service, { idem: "episode-gone" });
  repository.episodes.get(TEST_EPISODE_ID)!.status = "archived";

  await service.executeRun(run.id, TEST_ACTOR.id);

  const fresh = (await repository.getRun(run.id))!;
  assert.equal(fresh.status, "failed");
  assert.equal(fresh.errorCode, "episode_unavailable");
  assert.equal(gateway.requests.length, 0);
});

/** 资产归属与最终校验:agent 手上只有限量摘要,判归属必须用未截断清单。 */

test("确认会把候选转为项目资产,并把候选与已有资产一起绑定到分镜", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  repository.approvedAssets = [{ assetEntityId: "asset-1", name: "天台", assetKind: "scene" }];
  const { run } = await createVersionAndRun(service, { idem: "materialize-assets" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const confirmed = await service.confirmRun(TEST_ACTOR, run.id);
  assert.equal(confirmed.outcome, "confirmed");
  const mapping = repository.confirmCalls[0]!.mapping;
  const shot = mapping.shots.find((item) => item.candidateId === "shot_002")!;
  assert.deepEqual(
    new Set(shot.referenceAssetSnapshots.map((snapshot) => snapshot.name)),
    new Set(["林雪", "周行", "天台"]),
  );
  assert.equal(
    repository.approvedAssets.filter((asset) => asset.assetKind === "character" && asset.name === "林雪").length,
    1,
    "同名角色候选只能转成一条正式资产",
  );
});

test("确认把服装/音频候选一并转为正式项目资产(v8)", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  const { run } = await createVersionAndRun(service, { idem: "materialize-costume-audio" });
  await service.executeRun(run.id, TEST_ACTOR.id);
  await service.confirmRun(TEST_ACTOR, run.id);

  const materialized = new Set(repository.approvedAssets.map((asset) => `${asset.assetKind}:${asset.name}`));
  assert.ok(materialized.has("costume:风衣"), "服装候选确认时转正式资产");
  assert.ok(materialized.has("audio:雨声"), "音频候选确认时转正式资产");
});

test("阶段②缺成文提示词:校验失败如实关账,不落草稿(v8)", async () => {
  const repository = new InMemoryScriptBreakdownRepository();
  const gateway = new ScriptedToolTurnGateway(happyPathToolTurns());
  const noPrompt = JSON.parse(storyboardCompletionJson()) as { segments: Array<Record<string, unknown>> };
  for (const segment of noPrompt.segments) delete segment.video_prompt;
  gateway.complete = async () => ({
    content: JSON.stringify(noPrompt),
    model: FAKE_BREAKDOWN_MODEL,
    inputTokens: 120,
    outputTokens: 60,
    durationMs: 7,
  });
  const service = new ScriptBreakdownService(repository, gateway, new AllowAllAccess(), { now: fixedNow });
  const { run } = await createVersionAndRun(service, { idem: "missing-video-prompt" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const fresh = (await repository.getRun(run.id))!;
  assert.equal(fresh.status, "failed");
  assert.equal(fresh.errorCode, "storyboard_validation_failed");
});

test("阶段②配置每段 Shot 数 N:system schema 要求恰好 N,输出数量不符判 validation_failed(v11)", async () => {
  const repository = new InMemoryScriptBreakdownRepository();
  const gateway = new ScriptedToolTurnGateway(happyPathToolTurns());
  repository.storyboardVideoConfig.shotsPerSegment = 3;
  const service = new ScriptBreakdownService(repository, gateway, new AllowAllAccess(), { now: fixedNow });
  const { run } = await createVersionAndRun(service, { idem: "shots-per-segment-mismatch" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  // 配置 3 时 schema 文本要求「恰好 3 个」。
  const storyboardRequest = gateway.storyboardRequests[0]!;
  assert.ok(storyboardRequest.system.includes("恰好 3 个"), "配置 N 时 schema 要求每段恰好 N 个 Shot");

  // storyboardCompletionJson 每段固定 5 个 Shot → 校验拦截如实关账。
  const fresh = (await repository.getRun(run.id))!;
  assert.equal(fresh.status, "failed");
  assert.equal(fresh.errorCode, "storyboard_validation_failed");
  assert.ok((fresh.errorMessage ?? "").includes("应含 3 个 Shot"), `报错要指名数量不符,实际=${fresh.errorMessage}`);
});

test("阶段②配置每段 Shot 数 N:输出恰好 N 个时通过并落全量(v11)", async () => {
  const repository = new InMemoryScriptBreakdownRepository();
  const gateway = new ScriptedToolTurnGateway(happyPathToolTurns());
  repository.storyboardVideoConfig.shotsPerSegment = 3;
  const trimmed = JSON.parse(storyboardCompletionJson()) as { segments: Array<{ shots: unknown[] }> };
  for (const segment of trimmed.segments) segment.shots = segment.shots.slice(0, 3);
  gateway.complete = async () => ({
    content: JSON.stringify(trimmed),
    model: FAKE_BREAKDOWN_MODEL,
    inputTokens: 120,
    outputTokens: 60,
    durationMs: 7,
  });
  const service = new ScriptBreakdownService(repository, gateway, new AllowAllAccess(), { now: fixedNow });
  const { run } = await createVersionAndRun(service, { idem: "shots-per-segment-match" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const fresh = (await repository.getRun(run.id))!;
  assert.equal(fresh.status, "draft", "恰好 N 个 Shot 时应通过校验");
  assert.equal(fresh.draft.shotCandidates?.length, 2);
  for (const shot of fresh.draft.shotCandidates ?? []) {
    assert.equal(shot.storyboardDetail?.shots?.length, 3, "storyboardDetail 落全量 shots");
  }
});

test("阶段②取到视频配置时打印日志:视频风格与生效视频模板全文可查", async () => {
  const repository = new InMemoryScriptBreakdownRepository();
  const gateway = new ScriptedToolTurnGateway(happyPathToolTurns());
  repository.storyboardVideoConfig = {
    styleDescription: "都市夜戏、冷色调、手持运镜",
    promptTemplate: "9:16 竖屏，主体特写，短句节奏，禁用闪白",
    shotsPerSegment: 3,
  };
  const infoLogs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const logger = {
    info(obj: Record<string, unknown>, msg: string) {
      infoLogs.push({ obj, msg });
    },
  };
  const service = new ScriptBreakdownService(repository, gateway, new AllowAllAccess(), { now: fixedNow, logger });
  const { run } = await createVersionAndRun(service, { idem: "storyboard-video-config-log" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const configLog = infoLogs.find((entry) => entry.msg.includes("阶段②视频配置"));
  assert.ok(configLog, "阶段②取到配置后要打结构化日志");
  assert.equal(configLog!.obj.videoStyleDescription, "都市夜戏、冷色调、手持运镜");
  assert.equal(configLog!.obj.videoPromptTemplate, "9:16 竖屏，主体特写，短句节奏，禁用闪白");
  assert.equal(configLog!.obj.shotsPerSegment, 3);
  assert.equal(configLog!.obj.projectId, TEST_PROJECT_ID);
  assert.equal(configLog!.obj.runId, run.id);
});

test("同一个角色候选在多个镜头里复用同一条正式资产", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  const { run } = await createVersionAndRun(service, { idem: "reuse-character-across-shots" });
  await service.executeRun(run.id, TEST_ACTOR.id);
  await service.confirmRun(TEST_ACTOR, run.id);

  const characterIds = repository.confirmCalls[0]!.mapping.shots
    .map((shot) => shot.referenceAssetSnapshots.find((snapshot) => snapshot.name === "林雪")?.asset_entity_id);
  assert.equal(characterIds.length, 2);
  assert.ok(characterIds[0]);
  assert.deepEqual(characterIds, [characterIds[0], characterIds[0]]);
});

test("确认遇到项目内同类同名多资产时失败关闭，不静默任选", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  repository.approvedAssets = [
    { assetEntityId: "asset-a", name: "林雪", assetKind: "character" },
    { assetEntityId: "asset-b", name: "林雪", assetKind: "character" },
  ];
  const { run } = await createVersionAndRun(service, { idem: "ambiguous-approved-assets" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const detail = await service.getRun(TEST_ACTOR, run.id);
  assert.equal(detail.run.draft.assetCandidates?.characters[0]?.prelinkedAsset, null);
  await assert.rejects(
    service.confirmRun(TEST_ACTOR, run.id),
    (error: unknown) => (error as { code?: string }).code === "script_asset_name_ambiguous",
  );
  assert.equal(repository.confirmCalls.length, 0);
});

test("资产摘要 200 条截断不影响同名角色歧义判断与正式绑定", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  repository.approvedAssets = [
    ...Array.from({ length: 199 }, (_, index) => ({
      assetEntityId: `asset-filler-${String(index).padStart(3, "0")}`,
      name: `A${String(index).padStart(3, "0")}`,
      assetKind: "character",
    })),
    { assetEntityId: "asset-linxue-a", name: "林雪", assetKind: "character" },
    { assetEntityId: "asset-linxue-b", name: "林雪", assetKind: "character" },
  ];
  const { run } = await createVersionAndRun(service, { idem: "asset-limit-boundary" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const detail = await service.getRun(TEST_ACTOR, run.id);
  assert.equal(
    detail.run.draft.assetCandidates?.characters.find((candidate) => candidate.name === "林雪")?.prelinkedAsset,
    null,
    "第二条同名资产位于摘要边界外时仍必须判为歧义",
  );

  await assert.rejects(
    service.confirmRun(TEST_ACTOR, run.id),
    (error: unknown) => (error as { code?: string }).code === "script_asset_name_ambiguous",
  );
  assert.equal(repository.confirmCalls.length, 0);
});

/**
 * 运行级校验是最后一道闸。填充过程中工作台已经拦住了绝大多数不一致,
 * 但**恢复现场时接进来的草稿没有再过一遍工作台**——它可能是上一版路径
 * 写下的、也可能被别的缺陷弄坏了。所以这道闸不是装饰。
 */
test("续跑接进来的草稿本身不一致时:整次运行判失败,不把坏草稿交给人确认", async () => {
  const turns = happyPathToolTurns();
  const { repository, service } = setup([
    { error: new AppError(502, "provider_error", "provider boom", true) },
  ]);
  const { run } = await createVersionAndRun(service, { idem: "bad-restored-draft" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  // 恢复现场时接进来一份草稿,里面有一个镜头挂在不存在的场上。
  // 工作台只对「新填进来的那一格」把关,接进来的旧内容它不会再判一遍。
  const shot = (candidateId: string, shotNo: number, sceneIndex: number, lines: number[]) => ({
    candidateId,
    shotNo,
    sceneIndex,
    lineIndices: lines,
    elements: { subject: "林雪", action: "对峙", visual: null, cameraLanguage: null },
    directorPrompt: null,
    imagePrompt: null,
    videoPrompt: null,
    durationSec: 6,
    characterNames: [],
    sceneNames: [],
    propNames: [],
    costumeNames: [],
  });
  repository.runs.get(run.id)!.draft = {
    storySummary: "旧路留下的草稿",
    sceneDivisions: [
      { sceneIndex: 0, name: "旧仓库", summary: "独白", startLineIndex: 0, endLineIndex: 1 },
      { sceneIndex: 1, name: "天台", summary: "对峙", startLineIndex: 2, endLineIndex: 3 },
    ],
    shotCandidates: [
      shot("shot_001", 1, 0, [0, 1]),
      shot("shot_002", 2, 1, [2, 3]),
      shot("shot_003", 3, 7, [2, 3]),
    ],
  };

  const resumed = new ScriptBreakdownService(
    repository,
    new ScriptedToolTurnGateway([turns[3]!]),
    new AllowAllAccess(),
    { now: fixedNow },
  );
  await resumed.resumeRun(TEST_ACTOR, run.id);
  await resumed.executeRun(run.id, TEST_ACTOR.id);

  const fresh = (await repository.getRun(run.id))!;
  assert.equal(fresh.status, "failed");
  assert.equal(fresh.errorCode, "contract_validation_failed");
  assert.equal(fresh.validation.status, "failed");
  assert.ok(fresh.validation.issues.some((issue) => issue.code === "scene_index_unknown"));
  await assert.rejects(
    service.confirmRun(TEST_ACTOR, run.id),
    (error: unknown) => error instanceof ConflictError && error.code === "run_not_confirmable",
  );
  assert.equal(repository.confirmCalls.length, 0);
});

test("目标时长偏离进警告,不拦住草稿", async () => {
  const { service } = setup(happyPathToolTurns());
  const { run } = await createVersionAndRun(service, { idem: "duration-warning", targetDurationSec: 90 });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const detail = await service.getRun(TEST_ACTOR, run.id);
  assert.equal(detail.run.status, "draft");
  assert.equal(detail.run.validation.status, "pass_with_warnings");
  assert.ok(detail.run.validation.issues.some((issue) => issue.code === "duration_deviation"));
});

/** 接真网关:审计、限额、围栏都在网关那一层,拆解侧不复制这些规则。 */

function toolCallingProvider(script: ToolTurnStep[]): {
  provider: AiCompletionProvider;
  seen: AiToolTurnRequest[];
} {
  const seen: AiToolTurnRequest[] = [];
  let index = 0;
  return {
    seen,
    provider: {
      // P6 阶段②:单次文本往返,返回覆盖全剧本的合法拆镜 JSON
      complete: async (input) => ({
        content: storyboardCompletionJson(),
        model: input.model ?? "configured-model-x",
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 3,
      }),
      completeToolTurn: async (input): Promise<AiProviderToolTurn> => {
        seen.push(input);
        const step = script[index] ?? { text: "没有更多要补的了。" };
        index += 1;
        if (step.error) throw step.error;
        return {
          content: step.text ?? "",
          toolCalls: (step.toolCalls ?? []).map((call, position) => ({
            id: `call-${index}-${position}`,
            name: call.name,
            arguments: call.arguments,
          })),
          unreadableToolCalls: [],
          model: input.model ?? "configured-model-x",
          inputTokens: 10,
          outputTokens: 5,
          durationMs: 3,
        };
      },
    },
  };
}

test("网关关闭时 fail closed:运行失败,错误码如实记录,没有产生审计行", async () => {
  const repository = new InMemoryScriptBreakdownRepository();
  const aiCalls: string[] = [];
  const callRepository: AiCallRepository = {
    reserve: async () => { aiCalls.push("reserve"); return { id: "call-1" }; },
    complete: async () => { aiCalls.push("complete"); },
    fail: async () => { aiCalls.push("fail"); },
  };
  const gateway = new AiGatewayService(callRepository, toolCallingProvider([]).provider, {
    enabled: false,
    apiKeyConfigured: false,
    dailyCallLimit: 100,
    defaultModel: null,
    embeddingModel: null,
  });
  const service = new ScriptBreakdownService(repository, gateway, new AllowAllAccess(), { now: fixedNow });
  const { run } = await createVersionAndRun(service);
  await service.executeRun(run.id, TEST_ACTOR.id);

  const fresh = (await repository.getRun(run.id))!;
  assert.equal(fresh.status, "failed");
  assert.equal(fresh.errorCode, "ai_gateway_disabled");
  assert.equal(aiCalls.length, 0, "网关关闭时不得产生真实调用与审计行");
});

test("经真实 AiGatewayService:每一轮都是一条带围栏的审计行,模型名与用途如实记录", async () => {
  const repository = new InMemoryScriptBreakdownRepository();
  const reservations: Array<{
    purpose: string;
    projectId: string | null;
    requestedModel: string;
    executionToken?: string;
  }> = [];
  const completed: Array<{ model: string }> = [];
  const callRepository: AiCallRepository = {
    reserve: async (input) => {
      reservations.push({
        purpose: input.purpose,
        projectId: input.projectId,
        requestedModel: input.requestedModel,
        executionToken: input.executionFence?.token,
      });
      return { id: `call-${reservations.length}` };
    },
    complete: async (input) => { completed.push({ model: input.model }); },
    fail: async () => { throw new Error("本用例不该有失败调用"); },
  };
  const upstream = toolCallingProvider(happyPathToolTurns());
  const gateway = new AiGatewayService(callRepository, upstream.provider, {
    enabled: true,
    apiKeyConfigured: true,
    dailyCallLimit: 100,
    defaultModel: "configured-model-x",
    embeddingModel: null,
  });
  const service = new ScriptBreakdownService(repository, gateway, new AllowAllAccess(), { now: fixedNow });
  const { run } = await createVersionAndRun(service);
  await service.executeRun(run.id, TEST_ACTOR.id);

  const fresh = (await repository.getRun(run.id))!;
  assert.equal(fresh.status, "draft");
  assert.equal(fresh.modelName, "configured-model-x");
  assert.equal(reservations.length, upstream.seen.length + 1, "阶段①每轮一条 + 阶段②一条审计行");
  assert.equal(completed.length, reservations.length);
  assert.equal(fresh.usage.callCount, reservations.length, "运行记的 callCount 与审计行数同口径");
  const purposes = reservations.map((item) => item.purpose);
  assert.equal(purposes.filter((p) => p === "script_breakdown_storyboard").length, 1, "阶段②恰好一条审计行");
  for (const reservation of reservations) {
    assert.ok(
      reservation.purpose === "script_breakdown_enrich" || reservation.purpose === "script_breakdown_storyboard",
    );
    assert.equal(reservation.requestedModel, "configured-model-x");
    assert.ok(reservation.executionToken, "每一轮预留都要带当前拆解的执行围栏 token");
  }
  assert.equal(new Set(reservations.map((item) => item.executionToken)).size, 1, "同一次执行共用一个围栏 token");
});

test("通道不支持工具调用时如实报出来,不伪装成模型不肯干活", async () => {
  const repository = new InMemoryScriptBreakdownRepository();
  const callRepository: AiCallRepository = {
    reserve: async () => ({ id: "call-1" }),
    complete: async () => {},
    fail: async () => {},
  };
  const gateway = new AiGatewayService(
    callRepository,
    { complete: async () => ({ content: "{}", model: "x", inputTokens: 1, outputTokens: 1, durationMs: 1 }) },
    {
      enabled: true,
      apiKeyConfigured: true,
      dailyCallLimit: 100,
      defaultModel: "model-without-tools",
      embeddingModel: null,
    },
  );
  const service = new ScriptBreakdownService(repository, gateway, new AllowAllAccess(), { now: fixedNow });
  const { run } = await createVersionAndRun(service);
  await service.executeRun(run.id, TEST_ACTOR.id);

  const fresh = (await repository.getRun(run.id))!;
  assert.equal(fresh.status, "failed");
  assert.equal(fresh.errorCode, "ai_tool_calling_unavailable");
});

/**
 * 失联回收与执行代次。旧路用「阶段行」当在跑的证据,agent 路没有阶段了——
 * 证据换成运行行本身(status + executionToken)和事件行,判据一条不少。
 */

test("失联 running 回收后可续跑,已经填好的内容与事件都留着", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  const { run } = await createVersionAndRun(service, { idem: "stale-recovery" });
  const startedAt = new Date("2026-07-25T07:50:00.000Z");
  const executionToken = await repository.claimExecution(run.id, startedAt);
  assert.ok(executionToken);
  await repository.updateRunExecution({
    runId: run.id,
    executionToken,
    currentStage: null,
    draft: { storySummary: "填到一半" },
    now: startedAt,
  });
  await repository.recordFillEvents({
    runId: run.id,
    executionToken,
    events: [{
      sequence: 1,
      tool: "write_story_outline",
      status: "accepted",
      description: "已写好这一集的故事梗概",
      reason: null,
      occurredAt: startedAt,
    }],
    now: startedAt,
  });

  assert.equal(await repository.reclaimStaleRuns({
    cutoff: new Date("2026-07-25T07:55:00.000Z"),
    now: fixedNow(),
  }), 1);
  assert.equal((await repository.getRun(run.id))!.errorCode, "worker_timeout");

  await service.resumeRun(TEST_ACTOR, run.id);
  const resumed = await service.getRun(TEST_ACTOR, run.id);
  assert.equal(resumed.run.status, "queued", "resume 在返回前占住本集活跃位，避免后台静默撞唯一索引");
  assert.equal(resumed.run.draft.storySummary, "填到一半", "回收与续跑都不许抹掉已经填好的");
  assert.equal(resumed.events.length, 1, "回收与续跑都不许抹掉已有事件");
  assert.equal(resumed.run.promptVersion, PROMPT_VERSION, "当前规则的运行必须可继续执行");
});

test("执行代次隔离:旧 worker 晚到不能覆盖恢复后的新执行", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  const { run } = await createVersionAndRun(service, { idem: "execution-fence" });
  const staleAt = new Date("2026-07-25T07:50:00.000Z");
  const oldToken = await repository.claimExecution(run.id, staleAt);
  assert.ok(oldToken);

  assert.equal(await repository.reclaimStaleRuns({
    cutoff: new Date("2026-07-25T07:55:00.000Z"),
    now: fixedNow(),
  }), 1);
  await service.resumeRun(TEST_ACTOR, run.id);
  const newToken = await repository.claimExecution(run.id, fixedNow());
  assert.ok(newToken);
  assert.notEqual(newToken, oldToken);
  assert.equal(
    await repository.resetStagesForResume(run.id, fixedNow()),
    false,
    "过期的并发 resume 不得插进已经被新执行认领的运行",
  );

  // 旧 worker 晚到:草稿、事件、关账三条写路径都必须被围栏挡住
  await repository.updateRunExecution({
    runId: run.id,
    executionToken: oldToken,
    currentStage: null,
    draft: { storySummary: "旧 worker 晚到" },
    now: fixedNow(),
  });
  await repository.recordFillEvents({
    runId: run.id,
    executionToken: oldToken,
    events: [{
      sequence: 1,
      tool: null,
      status: "accepted",
      description: "旧 worker 晚到",
      reason: null,
      occurredAt: fixedNow(),
    }],
    now: fixedNow(),
  });
  await repository.finalizeRunFailed({
    runId: run.id,
    executionToken: oldToken,
    currentStage: null,
    errorCode: "provider_error",
    errorMessage: "旧 worker 晚到",
    now: fixedNow(),
  });

  const fresh = await service.getRun(TEST_ACTOR, run.id);
  assert.equal(fresh.run.status, "running");
  assert.notEqual(fresh.run.errorCode, "provider_error", "旧 worker 的关账不得盖到新代次头上");
  assert.equal(fresh.run.draft.storySummary, undefined);
  assert.deepEqual(fresh.events, []);
});

/**
 * 这一刀升到 v5,原来钉「不升号」的判断作废。
 *
 * 原判断说:新旧两条路产出的草稿同形、同一套编号规则、同一个 mapper、同一套
 * 运行级校验,所以不必升。形状那部分仍然成立,下面两条用例继续守着它——但
 * 它证的是 mapper 与续跑接得上,不是两套规则可以混着跑。
 *
 * 作废的理由有两条:
 * 1. 合同:版本号标定的是「这份草稿按哪一套规则产生」,规则的措辞现在写在
 *    系统提示与工具入参说明里(agent/runner.ts、agent/tools.ts)。这一刀把名字
 *    反翻译规则写了进去,措辞变了就是规则变了,必须升号才审计得出漂移。
 * 2. 混跑真的坏:name 是镜头引用资产、跨集资产匹配唯一按字符串比对的字段。
 *    老规则下登记的译名留在草稿里,新规则续填时同一个人以原文名再登记一次,
 *    查重查不出,同一份草稿里同一个人两张卡。这正是要修的病,不能靠续跑带进来。
 *
 * 代价是清楚的、也是本次要认下的:在途未确认的运行会收到「这次拆解使用的
 * 整理规则已经更新,请重新开始一次拆解」。下面第三条用例把这个代价钉住。
 */
test("上一版阶段机留下的草稿形状:新路上照样确认得了", async () => {
  const { repository, service } = setup(happyPathToolTurns());
  const { run } = await createVersionAndRun(service, { idem: "legacy-draft-confirm" });
  const record = repository.runs.get(run.id)!;
  record.status = "draft";
  record.draft = {
    storySummary: "上一版拆的",
    sceneDivisions: [
      { sceneIndex: 0, name: "旧仓库", summary: "独白", startLineIndex: 0, endLineIndex: 1 },
      { sceneIndex: 1, name: "天台", summary: "对峙", startLineIndex: 2, endLineIndex: 3 },
    ],
    assetCandidates: {
      characters: [{
        candidateId: "char_001",
        name: "林雪",
        description: null,
        gender: null,
        ageValue: null,
        ageStage: null,
        appearance: null,
        personalityTags: [],
        prelinkedAsset: null,
      }],
      scenes: [],
      props: [],
      costumes: [],
      audios: [],
    },
    shotCandidates: [0, 1].map((sceneIndex) => ({
      candidateId: `shot_00${sceneIndex + 1}`,
      shotNo: sceneIndex + 1,
      sceneIndex,
      lineIndices: sceneIndex === 0 ? [0, 1] : [2, 3],
      elements: { subject: "林雪", action: "对峙", visual: null, cameraLanguage: null },
      directorPrompt: null,
      imagePrompt: null,
      videoPrompt: null,
      durationSec: 6,
      characterNames: ["林雪"],
      sceneNames: [],
      propNames: [],
      costumeNames: [],
    })),
  };

  const confirmed = await service.confirmRun(TEST_ACTOR, run.id);
  assert.equal(confirmed.outcome, "confirmed");
  assert.equal(confirmed.sceneCount, 2);
  assert.equal(confirmed.shotCount, 2);
});

test("上一版阶段机留下的草稿形状:新路上接着续跑,已经填好的不重做", async () => {
  const turns = happyPathToolTurns();
  const { repository, service } = setup([
    { error: new AppError(502, "provider_error", "provider boom", true) },
  ]);
  const { run } = await createVersionAndRun(service, { idem: "legacy-draft-resume" });
  await service.executeRun(run.id, TEST_ACTOR.id);
  // 上一版只拆完了梗概和场次就失败了
  repository.runs.get(run.id)!.draft = {
    storySummary: "上一版拆的",
    sceneDivisions: [
      { sceneIndex: 0, name: "旧仓库", summary: "独白", startLineIndex: 0, endLineIndex: 1 },
      { sceneIndex: 1, name: "天台", summary: "对峙", startLineIndex: 2, endLineIndex: 3 },
    ],
  };

  const resumed = new ScriptBreakdownService(
    repository,
    new ScriptedToolTurnGateway(turns.slice(2)),
    new AllowAllAccess(),
    { now: fixedNow },
  );
  await resumed.resumeRun(TEST_ACTOR, run.id);
  await resumed.executeRun(run.id, TEST_ACTOR.id);

  const after = (await repository.getRun(run.id))!;
  assert.equal(after.status, "draft");
  assert.equal(after.draft.storySummary, "上一版拆的", "上一版写的梗概保留");
  assert.equal(after.draft.sceneDivisions?.length, 2, "上一版拆的场次不重做");
  assert.equal(after.draft.shotCandidates?.length, 2, "新路补上镜头");
  assert.equal((await service.confirmRun(TEST_ACTOR, run.id)).outcome, "confirmed");
});

/**
 * 升号的代价,原样钉住:v2 那套规则跑出来的运行,到这一版一律重开。
 *
 * 这不是 v1 那条通用闸的重复——v1 早就没人在跑了,v2 是这条分支自己上一刻还在
 * 用的版本号,在途运行就落在这上面。所以专门列一条,让「破坏性影响」有用例托底:
 * 确认与续跑都拦下,给的是人话,而且拦下之前不动已有内容、也不花钱调模型。
 */
test("上一版规则(v2)的在途草稿:确认被拦下,内容原样留着也没再调模型", async () => {
  const { repository, gateway, service } = setup(happyPathToolTurns());
  const { run } = await createVersionAndRun(service, { idem: "v2-in-flight-confirm" });
  await service.executeRun(run.id, TEST_ACTOR.id);
  const callsAfterRun = gateway.requests.length;
  const record = repository.runs.get(run.id)!;
  assert.equal(record.status, "draft");
  record.promptVersion = "script-breakdown.v2";
  const draftBefore = structuredClone(record.draft);

  await assert.rejects(
    service.confirmRun(TEST_ACTOR, run.id),
    (error: unknown) => (error as { code?: string }).code === "prompt_version_outdated",
  );

  assert.equal(repository.confirmCalls.length, 0, "v2 草稿不许落进正式表");
  assert.deepEqual(repository.runs.get(run.id)!.draft, draftBefore, "拦下不等于清空,内容原样留着");
  assert.equal(gateway.requests.length, callsAfterRun, "版本不一致时不得再调模型");
});

test("上一版规则(v2)填到一半就失败的运行:续跑被拦下,一次模型都不许再调", async () => {
  const { repository, gateway, service } = setup([
    { error: new AppError(502, "provider_error", "provider boom", true) },
  ]);
  const { run } = await createVersionAndRun(service, { idem: "v2-in-flight-resume" });
  await service.executeRun(run.id, TEST_ACTOR.id);
  const callsAfterRun = gateway.requests.length;
  const record = repository.runs.get(run.id)!;
  assert.equal(record.status, "failed");
  record.promptVersion = "script-breakdown.v2";

  await assert.rejects(
    service.resumeRun(TEST_ACTOR, run.id),
    (error: unknown) => error instanceof ConflictError
      && error.code === "prompt_version_outdated"
      && /重新开始一次拆解/.test(error.message),
  );

  assert.equal(repository.runs.get(run.id)!.status, "failed", "拦下不改状态,用户看到的还是那次失败");
  assert.equal(gateway.requests.length, callsAfterRun, "版本不一致时不得再调模型");
});

/**
 * 「打断某一步,只重试那一步,已填的不重跑」。
 *
 * 上面那些续跑用例断的是终态:跑完之后是两场、两个镜头。终态不够——
 * 从头重放一遍,终态照样是两场两镜头。所以这两条断的是**副作用次数**,
 * 取的量是落库写次数:每填进去一格就落一次库,它是断点续跑唯一的内容真源,
 * 也是这条路上唯一能反映「这一格到底重跑没重跑」的可观测量
 * (模型往返次数在测试里是我们喂的,拿它自证等于循环论证)。
 *
 * 流水由 InMemoryScriptBreakdownRepository.draftWrites 逐次记下。
 */

/** 草稿里每一条内容的稳定身份。收尾会拿未截断资产清单重算预关联,这里避开那点噪音。 */
interface DraftLedger {
  storySummary: string | null;
  scenes: string[];
  characters: string[];
  locations: string[];
  props: string[];
  costumes: string[];
  audios: string[];
  shots: string[];
}

function draftLedger(draft: ScriptBreakdownDraft): DraftLedger {
  return {
    storySummary: draft.storySummary ?? null,
    scenes: (draft.sceneDivisions ?? []).map((scene) =>
      `${scene.sceneIndex}|${scene.name}|${scene.summary}|${scene.startLineIndex}-${scene.endLineIndex}`),
    characters: (draft.assetCandidates?.characters ?? []).map((item) => `${item.candidateId}|${item.name}`),
    locations: (draft.assetCandidates?.scenes ?? []).map((item) => `${item.candidateId}|${item.name}`),
    props: (draft.assetCandidates?.props ?? []).map((item) => `${item.candidateId}|${item.name}`),
    costumes: (draft.assetCandidates?.costumes ?? []).map((item) => `${item.candidateId}|${item.name}`),
    audios: (draft.assetCandidates?.audios ?? []).map((item) => `${item.candidateId}|${item.name}`),
    shots: (draft.shotCandidates ?? []).map((shot) =>
      `${shot.candidateId}|${shot.shotNo}|${shot.sceneIndex}|${shot.lineIndices.join(",")}`),
  };
}

const LEDGER_LISTS = ["scenes", "characters", "locations", "props", "costumes", "audios", "shots"] as const;
function ledgerSize(ledger: DraftLedger): number {
  return (ledger.storySummary === null ? 0 : 1)
    + LEDGER_LISTS.reduce((total, key) => total + ledger[key].length, 0);
}

/**
 * 落库流水只增不减:每一次写入都必须是上一次的延长——已经写进去的条目逐字不变,
 * 只在末尾追加。「续跑从头重放」和「失败连带清掉已填内容」都会在这里断掉。
 */
function assertAppendOnly(writes: ScriptBreakdownDraft[], label: string): void {
  let previous = draftLedger({});
  writes.forEach((draft, index) => {
    const current = draftLedger(draft);
    if (previous.storySummary !== null) {
      assert.equal(current.storySummary, previous.storySummary, `${label}:第 ${index} 次落库改写了已有的故事梗概`);
    }
    for (const key of LEDGER_LISTS) {
      assert.deepEqual(
        current[key].slice(0, previous[key].length),
        previous[key],
        `${label}:第 ${index} 次落库把已经填好的${key}抹了或改了,不是在后面接着填`,
      );
    }
    previous = current;
  });
}

/** 真正新增了内容的那几次落库。同一格被重跑一遍,这个数就会变大。 */
function contentWrites(writes: ScriptBreakdownDraft[]): number {
  let size = 0;
  let count = 0;
  for (const draft of writes) {
    const next = ledgerSize(draftLedger(draft));
    if (next > size) count += 1;
    size = next;
  }
  return count;
}

/** 把场次那一轮改成「好一个坏一个」——工作台必退回,模型只重发坏的那次。 */
function injectedFailureTurns(): ToolTurnStep[] {
  const turns = happyPathToolTurns();
  const scenes = turns[1]!.toolCalls!;
  return [
    turns[0]!,
    // 注入:第一场是好的,第二场的起始行报错(接不上)——只有它会被打成失败
    { toolCalls: [scenes[0]!, { name: "add_scene", arguments: { name: "天台", summary: "对峙", start_line_index: 0, end_line_index: 3 } }] },
    // 模型只把失败那一次改对重发,前面填好的一格都没重发
    { toolCalls: [scenes[1]!] },
    turns[2]!,
    turns[3]!,
  ];
}

test("打断某一步:只有那一步重试,已经填好的一格都没有再落一次库", async () => {
  const { repository, gateway, service } = setup(injectedFailureTurns());
  const { run } = await createVersionAndRun(service, { idem: "retry-one-step" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const after = (await repository.getRun(run.id))!;
  assert.equal(after.status, "draft");

  const events = await repository.listFillEvents(run.id);
  const accepted = events.filter((event) => event.status === "accepted");
  const rejected = events.filter((event) => event.status === "rejected");
  assert.equal(rejected.length, 1, "注入的那一步要真的被打成失败,否则这条用例什么都没测");
  assert.equal(rejected[0]?.tool, "add_scene");

  // 一、每一格只被工作台接受一次:梗概 1 + 场 2 + 资产 7 + 收尾 1 = 11。
  assert.equal(accepted.length, 11, "阶段①各格各被接受一次");
  // 二、被退回的那一步一次库都没落:落库次数 = 成功填充次数 + 阶段②一次 + 收尾重算一次。
  assert.equal(
    repository.draftWrites.length,
    accepted.length + 2,
    "落库次数必须与成功填充次数一一对应:退回的那一步没改草稿,再落一次库是白写",
  );
  // 三、阶段①十格(梗概 1 + 场 2 + 资产 7)各落一次 + 阶段②一次整批落镜,没有谁被重跑。
  assert.equal(contentWrites(repository.draftWrites), 11, "每一格只该产生一次内容写入");
  // 四、失败没有连带抹掉前面填好的:整条流水只增不减,已有条目逐字不变。
  assertAppendOnly(repository.draftWrites, "单步注入");

  // 五、失败只多花一轮往返(重发那一步),不是整份重来。
  const { gateway: cleanGateway, service: cleanService } = setup(happyPathToolTurns());
  const clean = await createVersionAndRun(cleanService, { idem: "retry-one-step-baseline" });
  await cleanService.executeRun(clean.run.id, TEST_ACTOR.id);
  assert.equal(
    gateway.requests.length,
    cleanGateway.requests.length + 1,
    "打断一步只该多一轮重发,多出来的轮数超过 1 就说明它在重跑已经做完的事",
  );
});

test("整轮打断后续跑:模型把已填的又发一遍,一格都没有再填进去,也没有再落一次库", async () => {
  const turns = happyPathToolTurns();
  const { repository, service } = setup([
    ...turns.slice(0, 3),
    { error: new AppError(502, "provider_error", "provider boom", true) },
  ]);
  const { run } = await createVersionAndRun(service, { idem: "resume-no-refill" });
  await service.executeRun(run.id, TEST_ACTOR.id);

  const boundary = repository.draftWrites.length;
  const eventsBefore = (await repository.listFillEvents(run.id)).length;
  const contentWritesBefore = contentWrites(repository.draftWrites);
  assert.equal(boundary, 10, "挂之前填进去十格:梗概 1 + 场 2 + 资产 7");
  assert.equal(contentWritesBefore, 10);

  // 续跑:模型手上没有「刚才发到哪」,把梗概、场次、资产原样又发了一遍,然后收尾;
  // 重发的每一格都必须被工作台挡回去,不能变成第二份。
  const resumed = new ScriptBreakdownService(
    repository,
    new ScriptedToolTurnGateway([turns[0]!, turns[1]!, turns[2]!, turns[3]!]),
    new AllowAllAccess(),
    { now: fixedNow },
  );
  await resumed.resumeRun(TEST_ACTOR, run.id);
  await resumed.executeRun(run.id, TEST_ACTOR.id);
  assert.equal((await repository.getRun(run.id))!.status, "draft");

  // 一、续跑里模型重发的每一格都被工作台退回,一格都没有再填进去。
  const resumeEvents = (await repository.listFillEvents(run.id)).slice(eventsBefore);
  const refused = resumeEvents.filter((event) => event.status === "rejected");
  assert.deepEqual(
    refused.map((event) => event.tool),
    [
      "add_scene", "add_scene",
      "add_character", "add_character", "add_location", "add_location", "add_prop",
      "add_costume", "add_audio",
    ],
    "已经填好的格子必须被原样退回,不能变成第二份",
  );
  // 二、续跑只为阶段②的新内容落库:一次整批落镜。已填的十格没有产生任何新增写入。
  assert.equal(contentWrites(repository.draftWrites), 11, "阶段①十格 + 阶段②一次整批落镜");
  assert.equal(
    contentWrites(repository.draftWrites) - contentWritesBefore,
    1,
    "续跑只该为阶段②新增内容;这个数变大就是已填的被重跑了",
  );

  // 三、整条流水(跨两次执行)只增不减:已有条目逐字不变,只在末尾追加。
  //     「续跑从头重放」会让续跑第一笔倒退回空草稿,在这里断掉。
  assertAppendOnly(repository.draftWrites, "续跑");

  // 四、唯一一次「已完成的步骤被重新执行」:梗概没有去重,续跑重发会被再接受一次。
  //     它写回去的是同一句话,内容没动——这里把这个边界钉住,免得哪天悄悄变成会改内容。
  const resumeWrites = repository.draftWrites.slice(boundary);
  const reAcceptedOutline = resumeEvents.filter(
    (event) => event.status === "accepted" && event.tool === "write_story_outline",
  );
  assert.equal(reAcceptedOutline.length, 1, "梗概目前不去重:重发会被再接受一次");
  assert.equal(
    resumeWrites[0]?.storySummary,
    repository.draftWrites[boundary - 1]?.storySummary,
    "梗概重写只能写回同一句话,不许改内容",
  );
});
