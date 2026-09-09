import assert from "node:assert/strict";
import test from "node:test";
import { ControlPackageService } from "../src/modules/vnext/control-packages/service.js";
import type { ControlPackage, ControlPackageDraft } from "../src/modules/vnext/control-packages/types.js";
import { GenerationIntentService } from "../src/modules/vnext/generation-intents/service.js";
import type { PendingGenerationIntent } from "../src/modules/vnext/generation-intents/types.js";

const actorId = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const projectId = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const versionOne = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const versionTwo = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";

class Packages {
  value: ControlPackage | null = null;
  async latest(): Promise<ControlPackage | null> { return this.value; }
  async write(input: ControlPackageDraft & { projectId: string; actorId: string }): Promise<ControlPackage> {
    this.value = { id: `package-${(this.value?.version ?? 0) + 1}`, projectId: input.projectId, version: (this.value?.version ?? 0) + 1, createdByUserId: input.actorId, createdAt: "2026-08-16T00:00:00.000Z", ...input };
    return this.value;
  }
}
class Intents {
  readonly values = new Map<string, PendingGenerationIntent>();
  async latest(project: string, actor: string): Promise<PendingGenerationIntent | null> { return [...this.values.values()].filter((intent) => intent.projectId === project && intent.actorId === actor).at(-1) ?? null; }
  async create(input: Omit<PendingGenerationIntent, "id" | "createdAt">): Promise<{ intent: PendingGenerationIntent; created: boolean }> {
    const prior = this.values.get(input.clientIdempotencyKey);
    if (prior) return { intent: prior, created: false };
    const intent: PendingGenerationIntent = { id: `intent-${this.values.size + 1}`, createdAt: "2026-08-16T00:01:00.000Z", ...input };
    this.values.set(input.clientIdempotencyKey, intent);
    return { intent, created: true };
  }
}
const access = { async assertRead(): Promise<void> {}, async assertWrite(): Promise<void> {} };
function draft(overrides: Partial<ControlPackageDraft> = {}): ControlPackageDraft {
  return { references: [
    { referenceId: "r1", referenceVersionId: versionOne, label: "角色参考", reason: "锁定角色外形", position: 0, capabilitySnapshot: { version: "caps-1", capturedAt: "2026-08-16T00:00:00.000Z", capabilities: ["image-reference"] } },
    { referenceId: "r2", referenceVersionId: versionTwo, label: "镜头参考", reason: "锁定镜头语言", position: 1, capabilitySnapshot: { version: "caps-1", capturedAt: "2026-08-16T00:00:00.000Z", capabilities: ["camera-reference"] } },
  ], finalPrompt: "雨夜巷口，人物回望", model: "video-model-v1", parameters: { duration_seconds: 5 }, noBgm: true, modelAvailability: { status: "available", checkedAt: "2026-08-16T00:00:00.000Z" }, estimatedCostFen: 42, ...overrides };
}

test("control package preserves exact ordered versions, override order, reasons, capability snapshots, prompt, model, and no-BGM", async () => {
  const packages = new Packages();
  const service = new ControlPackageService(packages, access);
  const first = await service.save(actorId, projectId, draft());
  const second = await service.save(actorId, projectId, draft({ references: [...draft().references].reverse(), noBgm: false, parameters: { duration_seconds: 5, no_bgm: false } }));
  assert.equal(first.references[0]?.referenceVersionId, versionOne);
  assert.equal(first.references[0]?.reason, "锁定角色外形");
  assert.deepEqual(first.references[0]?.capabilitySnapshot.capabilities, ["image-reference"]);
  assert.equal(second.version, 2);
  assert.deepEqual(second.references.map((reference) => reference.referenceVersionId), [versionTwo, versionOne]);
  assert.deepEqual(second.references.map((reference) => reference.position), [0, 1]);
  assert.equal(second.finalPrompt, "雨夜巷口，人物回望");
  assert.equal(second.model, "video-model-v1");
  assert.equal(second.parameters.no_bgm, false);
  assert.equal(second.noBgm, false);
});

test("unavailable models remain reviewable but fail explicitly before intent persistence; available intents are idempotent and provider-free", async () => {
  const packages = new Packages();
  const control = new ControlPackageService(packages, access);
  await control.save(actorId, projectId, draft({ modelAvailability: { status: "unavailable", checkedAt: "2026-08-16T00:00:00.000Z", reason: "该模型不支持参考视频" } }));
  let checks = 0;
  const intents = new GenerationIntentService(new Intents(), packages, access, { async assertBudgetAndAccountAccess(user, project, cost) { checks += 1; assert.equal(user, actorId); assert.equal(project, projectId); assert.equal(cost, 42); }, async assertReferenceAssetAccess(user, project, versions) { assert.equal(user, actorId); assert.equal(project, projectId); assert.deepEqual(versions, [versionOne, versionTwo]); } });
  await assert.rejects(intents.createPending(actorId, projectId, "blocked-key"), { code: "model_unavailable" });
  assert.equal(checks, 0);
  await control.save(actorId, projectId, draft());
  const first = await intents.createPending(actorId, projectId, "stable-confirmation-key");
  const replay = await intents.createPending(actorId, projectId, "stable-confirmation-key");
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(first.intent.status, "pending_confirmation");
  assert.equal(first.intent.controlPackageVersion, 2);
  assert.equal(first.intent.noBgm, true);
  assert.equal(checks, 2);
});
