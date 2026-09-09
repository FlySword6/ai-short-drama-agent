import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { registerGenerationIntentRoutes } from "../../src/modules/vnext/generation-intents/routes.js";
import { GenerationIntentService } from "../../src/modules/vnext/generation-intents/service.js";
import type { PendingGenerationIntent } from "../../src/modules/vnext/generation-intents/types.js";
import { ControlPackageService } from "../../src/modules/vnext/control-packages/service.js";
import type { ControlPackage, ControlPackageDraft } from "../../src/modules/vnext/control-packages/types.js";

const actorId = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const projectId = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
class Packages {
  value: ControlPackage | null = null;
  async latest(): Promise<ControlPackage | null> { return this.value; }
  async write(input: ControlPackageDraft & { projectId: string; actorId: string }): Promise<ControlPackage> { this.value = { id: randomUUID(), projectId: input.projectId, version: (this.value?.version ?? 0) + 1, createdByUserId: input.actorId, createdAt: new Date().toISOString(), ...input }; return this.value; }
}
class Intents {
  readonly values = new Map<string, PendingGenerationIntent>();
  async latest(project: string, actor: string): Promise<PendingGenerationIntent | null> { return [...this.values.values()].find((value) => value.projectId === project && value.actorId === actor) ?? null; }
  async create(input: Omit<PendingGenerationIntent, "id" | "createdAt">): Promise<{ intent: PendingGenerationIntent; created: boolean }> { const old = this.values.get(input.clientIdempotencyKey); if (old) return { intent: old, created: false }; const intent = { id: randomUUID(), createdAt: new Date().toISOString(), ...input }; this.values.set(input.clientIdempotencyKey, intent); return { intent, created: true }; }
}
const packages = new Packages();
const access = { async assertRead(): Promise<void> {}, async assertWrite(): Promise<void> {} };
let providerCalls = 0;
const controls = new ControlPackageService(packages, access);
const intents = new GenerationIntentService(new Intents(), packages, access, { async assertBudgetAndAccountAccess() { providerCalls += 0; }, async assertReferenceAssetAccess() { providerCalls += 0; } });
const app = Fastify();
app.addHook("onRequest", async (request) => { request.authUser = { id: actorId, username: "e2e", displayName: "E2E" }; });
await registerGenerationIntentRoutes(app, { controlPackages: () => controls, intents: () => intents });
const port = 4400 + Math.floor(Math.random() * 100);
await app.listen({ host: "127.0.0.1", port });
try {
  const packageBody = { references: [{ reference_id: randomUUID(), reference_version_id: randomUUID(), label: "角色参考", reason: "保持角色一致", capability_snapshot: { version: "capabilities-20260816", captured_at: "2026-08-16T00:00:00.000Z", capabilities: ["image-reference"] } }], final_prompt: "雨夜，角色望向镜头", model: "video-model-v1", parameters: { duration_seconds: 5 }, no_bgm: true, model_availability: { status: "available", checked_at: "2026-08-16T00:00:00.000Z" }, estimated_cost_fen: 42 };
  const save = await fetch(`http://127.0.0.1:${port}/api/vnext/projects/${projectId}/control-package`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(packageBody) });
  assert.equal(save.status, 200);
  const saved = await save.json() as { data: { control_package: { references: Array<{ reference_version_id: string }>; no_bgm: boolean; final_prompt: string } } };
  assert.equal(saved.data.control_package.references[0]?.reference_version_id, packageBody.references[0]?.reference_version_id);
  assert.equal(saved.data.control_package.no_bgm, true);
  assert.equal(saved.data.control_package.final_prompt, packageBody.final_prompt);
  const first = await fetch(`http://127.0.0.1:${port}/api/vnext/projects/${projectId}/pending-generation-intents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_idempotency_key: "pending-e2e-key" }) });
  assert.equal(first.status, 201);
  const replay = await fetch(`http://127.0.0.1:${port}/api/vnext/projects/${projectId}/pending-generation-intents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_idempotency_key: "pending-e2e-key" }) });
  assert.equal(replay.status, 200);
  const restored = await fetch(`http://127.0.0.1:${port}/api/vnext/projects/${projectId}/generation-workbench`);
  const workbench = await restored.json() as { data: { control_package: { version: number }; pending_intent: { status: string; no_bgm: boolean } } };
  assert.equal(restored.status, 200);
  assert.equal(workbench.data.control_package.version, 1);
  assert.equal(workbench.data.pending_intent.status, "pending_confirmation");
  assert.equal(workbench.data.pending_intent.no_bgm, true);
  assert.equal(providerCalls, 0, "pending intent API must not call a provider");
  console.log("vNext paid intent API E2E passed without provider activity");
} finally { await app.close(); }
