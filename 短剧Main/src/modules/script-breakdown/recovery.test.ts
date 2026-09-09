import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import {
  SCRIPT_BREAKDOWN_STALE_AFTER_MS,
  ScriptBreakdownRecoveryWorker,
} from "./recovery.js";

test("恢复 worker 以五分钟窗口回收并透传固定 now", async () => {
  const calls: Array<{ cutoff: Date; now: Date }> = [];
  const logs: unknown[] = [];
  const worker = new ScriptBreakdownRecoveryWorker(
    () => ({} as Database),
    {
      info(value: unknown) { logs.push(value); },
      error(value: unknown) { logs.push(value); },
    },
    () => ({
      async reclaimStaleRuns(input) {
        calls.push(input);
        return 2;
      },
    }),
  );
  const now = new Date("2026-08-03T10:00:00.000Z");

  assert.equal(await worker.runOnce(now), 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.now, now);
  assert.equal(calls[0]!.cutoff.getTime(), now.getTime() - SCRIPT_BREAKDOWN_STALE_AFTER_MS);
  assert.ok(logs.some((value) => typeof value === "object" && value !== null));
});
