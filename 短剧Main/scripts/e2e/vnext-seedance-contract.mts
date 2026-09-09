import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [service, provider, smoke, routes] = await Promise.all([
  readFile(new URL("../../src/modules/vnext/generation/service.ts", import.meta.url), "utf8"),
  readFile(new URL("../../src/modules/vnext/providers/seedance/seedance25Provider.ts", import.meta.url), "utf8"),
  readFile(new URL("./vnext-seedance-paid-smoke.sh", import.meta.url), "utf8"),
  readFile(new URL("../../src/modules/vnext/generation/routes.ts", import.meta.url), "utf8"),
]);

assert.match(service, /referenceResolver\.resolve\(task\.projectId, task\.references\)/);
assert.match(service, /markSubmitting[\s\S]*provider\.submit/);
assert.match(service, /markUnknownOutcome/);
assert.match(service, /markCopyingToTos[\s\S]*recordTosMedia[\s\S]*markSucceeded/);
assert.match(provider, /\/contents\/generations\/tasks/);
assert.match(provider, /generate_audio/);
assert.match(routes, /generation-tasks[\s\S]*agentAccess:\s*"human_only"/);
assert.match(smoke, /VNEXT_SEEDANCE_PAID_SMOKE_APPROVED/);
assert.match(smoke, /I_UNDERSTAND_THIS_CREATES_ONE_PAID_TASK/);
assert.doesNotMatch(smoke, /--yes|echo\s+[Yy]/);

console.log("vNext Seedance 2.5 provider-free contract E2E passed");
