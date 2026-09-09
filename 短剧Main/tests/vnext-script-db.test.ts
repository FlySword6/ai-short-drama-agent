import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { settings } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import { quoteIdentifier, runMigrations } from "../src/db/migrate.js";
import { createAuthenticationHook } from "../src/http/authenticate.js";
import { toHttpErrorResponse } from "../src/http/errorResponse.js";
import { hashSessionToken } from "../src/modules/auth/service.js";
import { FixedScriptDraftProvider } from "../src/modules/vnext/script/provider.js";
import { VnextScriptService } from "../src/modules/vnext/script/service.js";
import {
  ScriptProviderPartialError,
  ScriptProviderTimeoutError,
  ScriptProviderUnavailableError,
  type ScriptDraftProvider,
} from "../src/modules/vnext/script/types.js";
import { registerVnextRoutes } from "../src/modules/vnext/routes.js";
import { VnextProjectService } from "../src/modules/vnext/service.js";

const databaseUrl = process.env.VNEXT_SCRIPT_TEST_DATABASE_URL;
const fixedScript = [
  "第1场 夜 外 天台",
  "林岚：你终于来了。",
  "顾川转身望向城市灯火。",
  "第2场 日 内 旧书店",
  "顾川：答案一直在这里。",
].join("\n");

