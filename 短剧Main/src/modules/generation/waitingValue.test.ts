import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ETA_MINIMUM_SAMPLE_COUNT,
  medianEstimatedDurationSeconds,
  recoverableAttemptOrderBy,
} from "./repository.js";
import { generationAttemptNotificationData, generationData } from "./routes.js";
import type { GenerationAttemptNotificationView, GenerationView } from "./types.js";

const now = new Date("2026-07-26T08:00:00.000Z");

test("S29 ETA uses a median and refuses to invent a duration before five valid samples", () => {
  assert.equal(ETA_MINIMUM_SAMPLE_COUNT, 5);
  assert.equal(medianEstimatedDurationSeconds([10, 20, 30, 40]), null);
  assert.equal(medianEstimatedDurationSeconds([50, 10, 30, 20, 40]), 30);
  assert.equal(medianEstimatedDurationSeconds([60, 10, 20, 40, 30, 50]), 35);
});

test("S29 ETA only pools attempts with the same frozen workload parameters", async () => {
  const source = await readFile(path.resolve("src/modules/generation/repository.ts"), "utf8");
  assert.match(source, /eq\(generationAttempts\.parameters, attempt\.parameters\)/);
});

test("S29 worker claim and queue-position query share the same stable order helper", async () => {
  assert.deepEqual(recoverableAttemptOrderBy().map((column) => column.name), [
    "next_poll_at",
    "created_at",
    "id",
  ]);
  const source = await readFile(path.resolve("src/modules/generation/repository.ts"), "utf8");
  assert.equal((source.match(/orderBy\(\.\.\.recoverableAttemptOrderBy\(\)\)/g) ?? []).length, 2);
  assert.equal((source.match(/recoverableAttemptConditions\(now,/g) ?? []).length, 2);
  assert.equal((source.match(/skipLocked: true/g) ?? []).length, 2);
  assert.match(source, /generationAttempts\.priceSnapshot\} <> '\{\}'::jsonb/);
});

test("S29 progress response preserves an honest null ETA and identifies local queue position", () => {
  const view: GenerationView = {
    requestId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    projectId: "44444444-4444-4444-8444-444444444444",
    status: "pending",
    phase: "created",
    mediaKind: "video",
    model: "seedance-test",
    prompt: "测试提示词",
    parameters: { resolution: "720p", ratio: "9:16", durationSeconds: 4 },
    estimatedCostFen: 300,
    media: [],
    queuePosition: 2,
    estimatedDurationSeconds: null,
    estimatedDurationSampleCount: 3,
    createdAt: now,
    updatedAt: now,
  };
  const data = generationData(view);
  assert.equal(data.queue_position, 2);
  assert.equal(data.estimated_duration_seconds, null);
  assert.equal(data.estimated_duration_sample_count, 3);
});

test("S29 station notification contains routing facts but no frozen notification type", async () => {
  const notification: GenerationAttemptNotificationView = {
    id: "33333333-3333-4333-8333-333333333333",
    requestId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    projectId: "44444444-4444-4444-8444-444444444444",
    episodeId: "55555555-5555-4555-8555-555555555555",
    shotId: "66666666-6666-4666-8666-666666666666",
    targetAssetEntityId: "77777777-7777-4777-8777-777777777777",
    mediaKind: "image",
    status: "succeeded",
    createdAt: now,
  };
  const data = generationAttemptNotificationData(notification);
  assert.equal(data.project_id, notification.projectId);
  assert.equal(data.target_asset_entity_id, notification.targetAssetEntityId);
  assert.equal(data.status, "succeeded");
  assert.equal("notification_type" in data, false);

  const migration = await readFile(path.resolve("migrations/025_generation_waiting_value.sql"), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS \{\{schema\}\}\.generation_attempt_notifications/);
  assert.match(migration, /generation_attempt_notifications_attempt_unique UNIQUE \(attempt_id\)/);
  assert.doesNotMatch(migration, /notification_type/i);

  const schema = await readFile(path.resolve("src/db/schema.ts"), "utf8");
  assert.match(schema, /generation_attempt_notifications_unread_user_created_idx/);
  assert.match(schema, /acknowledgedAt\} is null/);
});

test("生成失败提醒的审计原因只留服务端，公共投影只提供安全展示文案", () => {
  const notification: GenerationAttemptNotificationView = {
    id: "33333333-3333-4333-8333-333333333333",
    requestId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    projectId: "44444444-4444-4444-8444-444444444444",
    mediaKind: "video",
    status: "failed",
    errorMessage: "ProviderError: Ark request failed with HTTP 503",
    createdAt: now,
  };
  const data = generationAttemptNotificationData(notification);
  assert.equal("failure_reason" in data, false);
  assert.equal(data.display_reason, "视频生成没成：生成服务暂时没响应，请稍后重试。");
});
