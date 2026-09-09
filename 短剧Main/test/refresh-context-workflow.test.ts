import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../.github/workflows/refresh-context.yml", import.meta.url), "utf8");

test("notification receiver accepts exactly one context or eval commit", () => {
  assert.match(source, /contextSha:/u);
  assert.match(source, /evalSha:/u);
  assert.match(source, /Exactly one of contextSha or evalSha must be provided/u);
  assert.match(source, /\^\[0-9a-f\]\{40\}\$/u);
  assert.ok(source.includes('context) expected_ref="refs/heads/main"'));
  assert.ok(source.includes('eval) expected_ref="refs/heads/dev"'));
  assert.match(source, /source-notification-\$\{\{ github\.ref_name \}\}-\$\{\{ inputs\.contextSha && 'context' \|\| 'eval' \}\}/u);
  assert.doesNotMatch(source, /actions\/checkout/u);
  assert.doesNotMatch(source, /secrets\./u);
  assert.match(source, /permissions:\s*\{\}/u);
});
