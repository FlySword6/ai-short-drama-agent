import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const workflowPath = path.resolve(".github/workflows/prod-pipeline-on-main.yml");

async function readWorkflow(): Promise<string> {
  return readFile(workflowPath, "utf8");
}

test("production pipeline webhook only runs for main pushes with safe permissions and concurrency", async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /on:\s*\n\s+push:\s*\n\s+branches: \[main\]/);
  assert.doesNotMatch(workflow, /pull_request:|workflow_dispatch:|schedule:/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /concurrency:\s*\n\s+group: prod-pipeline-trigger\s*\n\s+cancel-in-progress: false/);
});

test("production pipeline webhook sends a compact deterministic payload with the full commit SHA", async () => {
  const workflow = await readWorkflow();

  assert.doesNotMatch(workflow, /toJson\(github\.event\)|GITHUB_EVENT_JSON/);
  assert.match(workflow, /PIPELINE_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /jq -cn/);
  assert.match(
    workflow,
    /\{repository: \$repository, ref: \$ref, branch: \$branch, commit: \$commit, actor: \$actor, run_id: \$run_id\}/,
  );
  assert.match(workflow, /--data-binary "\$payload"/);
  assert.doesNotMatch(workflow, /--arg commit "\$\{PIPELINE_COMMIT:0:12\}"/);
});

test("production pipeline webhook fails closed without its secret and uses diagnostic-safe curl options", async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /if \[ -z "\$\{VCD_WEBHOOK_URL:-\}" \]; then[\s\S]*?exit 1/);
  assert.match(workflow, /--fail-with-body --silent --show-error/);
  assert.match(workflow, /--header "Accept: application\/json"/);
  assert.match(workflow, /--connect-timeout 10/);
  assert.match(workflow, /--max-time 30/);
  assert.doesNotMatch(
    workflow,
    /--retry(?:\s|$)|--retry-all-errors|--retry-connrefused|echo .*VCD_WEBHOOK_URL|set -x/,
  );
});