test("vNext 剧本到正式分镜：真实 PostgreSQL、API、错误恢复与确认幂等", { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  assert.ok(["127.0.0.1", "localhost", "db"].includes(new URL(databaseUrl).hostname));
  const handle = createDatabase(databaseUrl);
  const appSchema = quoteIdentifier(settings.postgresSchema);
  try {
    await handle.pool.query("DROP SCHEMA IF EXISTS vnext CASCADE");
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${appSchema} CASCADE`);
    const applied = await runMigrations(handle);
    assert.ok(applied.includes("vnext/004_script_shot_plan.sql"));

    const actor = { id: randomUUID(), role: "member" as const };
    const project = await new VnextProjectService(handle.db).createProject(actor, "剧本分镜验收");
    const fixedProvider = new FixedScriptDraftProvider();
    const service = new VnextScriptService(handle.db, fixedProvider);
    const created = await service.createRun(actor, {
      projectId: project.id,
      sourceKind: "paste",
      scriptContent: fixedScript,
      clientIdempotencyKey: "db-happy-import",
    });
    assert.equal(created.created, true);
    assert.equal(created.run.status, "queued");
    assert.deepEqual(await formalCounts(handle, project.id), [0, 0, 0], "确认前不得出现正式事实");

    await service.executeRun(created.run.id);
    const draftState = await service.workbench(actor, project.id);
    assert.equal(draftState.run?.status, "draft");
    assert.ok(draftState.run?.draft?.shots.every((shot) => (
      shot.shotSize && shot.cameraMovement && shot.action && shot.rhythm && shot.dialogue && shot.sound
    )));
    assert.deepEqual(await formalCounts(handle, project.id), [0, 0, 0], "生成草稿仍不得写正式事实");

    const first = await service.confirm(actor, created.run.id, "db-confirm-once");
    const second = await service.confirm(actor, created.run.id, "db-confirm-duplicate");
    assert.equal(second.confirmationId, first.confirmationId, "重复确认必须返回同一个正式化结果");
    assert.deepEqual(await formalCounts(handle, project.id), [
      first.characters.length,
      first.scenes.length,
      first.shots.length,
    ]);
    const restored = await new VnextScriptService(handle.db, fixedProvider).workbench(actor, project.id);
    assert.equal(restored.run?.status, "confirmed");
    assert.equal(restored.formalFacts?.confirmationId, first.confirmationId);

    const concurrencyProject = await new VnextProjectService(handle.db).createProject(actor, "并发导入验收");
    const concurrentCreates = await Promise.all(Array.from({ length: 12 }, () => service.createRun(actor, {
      projectId: concurrencyProject.id,
      sourceKind: "paste",
      scriptContent: fixedScript,
      clientIdempotencyKey: "db-concurrent-import",
    })));
    assert.equal(
      concurrentCreates.filter((result) => result.created).length,
      1,
      "同一幂等键的并发导入只能创建一个 run",
    );
    assert.equal(
      new Set(concurrentCreates.map((result) => result.run.id)).size,
      1,
      "所有并发重复请求必须重放同一个 run",
    );
    const concurrentRows = await handle.pool.query<{ runs: number; sources: number }>(
      `SELECT
        count(*)::int AS runs,
        count(DISTINCT source_id)::int AS sources
       FROM vnext.script_parse_runs
       WHERE project_id=$1 AND client_idempotency_key=$2`,
      [concurrencyProject.id, "db-concurrent-import"],
    );
    assert.deepEqual(concurrentRows.rows[0], { runs: 1, sources: 1 });

    const validDraft = (await fixedProvider.analyze({
      scriptContent: fixedScript,
      actorId: actor.id,
      runId: created.run.id,
    })).draft;
    const duplicateScenePositions = {
      ...(validDraft as Record<string, unknown>),
      scenes: (validDraft as { scenes: Array<Record<string, unknown>> }).scenes.map(
        (scene, index, scenes) => index === 1 ? { ...scene, position: scenes[0]!.position } : scene,
      ),
    };
    const overCapWarnings = Array.from({ length: 150 }, (_, index) => `provider warning ${index}`);
    const overCapDiagnostics = Array.from({ length: 100 }, (_, index) => `partial diagnostic ${index}`);
    let overCapAnalyzeCalls = 0;
    const overCapService = new VnextScriptService(handle.db, {
      analyze: async () => {
        overCapAnalyzeCalls += 1;
        throw new ScriptProviderPartialError(
          "partial diagnostics exceed durable limit",
          { ...(validDraft as Record<string, unknown>), warnings: overCapWarnings },
          overCapDiagnostics,
        );
      },
    });
    const overCapRun = await overCapService.createRun(actor, {
      projectId: project.id,
      sourceKind: "paste",
      scriptContent: fixedScript,
      clientIdempotencyKey: "fault-partial-over-cap",
    });
    await overCapService.executeRun(overCapRun.run.id);
    const persistedOverCap = await handle.pool.query<{ status: string; diagnostics: number }>(
      `SELECT status, jsonb_array_length(draft->'warnings')::int AS diagnostics
       FROM vnext.script_parse_runs WHERE id=$1`,
      [overCapRun.run.id],
    );
    assert.deepEqual(
      persistedOverCap.rows[0],
      { status: "partial_failure", diagnostics: 200 },
      "超过 200 条的合并诊断必须先截断再持久化",
    );
    const recoveredOverCap = await new VnextScriptService(handle.db, {
      analyze: async () => {
        overCapAnalyzeCalls += 1;
        throw new Error("refresh recovery must not execute the provider");
      },
    }).workbench(actor, project.id);
    assert.equal(recoveredOverCap.run?.id, overCapRun.run.id);
    assert.equal(recoveredOverCap.run?.draft?.warnings.length, 200, "响应中的诊断也不得超过 200 条");
    assert.equal(overCapAnalyzeCalls, 1, "刷新恢复持久化失败时不得重新执行 AI gateway");

    const faults: Array<[string, ScriptDraftProvider, string, boolean]> = [
      ["unavailable", { analyze: async () => { throw new ScriptProviderUnavailableError(); } }, "script_model_unavailable", true],
      ["timeout", { analyze: async () => { throw new ScriptProviderTimeoutError(); } }, "script_parse_timeout", true],
      ["schema", { analyze: async () => ({ draft: { broken: true } }) }, "script_schema_validation_failed", true],
      ["duplicate-position", { analyze: async () => ({ draft: duplicateScenePositions }) }, "script_schema_validation_failed", true],
      ["partial", {
        analyze: async () => {
          throw new ScriptProviderPartialError(
            "partial",
            validDraft,
            [
              `第二场环境音：${"长诊断甲".repeat(35)}`,
              `第三场对白：${"长诊断乙".repeat(35)}`,
            ],
          );
        },
      }, "script_partial_failure", true],
    ];
    for (const [name, provider, errorCode, retryable] of faults) {
      const faultService = new VnextScriptService(handle.db, provider);
      const run = await faultService.createRun(actor, {
        projectId: project.id,
        sourceKind: "upload",
        fileName: `${name}.txt`,
        scriptContent: fixedScript,
        clientIdempotencyKey: `fault-${name}`,
      });
      await faultService.executeRun(run.run.id);
      const failed = await handle.pool.query<{
        status: string; error_code: string; error_message: string; error_retryable: boolean; draft: unknown;
      }>(
        "SELECT status, error_code, error_message, error_retryable, draft FROM vnext.script_parse_runs WHERE id=$1",
        [run.run.id],
      );
      assert.equal(failed.rows[0]?.error_code, errorCode);
      assert.equal(failed.rows[0]?.error_retryable, retryable);
      assert.equal(Boolean(failed.rows[0]?.draft), name === "partial");
      if (name === "partial") {
        assert.ok(failed.rows[0]!.error_message.length < 255);
        const warnings = (failed.rows[0]!.draft as { warnings: string[] }).warnings;
        assert.equal(warnings.length, 2);
        assert.match(warnings[0]!, /第二场环境音/u);
        assert.match(warnings[1]!, /第三场对白/u);
        assert.ok(warnings.join("；").length > 255, "多条完整诊断必须超过旧 error_message 上限");
      }
      const reset = await faultService.retry(actor, run.run.id);
      assert.equal(reset.run.status, "queued", `${name} 应能从持久化失败状态恢复`);
      assert.equal(reset.outcome, "created");
    }

    await verifyHttpContract(handle, appSchema);
    await verifyAtomicRetryHttp(handle, appSchema);
    const sourceColumns = await handle.pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='vnext' AND table_name='generation_telemetry_events'",
    );
    assert.ok(!sourceColumns.rows.some((row) => /script|prompt|content/iu.test(row.column_name)));
  } finally {
    await handle.pool.query("DROP SCHEMA IF EXISTS vnext CASCADE").catch(() => undefined);
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${appSchema} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

async function verifyAtomicRetryHttp(
  handle: ReturnType<typeof createDatabase>,
  appSchema: string,
): Promise<void> {
  const userId = randomUUID();
  const token = `vnext-script-retry-${randomUUID()}`;
  await handle.pool.query(
    `INSERT INTO ${appSchema}.users (id, username, display_name, password_hash)
     VALUES ($1, $2, '剧本并发重试验收', 'test-only')`,
    [userId, `vnext-script-retry-${randomUUID()}`],
  );
  await handle.pool.query(
    `INSERT INTO ${appSchema}.sessions (id, user_id, token_hash, credential_source, expires_at)
     VALUES ($1, $2, $3, 'web', now() + interval '1 hour')`,
    [randomUUID(), userId, hashSessionToken(token)],
  );
  const fixedProvider = new FixedScriptDraftProvider();
  let analyzeCalls = 0;
  const provider: ScriptDraftProvider = {
    analyze: async (input) => {
      analyzeCalls += 1;
      if (analyzeCalls === 1) throw new ScriptProviderUnavailableError();
      return fixedProvider.analyze(input);
    },
  };
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const { statusCode, body } = toHttpErrorResponse(error);
    return reply.code(statusCode).send({ ok: false, error: body });
  });
  app.addHook("preHandler", createAuthenticationHook(() => handle.db));
  await registerVnextRoutes(app, () => handle.db, {
    createScriptService: (db) => new VnextScriptService(db, provider),
  });
  const headers = { authorization: `Bearer ${token}` };
  try {
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/vnext/projects",
      headers,
      payload: { name: "并发重试项目" },
    });
    assert.equal(projectResponse.statusCode, 201);
    const projectId = projectResponse.json().data.id as string;
    const created = await app.inject({
      method: "POST",
      url: `/api/vnext/projects/${projectId}/script-runs`,
      headers,
      payload: {
        source_kind: "paste",
        script_content: fixedScript,
        client_idempotency_key: "api-retry-race-import",
      },
    });
    assert.equal(created.statusCode, 202);
    const runId = created.json().data.run.id as string;
    await waitForRunStatus(handle, runId, "failed");
    await new Promise<void>((resolve) => setImmediate(resolve));

    const retries = await Promise.all([
      app.inject({ method: "POST", url: `/api/vnext/script-runs/${runId}/retry`, headers }),
      app.inject({ method: "POST", url: `/api/vnext/script-runs/${runId}/retry`, headers }),
    ]);
    assert.deepEqual(
      retries.map((response) => response.statusCode).sort(),
      [200, 202],
      "并发 retry 必须只有一个请求赢得状态转换",
    );
    assert.deepEqual(
      retries.map((response) => response.json().data.outcome).sort(),
      ["created", "replayed"],
      "API 必须明确区分状态转换赢家和重放请求",
    );

    await waitForRunStatus(handle, runId, "draft");
    assert.equal(analyzeCalls, 2, "首次失败加一次重试只能调用 provider 两次");
  } finally {
    await app.close();
  }
}

async function waitForRunStatus(
  handle: ReturnType<typeof createDatabase>,
  runId: string,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await handle.pool.query<{ status: string }>(
      "SELECT status FROM vnext.script_parse_runs WHERE id=$1",
      [runId],
    );
    if (result.rows[0]?.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`run ${runId} did not reach ${expected}`);
}

async function verifyHttpContract(
  handle: ReturnType<typeof createDatabase>,
  appSchema: string,
): Promise<void> {
  const userId = randomUUID();
  const token = `vnext-script-${randomUUID()}`;
  await handle.pool.query(
    `INSERT INTO ${appSchema}.users (id, username, display_name, password_hash)
     VALUES ($1, $2, '剧本 API 验收', 'test-only')`,
    [userId, `vnext-script-${randomUUID()}`],
  );
  await handle.pool.query(
    `INSERT INTO ${appSchema}.sessions (id, user_id, token_hash, credential_source, expires_at)
     VALUES ($1, $2, $3, 'web', now() + interval '1 hour')`,
    [randomUUID(), userId, hashSessionToken(token)],
  );
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const { statusCode, body } = toHttpErrorResponse(error);
    return reply.code(statusCode).send({ ok: false, error: body });
  });
  app.addHook("preHandler", createAuthenticationHook(() => handle.db));
  await registerVnextRoutes(app, () => handle.db, {
    createScriptService: (db) => new VnextScriptService(db, new FixedScriptDraftProvider()),
  });
  const headers = { authorization: `Bearer ${token}` };
  try {
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/vnext/projects",
      headers,
      payload: { name: "API 剧本项目" },
    });
    assert.equal(projectResponse.statusCode, 201);
    const projectId = projectResponse.json().data.id as string;
    const created = await app.inject({
      method: "POST",
      url: `/api/vnext/projects/${projectId}/script-runs`,
      headers,
      payload: {
        source_kind: "paste",
        script_content: fixedScript,
        client_idempotency_key: "api-import",
      },
    });
    assert.equal(created.statusCode, 202);
    const runId = created.json().data.run.id as string;
    let state: Record<string, any> | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const response = await app.inject({
        method: "GET",
        url: `/api/vnext/projects/${projectId}/script-workbench`,
        headers,
      });
      assert.equal(response.statusCode, 200);
      state = response.json().data;
      if (state?.run?.status === "draft") break;
    }
    assert.equal(state?.run?.status, "draft");
    assert.equal(state?.formal_facts, null);
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/vnext/script-runs/${runId}/confirm`,
      headers,
      payload: { client_idempotency_key: "api-confirm" },
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/vnext/script-runs/${runId}/confirm`,
      headers,
      payload: { client_idempotency_key: "api-confirm-replay" },
    });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(
      duplicate.json().data.formal_facts.confirmation_id,
      confirmed.json().data.formal_facts.confirmation_id,
    );
    const anonymous = await app.inject({
      method: "GET",
      url: `/api/vnext/projects/${projectId}/script-workbench`,
    });
    assert.equal(anonymous.statusCode, 401);
  } finally {
    await app.close();
  }
}

async function formalCounts(
  handle: ReturnType<typeof createDatabase>,
  projectId: string,
): Promise<[number, number, number]> {
  const result = await handle.pool.query<{ characters: number; scenes: number; shots: number }>(
    `SELECT
      (SELECT count(*)::int FROM vnext.shot_plan_characters WHERE project_id=$1) AS characters,
      (SELECT count(*)::int FROM vnext.shot_plan_scenes WHERE project_id=$1) AS scenes,
      (SELECT count(*)::int FROM vnext.shot_plan_shots WHERE project_id=$1) AS shots`,
    [projectId],
  );
  const row = result.rows[0]!;
  return [row.characters, row.scenes, row.shots];
}
