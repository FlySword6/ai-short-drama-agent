import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import { WecomTransactionCleanupWorker, type WecomTransactionCleanupRepository } from "./wecomCleanupWorker.js";

const logger = {
  info: () => {},
  error: () => {},
};

test("cleanup worker deletes transactions eligible for 24 hours using an exact cutoff", async () => {
  const cutoffs: Date[] = [];
  const repository: WecomTransactionCleanupRepository = {
    async deleteTerminalWecomAuthTransactions(cutoff) {
      cutoffs.push(cutoff);
      return 7;
    },
  };
  const worker = new WecomTransactionCleanupWorker({} as Database, logger, repository);

  const deleted = await worker.runOnce(new Date("2026-08-22T12:30:00.000Z"));

  assert.equal(deleted, 7);
  assert.deepEqual(cutoffs, [new Date("2026-08-21T12:30:00.000Z")]);
});

test("cleanup worker does not overlap runs", async () => {
  let release: (() => void) | undefined;
  let calls = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const repository: WecomTransactionCleanupRepository = {
    async deleteTerminalWecomAuthTransactions() {
      calls += 1;
      await pending;
      return 0;
    },
  };
  const worker = new WecomTransactionCleanupWorker({} as Database, logger, repository);

  worker.kick();
  worker.kick();
  assert.equal(calls, 1);
  release!();
  await worker.stop();
  assert.equal(calls, 1);
});
