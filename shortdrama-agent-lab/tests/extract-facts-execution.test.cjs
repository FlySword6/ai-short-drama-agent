const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readConfig } = require('../dist/config');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { BreakdownService } = require('../dist/breakdown/service');
const { MaasStageModelAdapter } = require('../dist/breakdown/model-adapter');
const {
  ExtractFactsStageRunner,
  SingleModelCallExtractFactsExecutor,
} = require('../dist/breakdown/execution');

const config = readConfig({ LLM_BASE_URL: 'https://model.test/openai', LLM_API_KEY: 'test-only-api-key' });

function fixture(options = {}) {
  let ordinal = 0;
  let tick = 0;
  const repository = new InMemoryBreakdownRepository();
  const now = () => new Date(Date.parse('2026-10-01T13:00:00.000Z') + tick++ * 1000);
  const nextId = (prefix) => `${prefix}_${String(++ordinal).padStart(4, '0')}`;
  const service = new BreakdownService(repository, config, { now, nextId });
  const runner = new ExtractFactsStageRunner(
    repository,
    service,
    options.executor ?? new SingleModelCallExtractFactsExecutor(),
    options.adapter,
    { now, nextId, targetEstimatedTokens: options.targetEstimatedTokens ?? 4000 },
  );
  return { repository, service, runner };
}

async function prepared(service, rawText = [
  '第1场 医院走廊 夜 内',
  '林晚推门进入。',
  '林晚：你终于来了。🙂',
  '顾沉：我知道。',
].join('\n')) {
  const project = await service.createProject({ title: 'P0.4 执行测试' });
  const script = await service.createScriptVersion(project.id, { rawText });
  const run = await service.createDraftRun(project.id, {
    requirements: { language: '中文', visualStyle: '真人拟真', aspectRatio: '9:16' },
    maxModelCalls: 1,
    maxOutputTokens: 4096,
  });
  return { project, script, run };
}

function allEvidence(context) {
  return context.chunks.flatMap((chunk) => chunk.evidence.map((entry) => ({
    ...entry,
    chunkId: chunk.id,
  })));
}

function pointer(context, quote, role = 'primary') {
  const found = allEvidence(context).find((entry) => entry.quote === quote && entry.role === role);
  assert.ok(found, `missing ${role} evidence: ${quote}`);
  return { chunkId: found.chunkId, alias: found.alias };
}

function aliasedCandidate(context) {
  const heading = pointer(context, '第1场 医院走廊 夜 内');
  const action = pointer(context, '林晚推门进入。');
  const linLine = pointer(context, '林晚：你终于来了。🙂');
  const guLine = pointer(context, '顾沉：我知道。');
  const sourced = (value, evidence) => ({ value, evidence });
  return {
    synopsis: sourced('林晚进入医院走廊，与顾沉交谈。', [heading, action, linLine, guLine]),
    characters: [
      { tempId: 'tmp_lin', name: sourced('林晚', [linLine]), aliases: [], description: null, evidence: [action, linLine] },
      { tempId: 'tmp_gu', name: sourced('顾沉', [guLine]), aliases: [], description: null, evidence: [guLine] },
    ],
    locations: [
      { tempId: 'tmp_hall', name: sourced('医院走廊', [heading]), aliases: [], description: null, evidence: [heading] },
    ],
    props: [],
    scenes: [{
      tempId: 'tmp_scene', order: 1, title: sourced('医院走廊相见', [heading, action]),
      locationTempId: 'tmp_hall', characterTempIds: ['tmp_lin', 'tmp_gu'],
      evidence: [heading, action, linLine, guLine], timeOfDay: sourced('夜', [heading]),
    }],
    dialogues: [
      {
        tempId: 'tmp_d1', sceneTempId: 'tmp_scene', speakerTempId: 'tmp_lin',
        speakerEvidence: [linLine], source: { evidence: linLine, quote: '你终于来了。🙂' },
      },
      {
        tempId: 'tmp_d2', sceneTempId: 'tmp_scene', speakerTempId: 'tmp_gu',
        speakerEvidence: [guLine], source: { evidence: guLine, quote: '我知道。' },
      },
    ],
  };
}

