const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

if (!process.env.DATABASE_URL) {
  test('PostgreSQL P0.2 integration requires DATABASE_URL', { skip: 'Set DATABASE_URL (or use node --env-file=.env) before test:db.' }, () => {});
} else {
  const { readConfig } = require('../dist/config');
  const { readDatabaseConfig } = require('../dist/db/config');
  const { PostgresDatabase } = require('../dist/db/client');
  const { PostgresBreakdownRepository } = require('../dist/breakdown/repository');
  const { BreakdownService } = require('../dist/breakdown/service');
  const { ExtractFactsStageRunner, SingleModelCallExtractFactsExecutor } = require('../dist/breakdown/execution');
  const { StoryboardService } = require('../dist/breakdown/storyboard');
  const { reconstructSource } = require('../dist/breakdown/source-index');

  test('PostgreSQL persists fact checks, adoption, storyboard revisions, and the execution ledger', async () => {
    const database = new PostgresDatabase(readDatabaseConfig());
    let projectId;
    try {
      await database.verifyConnection();
      assert.equal(await database.hasMigrations(['001', '002', '003', '004', '005', '006']), true, 'Run npm run db:migrate before test:db.');
      const repository = new PostgresBreakdownRepository(database);
      const service = new BreakdownService(repository, readConfig({}));
      const source = { url: 'https://www.qidian.com/chapter/1049358005/906767983/' };
      const project = await service.createProject({ title: `db-test-${randomUUID()}`, source });
      projectId = project.id;
      assert.deepEqual((await service.getProject(project.id)).source, source);
      const script = await service.createScriptVersion(project.id, {
        rawText: '第1场 走廊 夜 内\n林晚：你终于来了。\n顾沉：我知道。',
      });
      assert.equal(reconstructSource(script.sourceIndex), script.rawText);
      const run = await service.createDraftRun(project.id, {
        maxModelCalls: 1, maxOutputTokens: 4096, requirements: { language: '中文' },
      });
      const reread = await service.getRun(run.id);
      assert.equal(reread.status, 'draft');
      assert.equal(reread.task.type, 'extractFacts');
      assert.equal(reread.task.inputManifest.entries[0].digest, script.contentSha256);
      const fullLine = ref(script.id, script.rawText, '林晚：你终于来了。');
      const otherLine = ref(script.id, script.rawText, '顾沉：我知道。');
      const headingLine = ref(script.id, script.rawText, '第1场 走廊 夜 内');
      const candidate = {
        synopsis: sourced('林晚与顾沉在走廊交谈。', [fullLine, otherLine]),
        characters: [
          { tempId: 'tmp_lin', name: sourced('林晚', [fullLine]), aliases: [], description: null, sourceRefs: [fullLine] },
          { tempId: 'tmp_gu', name: sourced('顾沉', [otherLine]), aliases: [], description: null, sourceRefs: [otherLine] },
        ],
        locations: [], props: [],
        scenes: [{
          tempId: 'tmp_scene', order: 1, title: sourced('走廊交谈', [fullLine, otherLine]),
          locationTempId: null, characterTempIds: ['tmp_lin', 'tmp_gu'],
          sourceRefs: [headingLine, fullLine, otherLine], timeOfDay: null,
        }],
        dialogues: [
          { tempId: 'tmp_d1', sceneTempId: 'tmp_scene', speakerTempId: 'tmp_lin', speakerSourceRefs: [fullLine], speakerAnswerIds: [], sourceRef: ref(script.id, script.rawText, '你终于来了。') },
          { tempId: 'tmp_d2', sceneTempId: 'tmp_scene', speakerTempId: 'tmp_gu', speakerSourceRefs: [otherLine], speakerAnswerIds: [], sourceRef: ref(script.id, script.rawText, '我知道。') },
        ],
      };
      const plan = await service.createExtractFactsCandidate(run.id, candidate);
      assert.equal(plan.status, 'candidate');
      assert.equal((await service.getPlanRevision(plan.id)).content.dialogues[1].sourceRef.quote, '我知道。');
      assert.equal((await service.listPlanRevisions(run.id)).length, 1);
      const storedProject = await database.query('SELECT active_plan_revision_id FROM projects WHERE id = $1', [project.id]);
      assert.equal(storedProject.rows[0].active_plan_revision_id, null);
      const inspected = await service.checkPlan(plan.id);
      assert.equal(inspected.check.result, 'passed', inspected.issues.map(issue => issue.code).join(','));
      assert.equal(inspected.issues.length, 0);
      const adopted = await service.adoptPlan(project.id, {
        planRevisionId: plan.id, checkId: inspected.check.id, expectedActivePlanRevisionId: null,
      });
      assert.equal(adopted.toRevisionId, plan.id);
      assert.equal((await service.getProject(project.id)).activePlanRevisionId, plan.id);

      const storyboard = new StoryboardService(database, service, readConfig({}), async (_url, request) => {
        const submitted = JSON.parse(request.body);
        assert.equal(submitted.model, 'gpt-5.6-terra');
        return new Response(JSON.stringify({
          id: 'db-storyboard-fake', model: submitted.model, finish_reason: 'stop',
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ shots: [
            { sceneId: plan.content.scenes[0].id, order: 1, visualDescription: '走廊双人中景',
              shotSize: '中景', cameraMovement: '固定', durationMs: 3500,
              sourceRefs: [fullLine], dialogueIds: [plan.content.dialogues[0].id] },
            { sceneId: plan.content.scenes[0].id, order: 2, visualDescription: '切向顾沉',
              shotSize: '近景', cameraMovement: '切镜', durationMs: 2800,
              sourceRefs: [otherLine], dialogueIds: [plan.content.dialogues[1].id] },
          ] }) } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }), { headers: { 'Content-Type': 'application/json' } });
      });
      const board = await storyboard.generate(project.id);
      assert.equal(board.shots.length, 2);
      assert.equal(board.shots[0].design.origin, 'designSuggestion');
      assert.equal((await storyboard.list(project.id))[0].id, board.id);
      await storyboard.adopt(project.id, board.id, null);
      assert.equal((await service.getProject(project.id)).activeStoryboardRevisionId, board.id);

      const executionRun = await service.createDraftRun(project.id, {
        maxModelCalls: 1, maxOutputTokens: 4096, requirements: { language: '中文' },
      });
      const runner = new ExtractFactsStageRunner(
        repository,
        service,
        new SingleModelCallExtractFactsExecutor(),
        {
          async call() {
            return {
              providerRequestId: 'db-fake-request',
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
              output: { synopsis: null, characters: [], locations: [], props: [], scenes: [], dialogues: [] },
            };
          },
        },
      );
      const executed = await runner.run(executionRun.id);
      assert.equal(executed.execution.attempt.status, 'succeeded');
      assert.equal(executed.execution.modelCalls[0].status, 'succeeded');
      assert.equal(executed.plan.attemptId, executed.execution.attempt.id);
      const waiting = await service.getRun(executionRun.id);
      assert.equal(waiting.status, 'waiting');
      assert.equal(waiting.task.state, 'waitingHuman');
    } finally {
      if (projectId) await database.query('DELETE FROM projects WHERE id = $1', [projectId]);
      await database.close();
    }
  });
}

function ref(scriptVersionId, rawText, quote) {
  const source = Array.from(rawText);
  const target = Array.from(quote);
  let start = -1;
  for (let index = 0; index <= source.length - target.length; index += 1) {
    if (target.every((point, offset) => source[index + offset] === point)) { start = index; break; }
  }
  assert.notEqual(start, -1);
  return { scriptVersionId, start, end: start + target.length, quote };
}

function sourced(value, sourceRefs) {
  return { value, origin: 'source', sourceRefs, answerIds: [] };
}
