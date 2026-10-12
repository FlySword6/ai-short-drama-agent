const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createApp } = require('../dist/app');
const { readConfig } = require('../dist/config');
const { MODELS } = require('../dist/models/registry');
const { ModelClient } = require('../dist/models/client');
const { parseCall } = require('../dist/models/contracts');

const config = readConfig({});
const headers = { host: '127.0.0.1:8788', 'x-shortdrama-call': '1' };
const input = (overrides = {}) => ({ messages: [{ role: 'user', content: 'hello' }], allowPaid: true, ...overrides });
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==';
const imageInput = (model) => input({ model, messages: [{ role: 'user', content: [
  { type: 'text', text: 'Describe the image' }, { type: 'image_url', image_url: { url: png } },
] }] });
const completion = (changes = {}) => ({ id: 'chatcmpl-test', model: 'gpt-5.6-terra',
  choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }, ...changes });
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('registry has 14 unique entries, correct text-only models, no fictional ultra', () => {
  assert.equal(MODELS.length, 14);
  assert.equal(new Set(MODELS.map(m => m.id)).size, 14);
  assert.deepEqual(MODELS.filter(m => !m.imageInput).map(m => m.id), ['deepseek-v4-pro-0813-ali', 'glm-5.3']);
  for (const model of MODELS) {
    assert.ok(model.reasoningEfforts.includes(model.defaultReasoningEffort));
    assert.ok(!model.reasoningEfforts.includes('ultra'));
  }
});

test('env defaults and local-only configuration fail closed', () => {
  assert.equal(config.defaultModel, 'gpt-5.6-terra');
  assert.equal(config.reasoningEffort, 'medium');
  for (const env of [
    { PORT: '8787' }, { PORT: 'bad' }, { LLM_TIMEOUT_MS: '0' }, { LLM_MAX_OUTPUT_TOKENS: '999999' },
    { LLM_BASE_URL: 'https://example.com/v1' }, { LLM_BASE_URL: 'http://secret@127.0.0.1:8787/v1' },
    { LLM_BASE_URL: 'http://127.0.0.1:8787/v1?token=secret' }, { LLM_DEFAULT_MODEL: 'unknown' },
    { LLM_REASONING_EFFORT: 'ultra' },
  ]) assert.throws(() => readConfig(env));
});

test('all 14 models route without fallback using configured effective efforts (mock only)', async () => {
  for (const model of MODELS) {
    let called = 0;
    const client = new ModelClient(config, async (url, options) => {
      called++;
      const body = JSON.parse(options.body);
      assert.equal(url, 'http://127.0.0.1:8787/v1/chat/completions');
      assert.equal(body.model, model.id);
      assert.equal(
        body.reasoning_effort,
        model.id === config.defaultModel ? config.reasoningEffort : model.defaultReasoningEffort,
      );
      assert.equal(body.max_tokens, 8192);
      assert.equal(body.stream, false);
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.redirect, 'error');
      return json(completion({ model: model.id }));
    });
    const result = await client.call(input({ model: model.id }));
    assert.equal(result.requestedModel, model.id);
    assert.equal(result.status, 'completed');
    assert.equal(called, 1);
  }
});

test('effort precedence: request > default-model env > per-model policy', async () => {
  const client = new ModelClient({ ...config, reasoningEffort: 'low' }, async (_, options) =>
    json(completion({ choices: [{ message: { content: JSON.parse(options.body).reasoning_effort }, finish_reason: 'stop' }] })));
  assert.equal((await client.call(input())).text, 'low');
  assert.equal((await client.call(input({ reasoningEffort: 'xhigh' }))).text, 'xhigh');
  assert.equal((await client.call(input({ model: 'claude-sonnet-5' }))).text, 'max');
});

test('reject invalid bodies, images, unknown fields, missing consent before network', async () => {
  let called = 0;
  const client = new ModelClient(config, async () => { called++; return json(completion()); });
  const badBodies = [null, {}, input({ allowPaid: false }), input({ messages: [] }),
    input({ stream: true }), input({ apiKey: 'do-not-forward' }), input({ tools: [] }),
    input({ maxOutputTokens: 1 }), input({ reasoningEffort: 'ultra' }),
    input({ messages: [{ role: 'system', content: 'no user' }] }),
    input({ messages: [{ role: 'user', content: '   ' }] }),
    input({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] }),
    input({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }] }),
  ];
  for (const bad of badBodies) await assert.rejects(client.call(bad));
  await rejectsCode(client.call(input({ model: 'fake' })), 'UNKNOWN_MODEL');
  await rejectsCode(client.call(input({ model: 'qwen3.7-plus', reasoningEffort: 'max' })), 'EFFORT_UNSUPPORTED');
  await rejectsCode(client.call(imageInput('glm-5.3')), 'IMAGE_UNSUPPORTED');
  await rejectsCode(client.call(imageInput('deepseek-v4-pro-0813-ali')), 'IMAGE_UNSUPPORTED');
  assert.equal(called, 0);
});

test('multimodal payload reaches transport unchanged for configured vision models', async () => {
  for (const model of MODELS.filter(m => m.imageInput)) {
    const body = imageInput(model.id);
    const client = new ModelClient(config, async (_, options) => {
      assert.deepEqual(JSON.parse(options.body).messages, body.messages);
      return json(completion());
    });
    await client.call(body);
  }
});

