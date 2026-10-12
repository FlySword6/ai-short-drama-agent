const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateStoryboardOutput } = require('../dist/breakdown/storyboard');

const ref = { scriptVersionId: 'script_1', start: 0, end: 8, quote: '林晚：你来了。' };
const dialogueRef = { scriptVersionId: 'script_1', start: 3, end: 8, quote: '你来了。' };
const plan = { content: {
  scenes: [{ id: 'scene_1', sourceRefs: [ref] }],
  dialogues: [{ id: 'dialogue_1', sceneId: 'scene_1', sourceRef: dialogueRef }],
} };
const candidate = { shots: [{ sceneId: 'scene_1', order: 1, visualDescription: '林晚中景',
  shotSize: '中景', cameraMovement: '固定', durationMs: 3000, sourceRefs: [ref], dialogueIds: ['dialogue_1'] }] };

test('storyboard design is marked as suggestion and every shot cites original source', () => {
  const [shot] = validateStoryboardOutput(candidate, plan, () => 'shot_test');
  assert.equal(shot.id, 'shot_test');
  assert.equal(shot.design.origin, 'designSuggestion');
  assert.deepEqual(shot.sourceRefs, [ref]);
});

test('storyboard rejects fabricated quote and missing dialogue', () => {
  const fake = structuredClone(candidate);
  fake.shots[0].sourceRefs[0].quote = '林晚：别走。';
  assert.throws(() => validateStoryboardOutput(fake, plan), { code: 'STORYBOARD_SOURCE_INVALID' });
  const missing = structuredClone(candidate);
  missing.shots[0].dialogueIds = [];
  assert.throws(() => validateStoryboardOutput(missing, plan), { code: 'STORYBOARD_COVERAGE_INCOMPLETE' });
});
