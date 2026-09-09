import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { AssetUploadWorker, type AssetUploadWorkerService } from "./worker.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
test("asset upload worker defaults closed and leaves historical jobs unclaimed", async () => {
  const calls = { requeue: 0, claim: 0 };
  const service: AssetUploadWorkerService = {
    async requeueInterrupted() {
      calls.requeue += 1;
      return 0;
    },
    async processNextQueued() {
      calls.claim += 1;
      return true;
    },
  };
  const worker = new AssetUploadWorker(service, logger);

  worker.start();
  await worker.stop();

  assert.deepEqual(calls, { requeue: 0, claim: 0 });
});

test("asset upload worker does not requeue or claim while execution is disabled", async () => {
  const calls = { requeue: 0, claim: 0 };
  const worker = createWorker(calls, () => false);

  worker.start();
  worker.kick();
  await worker.stop();

  assert.deepEqual(calls, { requeue: 0, claim: 0 });
});

test("asset upload worker claims queued work when execution is enabled", async () => {
  const calls = { requeue: 0, claim: 0 };
  const events = new EventEmitter();
  const requeued = once(events, "requeue");
  const claimed = once(events, "claim");
  const worker = createWorker(calls, () => true, () => false, () => events.emit("requeue"), () => events.emit("claim"));

  worker.start();
  await Promise.all([requeued, claimed]);
  await worker.stop();

  assert.deepEqual(calls, { requeue: 1, claim: 1 });
});

test("asset upload worker stops claiming after execution is revoked", async () => {
  const calls = { requeue: 0, claim: 0 };
  const events = new EventEmitter();
  const claimed = once(events, "claim");
  let enabled = true;
  const worker = createWorker(calls, () => enabled, () => {
    enabled = false;
    return true;
  }, undefined, () => events.emit("claim"));

  worker.start();
  await claimed;
  await worker.stop();

  assert.equal(calls.claim, 1);
});

test("asset upload worker resumes claiming on the safety poll after execution is re-enabled", async () => {
  const calls = { requeue: 0, claim: 0 };
  const events = new EventEmitter();
  const claimed = once(events, "claim");
  let enabled = false;
  const service: AssetUploadWorkerService = {
    async requeueInterrupted() {
      calls.requeue += 1;
      return 0;
    },
    async processNextQueued() {
      calls.claim += 1;
      enabled = false;
      events.emit("claim");
      return false;
    },
  };
  const worker = new AssetUploadWorker(service, logger, {
    executionEnabled: () => enabled,
    pollIntervalMs: 5,
  });

  worker.start();
  // start() while disabled schedules no service work; the poll timer is the
  // only pending callback and must drive the resume below.
  assert.deepEqual(calls, { requeue: 0, claim: 0 });

  enabled = true;
  await withinPollBudget(() => claimed);
  await worker.stop();

  assert.deepEqual(calls, { requeue: 0, claim: 1 });
});

const POLL_RESUME_BUDGET_MS = 5_000;

/**
 * The poll timer is unref'd on purpose: a production worker must not keep the
 * process alive. In the node:test child process that leaves only unref'd
 * timers pending, so the loop drains at once and `await claimed` never lands —
 * "Promise resolution is still pending but the event loop has already
 * resolved", the exact CI-only red this case used to hit. A ref'd budget timer
 * holds the loop open; if the claim misses the budget it fails fast with a
 * diagnosis instead of hanging or exiting phantom-early.
 */
async function withinPollBudget<T>(wait: () => Promise<T>): Promise<T> {
  let budget: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    budget = setTimeout(
      () => reject(new Error(`claim did not resume within ${POLL_RESUME_BUDGET_MS}ms (poll timer never fired?)`)),
      POLL_RESUME_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([wait(), stalled]);
  } finally {
    clearTimeout(budget);
  }
}

function createWorker(
  calls: { requeue: number; claim: number },
  executionEnabled?: () => boolean,
  processNextQueued: () => boolean = () => true,
  onRequeue?: () => void,
  onClaim?: () => void,
): AssetUploadWorker {
  const service: AssetUploadWorkerService = {
    async requeueInterrupted() {
      calls.requeue += 1;
      onRequeue?.();
      return 0;
    },
    async processNextQueued() {
      calls.claim += 1;
      onClaim?.();
      return processNextQueued();
    },
  };
  return new AssetUploadWorker(service, logger, {
    executionEnabled,
    pollIntervalMs: 60_000,
  });
}