test('input/image count caps apply to direct calls too', () => {
  const content = imageInput().messages[0].content;
  assert.throws(() => parseCall(input({ messages: Array.from({ length: 5 }, () => ({ role: 'user', content })) })), e => e.code === 'TOO_MANY_IMAGES');
  assert.throws(() => parseCall(input({ messages: Array.from({ length: 12 }, () => ({ role: 'user', content: 'a'.repeat(1000000) })) })), e => e.code === 'INPUT_TOO_LARGE');
});

test('upstream failures are sanitized and never retried', async () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    let calls = 0;
    const client = new ModelClient(config, async () => { calls++; return new Response('secret-token-private-url', { status }); });
    await assert.rejects(client.call(input()), error => {
      assert.equal(error.code, 'UPSTREAM_ERROR');
      assert.equal(error.details.upstreamStatus, status);
      assert.ok(!JSON.stringify(error).includes('secret-token'));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('network failure does not retry', async () => {
  let calls = 0;
  await rejectsCode(new ModelClient(config, async () => { calls++; throw new Error('secret'); }).call(input()), 'PROXY_UNAVAILABLE');
  assert.equal(calls, 1);
});

test('invalid/empty output fails; truncation stays incomplete; usage is normalized', async () => {
  await rejectsCode(new ModelClient(config, async () => new Response('not JSON')).call(input()), 'INVALID_UPSTREAM_RESPONSE');
  await rejectsCode(new ModelClient(config, async () => json({ error: 'secret' })).call(input()), 'INVALID_UPSTREAM_RESPONSE');
  await rejectsCode(new ModelClient(config, async () => json(completion({ choices: [{ message: { content: null }, finish_reason: 'length' }] }))).call(input()), 'EMPTY_OUTPUT');
  await rejectsCode(new ModelClient(config, async () => json(completion({ choices: [{ message: { content: 'x' }, finish_reason: 'tool_calls' }] }))).call(input()), 'UNEXPECTED_FINISH');
  const result = await new ModelClient(config, async () => json(completion({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }))).call(input());
  assert.equal(result.status, 'incomplete');
  assert.ok(result.warnings.length);
  assert.equal(result.usage.totalTokens, 10);
  assert.equal(result.usage.reasoningTokens, null);
});

test('bounded concurrency rejects excess calls and releases capacity', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = new ModelClient({ ...config, maxConcurrentCalls: 1 }, async () => { await gate; return json(completion()); });
  const pending = client.call(input());
  await rejectsCode(client.call(input()), 'LOCAL_BUSY');
  release(); await pending;
  assert.equal((await client.call(input())).status, 'completed');
});

test('timeout also covers reading body, cancels fetch, no automatic retry', async () => {
  let calls = 0;
  let sawAbort = false;
  const client = new ModelClient({ ...config, timeoutMs: 80 }, async (_, options) => {
    calls++;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        options.signal.addEventListener('abort', () => {
          sawAbort = true;
          controller.error(options.signal.reason);
        }, { once: true });
      },
    });
    return new Response(stream, { headers: { 'content-type': 'application/json' } });
  });
  // AbortSignal.timeout() intentionally uses an unref'ed timer in Node.  Keep
  // this deterministic in the test while the response body is stalled.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await rejectsCode(client.call(input()), 'UPSTREAM_TIMEOUT');
    assert.equal(calls, 1);
    assert.equal(sawAbort, true);
  } finally {
    clearInterval(keepAlive);
  }
});

test('HTTP route integration: health/catalog are free, origin/host/header/body guarded', async () => {
  let calls = 0;
  const app = await createApp(config, async () => { calls++; return json(completion()); });
  const server = app.getHttpAdapter().getInstance();
  try {
    const health = await server.inject({ url: '/healthz', headers });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().modelAvailabilityChecked, false);
    const list = await server.inject({ url: '/api/models', headers });
    assert.equal(list.json().models.length, 14); assert.equal(calls, 0);
    for (const blockedHeaders of [{ host: 'evil.example' }, { ...headers, origin: 'https://evil.example' }, { host: '127.0.0.1' }]) {
      const response = await server.inject({ method: 'POST', url: '/api/model-calls', headers: blockedHeaders, payload: input() });
      assert.equal(response.statusCode, 403);
    }
    const invalid = await server.inject({ method: 'POST', url: '/api/model-calls', headers, payload: { bad: true } });
    assert.equal(invalid.statusCode, 400); assert.equal(calls, 0);
    const success = await server.inject({ method: 'POST', url: '/api/model-calls', headers, payload: input() });
    assert.equal(success.statusCode, 200); assert.equal(success.json().text, 'OK'); assert.equal(calls, 1);
    const oversized = await server.inject({ method: 'POST', url: '/api/model-calls', headers, payload: input({ messages: [{ role: 'user', content: 'a'.repeat(11 * 1024 * 1024) }] }) });
    assert.equal(oversized.statusCode, 413); assert.equal(calls, 1);
  } finally { await app.close(); }
});

test('example env contains no credentials and smoke requires explicit paid opt-in', () => {
  const env = readFileSync('.env.example', 'utf8');
  assert.ok(!/^(?:.*KEY|.*TOKEN|.*EMAIL|.*COOKIE)=/m.test(env));
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['scripts/model-smoke.mjs'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--allow-paid/);
});
