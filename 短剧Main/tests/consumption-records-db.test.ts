import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  agentMessages,
  agentSessions,
  episodes,
  generationAttempts,
  generationRequests,
  projects,
  shots,
  users,
} from "../src/db/schema.js";
import { DrizzleConsumptionRecordsRepository } from "../src/modules/consumption-records/repository.js";

const databaseUrl = process.env.CONSUMPTION_RECORDS_TEST_DATABASE_URL;

test("消耗逐笔明细只显示项目可见任务、最新重试和正式积分", {
  skip: !databaseUrl,
}, async () => withFixture(async ({ handle, ownerId, otherId, projectId }) => {
  const repository = new DrizzleConsumptionRecordsRepository(handle.db);
  const global = await repository.list(ownerId, { page: 1, pageSize: 20 });
  assert.equal(global.total, 2, "图片请求 + 有正式积分的 AI 记录");
  assert.deepEqual(global.records.map((item) => [item.taskType, item.modelDisplayName, item.points]), [
    ["ai_assist", "Doubao Seed", 7],
    ["image", "Seedream 5", 66],
  ]);
  assert.equal(global.records[0]?.episodeNo, null);
  assert.equal(global.records[1]?.episodeNo, 1);
  assert.equal(global.records[1]?.promptExcerpt.length, 80);

  const project = await repository.list(ownerId, {
    projectId,
    taskType: "image",
    model: "Seedream 5",
    page: 1,
    pageSize: 20,
  });
  assert.equal(project.total, 1);
  assert.equal(project.records[0]?.points, 66, "确认后的实际成本优先，且同一任务重试后只计当前 attempt");

  const beyondLastPage = await repository.list(ownerId, { page: 2, pageSize: 20 });
  assert.equal(beyondLastPage.records.length, 0);
  assert.equal(beyondLastPage.total, 2, "超出末页不能把真实总数错误归零");

  await assert.rejects(
    repository.list(otherId, { projectId, page: 1, pageSize: 20 }),
    (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 403,
  );
}));

interface Fixture {
  handle: DatabaseHandle;
  ownerId: string;
  otherId: string;
  projectId: string;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const projectId = randomUUID();
  const episodeId = randomUUID();
  const shotId = randomUUID();
  const requestId = randomUUID();
  const sessionId = randomUUID();
  const ids = { attemptFirst: randomUUID(), attemptCurrent: randomUUID(), messagePaid: randomUUID(), messageFree: randomUUID() };
  const now = new Date("2026-07-22T00:00:00.000Z");
  try {
    await handle.db.insert(users).values([
      { id: ownerId, username: `consumption-owner-${ownerId.slice(0, 8)}`, displayName: "项目所有者", passwordHash: "test", active: true, createdAt: now, updatedAt: now },
      { id: otherId, username: `consumption-other-${otherId.slice(0, 8)}`, displayName: "其他用户", passwordHash: "test", active: true, createdAt: now, updatedAt: now },
    ]);
    await handle.db.insert(projects).values({
      id: projectId, ownerUserId: ownerId, name: "消耗测试项目", description: null, status: "active", createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(episodes).values({
      id: episodeId, projectId, episodeNo: 1, name: "第一集", sortOrder: 0, status: "active", createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(shots).values({
      id: shotId, episodeId, sceneId: null, shotCode: "S01", title: null, scriptText: null,
      directorPrompt: null, imagePrompt: null, videoPrompt: null, durationSeconds: null, sortOrder: 0,
      referenceAssetSnapshots: [], selectedImageResultId: null, selectedVideoResultId: null,
      createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
    });
    await handle.db.insert(generationRequests).values({
      id: requestId, userId: ownerId, projectId, episodeId, sceneId: null, shotId, targetAssetEntityId: null,
      mediaKind: "image", prompt: "雨夜巷口".repeat(30), referenceMediaIds: [], referenceAssetSnapshots: [], parameters: {}, quantity: 1,
      clientIdempotencyKey: `consumption-${requestId}`, requestHash: "a".repeat(64), createdAt: new Date("2026-07-22T01:00:00.000Z"), updatedAt: now,
    });
    await handle.db.insert(generationAttempts).values([
      { id: ids.attemptFirst, requestId, attemptNo: 1, retryIdempotencyKey: null, provider: "ark", providerTaskId: null, model: "Seedream 5", parameters: {}, quantity: 1, status: "failed", phase: "complete", providerStatus: null, providerResponse: null, errorCode: null, errorMessage: null, retryable: true, estimatedCostFen: 22, actualCostFen: null, actualCostStatus: "unavailable", pricingRuleId: null, priceSnapshot: {}, lastQueryError: null, nextPollAt: null, lastPolledAt: null, leaseOwner: null, leaseUntil: null, submittedAt: null, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now },
      { id: ids.attemptCurrent, requestId, attemptNo: 2, retryIdempotencyKey: `retry-${requestId}`, provider: "ark", providerTaskId: null, model: "Seedream 5", parameters: {}, quantity: 1, status: "succeeded", phase: "complete", providerStatus: null, providerResponse: null, errorCode: null, errorMessage: null, retryable: false, estimatedCostFen: 88, actualCostFen: 66, actualCostStatus: "confirmed", pricingRuleId: null, priceSnapshot: {}, lastQueryError: null, nextPollAt: null, lastPolledAt: null, leaseOwner: null, leaseUntil: null, submittedAt: null, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now },
    ]);
    await handle.db.insert(agentSessions).values({
      id: sessionId,
      userId: ownerId,
      authSessionId: null,
      agentType: "platform_assistant",
      userAgent: "consumption-records-db-test",
      projectId,
      shotId: null,
      title: "AI 助手",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    await handle.db.insert(agentMessages).values([
      { id: ids.messagePaid, sessionId, role: "assistant", content: "已完成素材检索", toolName: null, toolArguments: null, toolResultSummary: null, status: "completed", provider: "ark", model: "Doubao Seed", usage: null, providerCostUsdMicros: null, pointsSpent: 7, durationMs: null, errorSummary: null, createdAt: new Date("2026-07-22T02:00:00.000Z") },
      { id: ids.messageFree, sessionId, role: "assistant", content: "未记账消息", toolName: null, toolArguments: null, toolResultSummary: null, status: "completed", provider: "ark", model: "Doubao Seed", usage: null, providerCostUsdMicros: null, pointsSpent: null, durationMs: null, errorSummary: null, createdAt: new Date("2026-07-22T03:00:00.000Z") },
    ]);
    await run({ handle, ownerId, otherId, projectId });
  } finally {
    await handle.db.delete(agentMessages).where(inArray(agentMessages.id, Object.values(ids).filter((id) => id !== ids.attemptFirst && id !== ids.attemptCurrent)));
    await handle.db.delete(agentSessions).where(eq(agentSessions.id, sessionId));
    await handle.db.delete(generationAttempts).where(inArray(generationAttempts.id, [ids.attemptFirst, ids.attemptCurrent]));
    await handle.db.delete(generationRequests).where(eq(generationRequests.id, requestId));
    await handle.db.delete(shots).where(eq(shots.id, shotId));
    await handle.db.delete(episodes).where(eq(episodes.id, episodeId));
    await handle.db.delete(projects).where(eq(projects.id, projectId));
    await handle.db.delete(users).where(inArray(users.id, [ownerId, otherId]));
    await handle.pool.end();
  }
}
