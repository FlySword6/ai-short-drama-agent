const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { InMemoryBreakdownRepository } = require('../dist/breakdown/repository');
const { BreakdownService } = require('../dist/breakdown/service');

const config = readConfig({});

function fixture() {
  let ordinal = 0;
  const repository = new InMemoryBreakdownRepository();
  const service = new BreakdownService(repository, config, {
    now: () => new Date('2026-10-01T12:00:00.000Z'),
    nextId: (prefix) => `${prefix}_${String(++ordinal).padStart(4, '0')}`,
  });
  return { repository, service };
}

function sourceRef(scriptVersionId, rawText, quote, occurrence = 0) {
  const source = Array.from(rawText);
  const target = Array.from(quote);
  let found = -1;
  let seen = 0;
  for (let start = 0; start <= source.length - target.length; start += 1) {
    if (target.every((point, offset) => source[start + offset] === point)) {
      if (seen++ === occurrence) { found = start; break; }
    }
  }
  assert.notEqual(found, -1, `quote not found: ${quote}`);
  return { scriptVersionId, start: found, end: found + target.length, quote };
}

function sourced(value, refs) {
  return { value, origin: 'source', sourceRefs: refs, answerIds: [] };
}

function candidate(script) {
  const raw = script.rawText;
  const heading = sourceRef(script.id, raw, '第1场 医院走廊 夜 内');
  const action = sourceRef(script.id, raw, '林晚推门进入。');
  const linLine = sourceRef(script.id, raw, '林晚：你终于来了。🙂');
  const guLine = sourceRef(script.id, raw, '顾沉：我知道。');
  return {
    synopsis: sourced('林晚进入医院走廊，与等待她的顾沉交谈。', [heading, action, linLine, guLine]),
    characters: [
      { tempId: 'tmp_lin', name: sourced('林晚', [action, linLine]), aliases: [], description: null, sourceRefs: [action, linLine] },
      { tempId: 'tmp_gu', name: sourced('顾沉', [guLine]), aliases: [], description: null, sourceRefs: [guLine] },
    ],
    locations: [
      { tempId: 'tmp_hall', name: sourced('医院走廊', [heading]), aliases: [], description: null, sourceRefs: [heading] },
    ],
    props: [],
    scenes: [{
      tempId: 'tmp_scene', order: 1, title: sourced('医院走廊相见', [heading, action]),
      locationTempId: 'tmp_hall', characterTempIds: ['tmp_lin', 'tmp_gu'],
      sourceRefs: [heading, action, linLine, guLine], timeOfDay: sourced('夜', [heading]),
    }],
    dialogues: [
      {
        tempId: 'tmp_dialogue_lin', sceneTempId: 'tmp_scene', speakerTempId: 'tmp_lin',
        speakerSourceRefs: [linLine], speakerAnswerIds: [],
        sourceRef: sourceRef(script.id, raw, '你终于来了。🙂'),
      },
      {
        tempId: 'tmp_dialogue_gu', sceneTempId: 'tmp_scene', speakerTempId: 'tmp_gu',
        speakerSourceRefs: [guLine], speakerAnswerIds: [],
        sourceRef: sourceRef(script.id, raw, '我知道。'),
      },
    ],
  };
}

async function prepared(service) {
  const project = await service.createProject({ title: '候选事实测试' });
  const script = await service.createScriptVersion(project.id, {
    rawText: '第1场 医院走廊 夜 内\r\n林晚推门进入。\r\n林晚：你终于来了。🙂\r\n顾沉：我知道。\r\n',
  });
  const run = await service.createDraftRun(project.id, {
    requirements: { language: '中文', visualStyle: '真人拟真', aspectRatio: '9:16' },
    maxModelCalls: 1,
    maxOutputTokens: 4096,
  });
  return { project, script, run };
}

test('P0.3 validates extractFacts, allocates stable IDs and saves an unadopted immutable candidate', async () => {
  const { repository, service } = fixture();
  const { project, script, run } = await prepared(service);
  const plan = await service.createExtractFactsCandidate(run.id, candidate(script));

  assert.equal(plan.status, 'candidate');
  assert.equal(plan.reason, 'extract');
  assert.equal(plan.validatorVersion, 'extract-facts-validator/1');
  assert.equal(plan.content.schemaVersion, 'breakdown-plan-content/1');
  assert.equal(plan.content.scenes[0].shots.length, 0);
  assert.equal(plan.content.assetRequirements.length, 0);
  assert.equal(plan.content.manualLocks.length, 0);
  assert.ok(plan.content.characters.every((item) => item.id.startsWith('character_')));
  assert.ok(plan.content.dialogues.every((item) => item.id.startsWith('dialogue_')));
  assert.ok(!JSON.stringify(plan).includes('tmp_lin'));
  assert.equal(plan.content.dialogues[0].sourceRef.quote, '你终于来了。🙂');
  assert.equal(plan.content.dialogues[0].speakerId, plan.content.characters[0].id);
  assert.equal(plan.content.scenes[0].characterIds[1], plan.content.characters[1].id);
  assert.deepEqual(plan.requirements, run.requirements);

  const savedProject = await repository.getProject(project.id);
  assert.equal(savedProject.activePlanRevisionId, null, 'candidate must not be adopted');
  plan.content.characters[0].name.value = 'mutated';
  const reread = await service.getPlanRevision(plan.id);
  assert.equal(reread.content.characters[0].name.value, '林晚');
  assert.deepEqual(await service.listPlanRevisions(run.id), [reread]);
});

