import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import type { Database } from "../../db/client.js";
import { AssetMediaRepairWorker } from "./mediaRepairWorker.js";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
test("asset repair worker defaults closed and does not revive or claim historical tasks", async () => {
  const calls = { requeue: 0, selfHeal: 0, claim: 0 };
  const worker = new AssetMediaRepairWorker({} as Database, logger, {
    async requeueInterrupted() {
      calls.requeue += 1;
      return 0;
    },
    async enqueueSelfHealCandidates() {
      calls.selfHeal += 1;
      return 0;
    },
    async processNextQueued() {
      calls.claim += 1;
      return true;
    },
  });

  worker.start();
  await worker.stop();

  assert.deepEqual(calls, { requeue: 0, selfHeal: 0, claim: 0 });
});

test("asset repair worker does not requeue, self-heal, or claim while execution is disabled", async () => {
  const calls = { requeue: 0, selfHeal: 0, claim: 0 };
  const worker = createWorker(calls, () => false);

  worker.start();
  worker.kick();
  await worker.stop();

  assert.deepEqual(calls, { requeue: 0, selfHeal: 0, claim: 0 });
});

test("asset repair worker requeues, self-heals, and claims queued work when execution is enabled", async () => {
  const calls = { requeue: 0, selfHeal: 0, claim: 0 };
  const events = new EventEmitter();
  const requeued = once(events, "requeue");
  const selfHealed = once(events, "selfHeal");
  const claimed = once(events, "claim");
  const worker = createWorker(calls, () => true, () => false, {
    onRequeue: () => events.emit("requeue"),
    onSelfHeal: () => events.emit("selfHeal"),
    onClaim: () => events.emit("claim"),
  });

  worker.start();
  await Promise.all([requeued, selfHealed, claimed]);
  await worker.stop();

  assert.deepEqual(calls, { requeue: 1, selfHeal: 1, claim: 1 });
});

test("asset repair worker stops claiming after execution is revoked", async () => {
  const calls = { requeue: 0, selfHeal: 0, claim: 0 };
  const events = new EventEmitter();
  const claimed = once(events, "claim");
  let enabled = true;
  const worker = createWorker(calls, () => enabled, () => {
    enabled = false;
    return true;
  }, { onClaim: () => events.emit("claim") });

  worker.start();
  await claimed;
  await worker.stop();

  assert.equal(calls.claim, 1);
});

test("asset repair worker resumes claiming on the queue poll after execution is re-enabled", async () => {
  const calls = { requeue: 0, selfHeal: 0, claim: 0 };
  const events = new EventEmitter();
  const claimed = once(events, "claim");
  let enabled = false;
  const worker = new AssetMediaRepairWorker({} as Database, logger, {
    async requeueInterrupted() {
      calls.requeue += 1;
      return 0;
    },
    async enqueueSelfHealCandidates() {
      calls.selfHeal += 1;
      return 0;
    },
    async processNextQueued() {
      calls.claim += 1;
      enabled = false;
      events.emit("claim");
      return false;
    },
  }, {
    executionEnabled: () => enabled,
    queuePollIntervalMs: 5,
    selfHealScanIntervalMs: 60_000,
  });

  worker.start();
  // start() while disabled schedules no service work; the poll timers are the
  // only pending callbacks and must drive the resume below.
  assert.deepEqual(calls, { requeue: 0, selfHeal: 0, claim: 0 });

  enabled = true;
  await withinPollBudget(() => claimed);
  await worker.stop();

  assert.deepEqual(calls, { requeue: 0, selfHeal: 0, claim: 1 });
});

const POLL_RESUME_BUDGET_MS = 5_000;

/**
 * Both poll timers are unref'd on purpose: a production worker must not keep
 * the process alive. In the node:test child process that leaves only unref'd
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
      () => reject(new Error(`claim did not resume within ${POLL_RESUME_BUDGET_MS}ms (queue poll timer never fired?)`)),
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
  calls: { requeue: number; selfHeal: number; claim: number },
  executionEnabled?: () => boolean,
  processNextQueued: () => boolean = () => true,
  callbacks: { onRequeue?: () => void; onSelfHeal?: () => void; onClaim?: () => void } = {},
): AssetMediaRepairWorker {
  return new AssetMediaRepairWorker({} as Database, logger, {
    async requeueInterrupted() {
      calls.requeue += 1;
      callbacks.onRequeue?.();
      return 0;
    },
    async enqueueSelfHealCandidates() {
      calls.selfHeal += 1;
      callbacks.onSelfHeal?.();
      return 0;
    },
    async processNextQueued() {
      calls.claim += 1;
      callbacks.onClaim?.();
      return processNextQueued();
    },
  }, {
    executionEnabled,
    queuePollIntervalMs: 60_000,
    selfHealScanIntervalMs: 60_000,
  });
}
