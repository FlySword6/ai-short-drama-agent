/**
 * vNext video version provider-free contract E2E (#313).
 *
 * Static contract assertions over the immutable-version module. No real
 * provider, no database, no paid action:
 *  - migration 010 keeps both new tables append-only (trigger + REVOKE) and
 *    grants only SELECT/INSERT to vnext_app;
 *  - the repository never takes row locks (SELECT ... FOR UPDATE would fail
 *    42501 under vnext_app on REVOKE'd tables) and serializes with advisory
 *    locks like the PR #385 pattern;
 *  - the module carries no provider/network dependency: drafts and version
 *    rows are reviewable records; the paid path stays behind the existing
 *    human-confirmed generation-tasks endpoint;
 *  - route mutations stay human-only; the workbench shows prompt, model
 *    capability, cost, and a confirm action before any paid task exists.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Seedance25Provider } from "../../src/modules/vnext/providers/seedance/seedance25Provider.js";

const [migration, repository, service, routes, moduleRoutes, workbench, resolver, authorization, packageJson] = await Promise.all([
  readFile(new URL("../../src/db/migrations/vnext/010_video_versions.sql", import.meta.url), "utf8"),
  readFile(new URL("../../src/modules/vnext/video-versions/repository.ts", import.meta.url), "utf8"),
  readFile(new URL("../../src/modules/vnext/video-versions/service.ts", import.meta.url), "utf8"),
  readFile(new URL("../../src/modules/vnext/video-versions/routes.ts", import.meta.url), "utf8"),
  readFile(new URL("../../src/modules/vnext/routes.ts", import.meta.url), "utf8"),
  readFile(new URL("../../frontend/shortdrama-rag-demo/src/vnext/video-versions/workbench.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/modules/vnext/generation/referenceResolver.ts", import.meta.url), "utf8"),
  readFile(new URL("../../src/modules/vnext/generation-intents/authorization.ts", import.meta.url), "utf8"),
  readFile(new URL("../../package.json", import.meta.url), "utf8"),
]);

// ── Migration: append-only version chain + change drafts. ────────────────────
assert.match(migration, /CREATE TABLE IF NOT EXISTS vnext\.video_versions/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS vnext\.video_change_drafts/);
assert.match(migration, /change_type IN \('register', 'modify', 'extend'\)/);
assert.match(migration, /origin_version_id uuid REFERENCES vnext\.video_versions\(id\)/);
assert.match(migration, /UNIQUE \(chain_id, version_no\)/);
assert.match(migration, /UNIQUE \(origin_version_id\)/);
assert.match(migration, /UNIQUE \(project_id, source_attempt_id\)/);
assert.match(migration, /REFERENCES vnext\.generation_tasks\(id\)/);
assert.match(migration, /REFERENCES vnext\.generation_attempts\(id\)/);
assert.match(migration, /REFERENCES vnext\.control_package_versions\(id\)/);
assert.match(migration, /REFERENCES vnext\.pending_generation_intents\(id\)/);
assert.match(migration, /CREATE TRIGGER vnext_video_versions_immutable[\s\S]*EXECUTE FUNCTION vnext\.prevent_video_version_mutation/);
assert.match(migration, /CREATE TRIGGER vnext_video_change_drafts_immutable/);
assert.match(migration, /GRANT SELECT, INSERT ON[\s\S]*vnext\.video_versions[\s\S]*TO vnext_app/);
assert.match(migration, /REVOKE UPDATE, DELETE ON[\s\S]*vnext\.video_versions[\s\S]*FROM vnext_app/);
assert.match(migration, /REVOKE UPDATE, DELETE ON[\s\S]*vnext\.video_change_drafts[\s\S]*FROM vnext_app/);

// ── Repository: advisory locks only, never row locks on immutable tables. ────
assert.match(repository, /pg_advisory_xact_lock/);
assert.doesNotMatch(repository, /FOR UPDATE/i);
assert.match(repository, /video_version_chain_conflict/);

// ── Service: no provider, no network, no paid dispatch of its own. ───────────
assert.doesNotMatch(service, /providers\/seedance|Seedance25Provider|node-fetch|axios|\bfetch\(/);
assert.match(service, /status !== "succeeded"[\s\S]*tosMedia\.length === 0/);
assert.match(service, /video_version_source_not_succeeded/);

// ── Routes: mutations human-only; mounted in the vNext surface. ──────────────
const humanOnlyCount = (routes.match(/agentAccess:\s*"human_only"/g) ?? []).length;
assert.ok(humanOnlyCount >= 2, "both version mutations must stay human-only");
assert.match(routes, /video-versions\/:version_id\/change-drafts/);
assert.match(moduleRoutes, /registerVnextVideoVersionRoutes/);

// ── Workbench: shows inputs, model capability, prompt, cost, confirm action. ─
assert.match(workbench, /estimated_cost_fen/);
assert.match(workbench, /模型能力/);
assert.match(workbench, /final_prompt/);
assert.match(workbench, /确认并启动生成/);
assert.match(workbench, /不会自动重试|不会自动付费重试/);
assert.match(workbench, /保存为新版本/);
assert.match(workbench, /发起修改/);
assert.match(workbench, /发起续写/);
assert.doesNotMatch(workbench, /setInterval\(/, "no background auto-refresh loops that could mask paid state");

// ── Change drafts pass their origin video through the provider boundary. ─────
assert.match(workbench, /reference_id: editor\.origin\.id/);
assert.match(workbench, /reference_version_id: editor\.origin\.id/);
assert.match(workbench, /capabilities: \["video-reference"\]/);
assert.match(resolver, /FROM vnext\.video_versions v/);
assert.match(resolver, /v\.project_id = \$\{projectId\}::uuid/);
assert.match(resolver, /jsonb_array_elements\(v\.tos_media\) WITH ORDINALITY/);
assert.match(resolver, /item ->> 'mimeType' LIKE 'video\/%'/);

let providerBody: Record<string, unknown> | undefined;
const provider = new Seedance25Provider({
  apiKey: "contract-test-key",
  endpointModel: "ep-seedance25",
  baseUrl: "https://provider.invalid",
  fetchImpl: async (_url, init) => {
    providerBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "provider-task", status: "queued" }), { status: 200 });
  },
});
await provider.submit({
  prompt: "在原视频段上续写",
  ratio: "adaptive",
  resolution: "720p",
  durationSeconds: -1,
  nativeAudio: true,
  references: [{ kind: "video", url: "https://tos.example.com/vnext/origin.mp4", durationSeconds: 4 }],
});
assert.deepEqual(providerBody?.content, [
  { type: "text", text: "在原视频段上续写" },
  { type: "video_url", video_url: { url: "https://tos.example.com/vnext/origin.mp4" }, role: "reference_video" },
]);
assert.equal(providerBody?.ratio, "adaptive");
assert.equal(providerBody?.duration, -1);

// ── npm scripts follow the established naming convention. ────────────────────
const scripts = JSON.parse(packageJson).scripts as Record<string, string>;
assert.equal(scripts["test:vnext-video-version-db"], "bash scripts/e2e/vnext-video-version-db.sh");
assert.equal(scripts["e2e:vnext-video-version-contract"], "bash scripts/e2e/vnext-video-version-contract.sh");

console.log("vNext video version provider-free contract E2E passed");