test('P0.4 executes one recorded model call, resolves aliases and waits for candidate review', async () => {
  let captured;
  const adapter = {
    async call(input) {
      captured = input;
      return {
        providerRequestId: 'fake-request-001',
        usage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 },
        output: aliasedCandidate(input.payload.context),
      };
    },
  };
  const { repository, service, runner } = fixture({ adapter });
  const { project, run } = await prepared(service);
  const result = await runner.run(run.id);

  assert.equal(captured.model, run.modelConfig.model);
  assert.equal(captured.payload.promptVersion, 'extract-facts-prompt/1');
  assert.equal(captured.payload.context.schemaVersion, 'extract-facts-context/1');
  assert.equal(result.plan.attemptId, result.execution.attempt.id);
  assert.equal(result.plan.content.dialogues[0].sourceRef.quote, '你终于来了。🙂');
  assert.equal(result.execution.attempt.status, 'succeeded');
  assert.equal(result.execution.attempt.outputPlanRevisionId, result.plan.id);
  assert.equal(result.execution.modelCalls.length, 1);
  assert.equal(result.execution.modelCalls[0].status, 'succeeded');
  assert.equal(result.execution.modelCalls[0].providerRequestId, 'fake-request-001');
  assert.deepEqual(result.execution.modelCalls[0].usage, {
    inputTokens: 120, outputTokens: 80, totalTokens: 200,
  });
  assert.match(result.execution.modelCalls[0].requestDigest, /^[0-9a-f]{64}$/);

  const savedRun = await service.getRun(run.id);
  assert.equal(savedRun.status, 'waiting');
  assert.equal(savedRun.task.state, 'waitingHuman');
  assert.equal(savedRun.task.activeAttemptId, result.execution.attempt.id);
  assert.notEqual(savedRun.sealedAt, null);
  assert.equal((await repository.getProject(project.id)).activePlanRevisionId, null);
});

test('P0.4 rejects a fact supported only by a context alias and fails closed', async () => {
  const adapter = {
    async call(input) {
      const contextEvidence = allEvidence(input.payload.context).find((entry) => entry.role === 'context');
      assert.ok(contextEvidence, 'fixture must expose a context alias');
      return {
        providerRequestId: 'fake-context-only', usage: null,
        output: {
          synopsis: { value: '不能只靠上下文', evidence: [{ chunkId: contextEvidence.chunkId, alias: contextEvidence.alias }] },
          characters: [], locations: [], props: [], scenes: [], dialogues: [],
        },
      };
    },
  };
  const { service, runner, repository } = fixture({ adapter, targetEstimatedTokens: 6 });
  const rawText = ['甲走进房间。', '乙关上房门。', '甲看向窗外。', '乙放下钥匙。'].join('\n');
  const { run } = await prepared(service, rawText);
  await assert.rejects(runner.run(run.id), (error) => error.code === 'CONTEXT_ONLY_EVIDENCE'
    && error.paidModelCallState === 'confirmed');
  const failedRun = await service.getRun(run.id);
  assert.equal(failedRun.status, 'failed');
  assert.equal(failedRun.task.state, 'failed');
  const snapshot = await repository.getExecutionSnapshot(failedRun.task.activeAttemptId);
  assert.equal(snapshot.attempt.status, 'failed');
  assert.equal(snapshot.attempt.error.code, 'CONTEXT_ONLY_EVIDENCE');
  assert.equal(snapshot.modelCalls[0].status, 'succeeded', 'transport succeeded even though validation failed');
  assert.deepEqual(await service.listPlanRevisions(run.id), []);
});

test('P0.4 records a sanitized adapter failure and does not save raw errors or a plan', async () => {
  const adapter = {
    async call() { throw new Error('secret vendor payload must not persist'); },
  };
  const { service, runner, repository } = fixture({ adapter });
  const { run } = await prepared(service);
  await assert.rejects(runner.run(run.id), (error) => error.code === 'MODEL_ADAPTER_FAILED'
    && error.paidModelCallState === 'unknown');
  const failedRun = await service.getRun(run.id);
  const snapshot = await repository.getExecutionSnapshot(failedRun.task.activeAttemptId);
  assert.equal(snapshot.attempt.status, 'failed');
  assert.equal(snapshot.modelCalls[0].status, 'failed');
  assert.equal(snapshot.modelCalls[0].error.message, '模型适配器调用失败。');
  assert.equal(JSON.stringify(snapshot).includes('secret vendor payload'), false);
  assert.deepEqual(await service.listPlanRevisions(run.id), []);
});