test('P0.3 rejects false quotes, dangling references and out-of-order dialogue before persistence', async () => {
  for (const mutate of [
    (value) => { value.characters[0].name.sourceRefs[0].quote = '伪造原文'; },
    (value) => { value.scenes[0].locationTempId = 'tmp_missing'; },
    (value) => { value.dialogues.reverse(); },
    (value) => { value.scenes[0].order = 2; },
  ]) {
    const { service } = fixture();
    const { script, run } = await prepared(service);
    const value = candidate(script);
    mutate(value);
    await assert.rejects(
      service.createExtractFactsCandidate(run.id, value),
      (error) => error.code === 'CANDIDATE_PLAN_INVALID' && error.status === 422,
    );
    assert.deepEqual(await service.listPlanRevisions(run.id), []);
  }
});

test('P0.3 local HTTP contract saves and reads candidates without calling a model', async () => {
  const { service } = fixture();
  let modelCalls = 0;
  const app = await createApp(config, async () => { modelCalls += 1; throw new Error('no model call expected'); }, {
    breakdownService: service,
  });
  const server = app.getHttpAdapter().getInstance();
  const headers = { host: '127.0.0.1:8788', 'x-shortdrama-call': '1' };
  try {
    const { script, run } = await prepared(service);
    const bad = await server.inject({
      method: 'POST', url: `/api/breakdown-runs/${run.id}/candidate-plan-revisions`, headers,
      payload: { ...candidate(script), unexpected: true },
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, 'INVALID_CANDIDATE_PLAN_REQUEST');

    const created = await server.inject({
      method: 'POST', url: `/api/breakdown-runs/${run.id}/candidate-plan-revisions`, headers,
      payload: candidate(script),
    });
    assert.equal(created.statusCode, 201);
    const plan = created.json();
    const listed = await server.inject({
      method: 'GET', url: `/api/breakdown-runs/${run.id}/candidate-plan-revisions`, headers,
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().items[0].id, plan.id);
    const fetched = await server.inject({ method: 'GET', url: `/api/plan-revisions/${plan.id}`, headers });
    assert.equal(fetched.statusCode, 200);
    assert.deepEqual(fetched.json(), plan);
    assert.equal(modelCalls, 0);
  } finally {
    await app.close();
  }
});

test('P0.5 records blocking issues and adopts only a checked current-script candidate', async () => {
  const { repository, service } = fixture();
  const { project, script, run } = await prepared(service);
  const incomplete = candidate(script);
  incomplete.dialogues = [];
  const invalidPlan = await service.createExtractFactsCandidate(run.id, incomplete);
  const failed = await service.checkPlan(invalidPlan.id);
  assert.equal(failed.check.result, 'failed');
  assert.ok(failed.issues.some((issue) => issue.code === 'DIALOGUE_MISSING'));
  await assert.rejects(service.adoptPlan(project.id, {
    planRevisionId: invalidPlan.id, checkId: failed.check.id,
    expectedActivePlanRevisionId: null,
  }), (error) => error.code === 'PLAN_NOT_ADOPTABLE');

  const complete = await service.createExtractFactsCandidate(run.id, candidate(script));
  const passed = await service.checkPlan(complete.id);
  assert.equal(passed.check.result, 'passed');
  assert.deepEqual(passed.issues, []);
  assert.equal((await service.listPlanChecks(complete.id))[0].id, passed.check.id);
  const adopted = await service.adoptPlan(project.id, {
    planRevisionId: complete.id, checkId: passed.check.id,
    expectedActivePlanRevisionId: null,
  });
  assert.equal(adopted.fromRevisionId, null);
  assert.equal((await repository.getProject(project.id)).activePlanRevisionId, complete.id);
  await assert.rejects(service.adoptPlan(project.id, {
    planRevisionId: complete.id, checkId: passed.check.id,
    expectedActivePlanRevisionId: null,
  }), (error) => error.code === 'PLAN_ADOPTION_CONFLICT');
  await service.createScriptVersion(project.id, { rawText: '第1场 新版场景 日 内\n甲：新版对白。' });
  assert.equal((await repository.getProject(project.id)).activePlanRevisionId, null);
  await assert.rejects(service.adoptPlan(project.id, {
    planRevisionId: complete.id, checkId: passed.check.id,
    expectedActivePlanRevisionId: null,
  }), (error) => error.code === 'PLAN_NOT_ADOPTABLE');
});
