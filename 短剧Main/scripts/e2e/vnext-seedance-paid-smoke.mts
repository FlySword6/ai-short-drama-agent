import assert from "node:assert/strict";
import { createVnextDatabase } from "../../src/modules/vnext/db.js";
import { createControlPackageProjectAccess } from "../../src/modules/vnext/control-packages/service.js";
import { PendingIntentRepository } from "../../src/modules/vnext/generation-intents/repository.js";
import { createVnextGenerationService } from "../../src/modules/vnext/generation/factory.js";
import { VnextGenerationRepository } from "../../src/modules/vnext/generation/repository.js";

assert.equal(process.env.PAID_SMOKE, "true", "PAID_SMOKE=true is required");
assert.equal(
  process.env.VNEXT_SEEDANCE_PAID_SMOKE_APPROVED,
  "I_UNDERSTAND_THIS_CREATES_ONE_PAID_TASK",
  "explicit paid-smoke approval phrase is required",
);
const projectId = requiredUuid("VNEXT_SEEDANCE_SMOKE_PROJECT_ID");
const actorId = requiredUuid("VNEXT_SEEDANCE_SMOKE_ACTOR_ID");
const handle = createVnextDatabase();
try {
  const intents = new PendingIntentRepository(handle.db);
  const intent = await intents.latest(projectId, actorId);
  assert.ok(intent, "No pending generation intent exists for the designated project and actor");
  const repository = new VnextGenerationRepository(handle.db);
  const service = createVnextGenerationService(
    handle.db,
    intents,
    createControlPackageProjectAccess(handle.db),
  );
  const view = await service.confirmIntent(
    actorId,
    projectId,
    intent.id,
    `seedance25-paid-smoke:${intent.id}`,
  );
  const attemptId = view.latestAttempt?.id;
  assert.ok(attemptId, "Paid smoke task was created without an attempt");
  const workerId = `paid-smoke-${process.pid}`;
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const claimed = await repository.claimNextAttempt(workerId, 120);
    if (claimed === attemptId) {
      await service.runRecoverableAttempt(attemptId, undefined, workerId);
      await repository.releaseLease(attemptId, workerId, 2);
    }
    const current = await repository.getTaskView(view.task.id, projectId);
    assert.ok(current?.latestAttempt, "Paid smoke attempt disappeared");
    if (["succeeded", "failed", "unknown_outcome"].includes(current.latestAttempt.status)) {
      const evidence = {
        task_id: current.task.id,
        attempt_id: current.latestAttempt.id,
        status: current.latestAttempt.status,
        provider_task_present: Boolean(current.latestAttempt.providerTaskId),
        tos_media: current.latestAttempt.tosMedia.map((item) => ({
          bucket: item.storageBucket,
          object_key: item.objectKey,
          sha256: item.sha256,
        })),
        error_code: current.latestAttempt.errorCode,
      };
      console.log(JSON.stringify(evidence, null, 2));
      assert.equal(current.latestAttempt.status, "succeeded", "Paid Seedance smoke did not succeed");
      assert.ok(current.latestAttempt.providerTaskId, "Provider task receipt missing");
      assert.ok(current.latestAttempt.tosMedia.length > 0, "TOS readback receipt missing");
      process.exitCode = 0;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (Date.now() >= deadline) throw new Error("Paid Seedance smoke timed out; do not resubmit automatically");
} finally {
  await handle.pool.end();
}

function requiredUuid(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, `${name} must be a UUID`);
  return value;
}