test('P0.4 enforces maxModelCalls before a second adapter invocation', async () => {
  let adapterCalls = 0;
  const adapter = {
    async call() {
      adapterCalls += 1;
      return {
        providerRequestId: `fake-${adapterCalls}`, usage: null,
        output: { synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [] },
      };
    },
  };
  const executor = {
    version: 'two-call-test-executor/1',
    async execute(context, model) {
      await model.call({ operation: 'first', context });
      return model.call({ operation: 'second', context });
    },
  };
  const { service, runner, repository } = fixture({ adapter, executor });
  const { run } = await prepared(service);
  await assert.rejects(runner.run(run.id), (error) => error.code === 'MODEL_CALL_LIMIT_REACHED'
    && error.paidModelCallState === 'confirmed');
  const failedRun = await service.getRun(run.id);
  const snapshot = await repository.getExecutionSnapshot(failedRun.task.activeAttemptId);
  assert.equal(adapterCalls, 1);
  assert.equal(snapshot.modelCalls.length, 1);
  assert.equal(snapshot.modelCalls[0].status, 'succeeded');
  assert.equal(snapshot.attempt.status, 'failed');
});

test('removed provider, model and reasoning snapshots remain readable but cannot begin another attempt', async () => {
  const legacyConfigurations = [
    { provider: 'local-proxy', model: 'gpt-5.6-terra', reasoningEffort: 'medium' },
    { provider: 'maas', model: 'gpt-5.6-terra', reasoningEffort: 'model-default' },
    { provider: 'maas', model: config.defaultModel, reasoningEffort: 'high' },
  ];
  for (const modelConfig of legacyConfigurations) {
    let calls = 0;
    const { repository, service, runner } = fixture({ adapter: { async call() { calls++; throw new Error('must not execute'); } } });
    const { run } = await prepared(service);
    // Simulate the immutable snapshot saved by the previous provider version.
    repository.runs.get(run.id).modelConfig = structuredClone(modelConfig);
    const before = await service.getRun(run.id);
    assert.deepEqual(before.modelConfig, modelConfig);
    await assert.rejects(runner.run(run.id), error => error.status === 409 && error.code === 'MODEL_CONFIGURATION_CHANGED');
    assert.deepEqual(await service.getRun(run.id), before);
    assert.equal(repository.attempts.size, 0);
    assert.equal(repository.modelCalls.size, 0);
    assert.equal(calls, 0);
  }
});

test('unconfigured MAAS adapter blocks execution before creating attempt or call records', async () => {
  let calls = 0;
  const adapter = new MaasStageModelAdapter(readConfig({}), async () => { calls++; throw new Error('must not call'); });
  const { repository, service, runner } = fixture({ adapter });
  const { run } = await prepared(service);
  await assert.rejects(runner.run(run.id), error => error.status === 503 && error.code === 'MODEL_NOT_CONFIGURED');
  assert.equal((await service.getRun(run.id)).status, 'draft');
  assert.equal(repository.attempts.size, 0);
  assert.equal(repository.modelCalls.size, 0);
  assert.equal(calls, 0);
});

test('MAAS stage adapter sends only the new model and parses the controlled JSON result', async () => {
  let calls = 0;
  const output = { synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [] };
  const adapter = new MaasStageModelAdapter(config, async (url, options) => {
    calls++;
    assert.equal(url, 'https://model.test/openai/chat/completions');
    assert.equal(options.headers['api-key'], 'test-only-api-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, config.defaultModel);
    assert.equal(body.stream, false);
    assert.equal(Object.hasOwn(body, 'reasoning_effort'), false);
    assert.equal(body.max_tokens, 4096);
    return new Response(JSON.stringify({ id: 'maas-stage-fake', model: body.model,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  const result = await adapter.call({ model: config.defaultModel, reasoningEffort: 'model-default', maxOutputTokens: 4096,
    payload: { operation: 'extractFacts', systemPrompt: 'Return JSON', messages: [{ role: 'user', content: 'synthetic test' }] } });
  assert.deepEqual(result.output, output);
  assert.equal(result.providerRequestId, 'maas-stage-fake');
  assert.equal(calls, 1);
});
