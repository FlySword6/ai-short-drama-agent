import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { canonicalJson, dateOnly, parseHeat } from "../scripts/bytehouse-sync.mts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "bytehouse-sync.mts");

test("canonical JSON is stable across object key order", () => {
  assert.equal(
    canonicalJson({ b: [2, { z: true, a: null }], a: 1 }),
    canonicalJson({ a: 1, b: [2, { a: null, z: true }] }),
  );
});

test("PostgreSQL date values retain their local calendar day for ByteHouse Date columns", () => {
  assert.equal(dateOnly("2026-07-31"), "2026-07-31");
  assert.equal(dateOnly(new Date(2026, 6, 31)), "2026-07-31");
  assert.throws(() => dateOnly("2026-07-31T00:00:00Z"), /YYYY-MM-DD/u);
  assert.throws(() => dateOnly("2026-02-31"), /YYYY-MM-DD/u);
  assert.throws(() => dateOnly(new Date(Number.NaN)), /date 无效/u);
});

test("radar heat parser is deterministic and preserves unknown states", () => {
  assert.deepEqual(parseHeat("1.2万"), { raw: "1.2万", value: 12_000, status: "parsed" });
  assert.deepEqual(parseHeat("未知"), { raw: "未知", value: null, status: "unparsed" });
  assert.deepEqual(parseHeat(null), { raw: null, value: null, status: "missing" });
});

test("syncer fails closed before reading any real credential", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {},
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /必须显式 --source-preflight/u);
});

test("syncer source excludes raw sensitive projections and documents vector blocker", () => {
  const source = readFileSync(scriptPath, "utf8");
  assert.doesNotMatch(source, /safe_props_json:\s*JSON\.stringify\(event\.props/u);
  assert.doesNotMatch(source, /visual_prompt|source_file_url|raw_item\s*:/u);
  assert.match(source, /no_persistent_pg_vector_ledger_do_not_fabricate_or_recompute/u);
  assert.match(source, /replay of \[1, 2\]/u);
  assert.match(source, /POSTGRES_HOST/u);
  assert.match(source, /entry_kind: "generation_quote"/u);
  assert.doesNotMatch(source, /WHERE q\.status = 'consumed'/u);
});

test("syncer accepts only an explicit unique domain subset", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      scriptPath,
      "--apply",
      "--environment",
      "dev",
      "--confirm",
      "SYNC_BYTEHOUSE_S55_DOMAINS_DEV",
      "--domains",
      "events,events",
    ],
    { cwd: repoRoot, encoding: "utf8", env: {} },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /只能是不重复/u);
});
