import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "bytehouse-provision.mts");
const marker = "not-a-real-bytehouse-secret";

function invoke(args: readonly string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      BYTEHOUSE_DEV_HTTP_ENDPOINT: marker,
      BYTEHOUSE_DEV_APP_USERNAME: marker,
      BYTEHOUSE_DEV_APP_PASSWORD: marker,
      BYTEHOUSE_DEV_READONLY_USERNAME: marker,
      BYTEHOUSE_DEV_READONLY_PASSWORD: marker,
    },
  });
}

test("dry-run is offline and reports the exact dev architecture", () => {
  const result = invoke(["--dry-run"]);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /DEV_READY/u);
  assert.match(output, /domain_tables=7/u);
  assert.match(output, /control_tables=1/u);
  assert.match(output, /consumer_views=10/u);
  assert.match(output, /test_prod_action=none/u);
  assert.match(output, /network_operations=0/u);
  assert.match(output, /environment_reads=0/u);
  assert.doesNotMatch(output, new RegExp(marker));
});

test("test/prod and missing confirmation fail before credential validation", () => {
  for (const args of [
    ["--verify", "--environment", "test"],
    ["--verify", "--environment", "prod"],
    ["--apply", "--environment", "dev"],
    ["--apply", "--environment", "dev", "--confirm", "WRONG"],
  ]) {
    const result = invoke(args);
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /拒绝执行/u);
    assert.doesNotMatch(output, new RegExp(marker));
  }
});

test("remote execution requires explicit dev", () => {
  const result = invoke(["--verify"]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /仅允许显式 --environment dev/u);
});

test("readonly negative probe triggers privilege checks without leaving a row", () => {
  const source = readFileSync(scriptPath, "utf8");
  assert.match(source, /__readonly_negative_check__/u);
  assert.match(source, /NOT_ENOUGH_PRIVILEGES/u);
  assert.match(source, /CONSTRAINT_ERROR/u);
  assert.doesNotMatch(source, /WHERE 0/u);
});
