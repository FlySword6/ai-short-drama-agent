import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ControlledStoryboardImageAdapter, FixedStoryboardImageAdapter } from "../src/modules/vnext/storyboard/adapter.js";
import { storyboardGenerateSchema, storyboardRedrawSchema } from "../src/modules/vnext/storyboard/schema.js";

const request = { projectId: "00000000-0000-4000-8000-000000000001", cellId: "00000000-0000-4000-8000-000000000002", actorId: "00000000-0000-4000-8000-000000000003", idempotencyKey: "storyboard-cell-1", prompt: "wide shot", source: { shot_id: "s1" }, paidConfirmation: true as const };

test("storyboard requests require an explicit paid confirmation and bounded idempotency key", () => {
  assert.equal(storyboardGenerateSchema.safeParse({ confirmation_id: request.projectId, client_idempotency_key: "generate-1", paid_confirmation: true }).success, true);
  assert.equal(storyboardGenerateSchema.safeParse({ confirmation_id: request.projectId, client_idempotency_key: "generate-1", paid_confirmation: false }).success, false);
  assert.equal(storyboardRedrawSchema.safeParse({ confirmation_id: request.projectId, prompt: "wide shot", client_idempotency_key: "redraw-1", paid_confirmation: true }).success, true);
});

test("controlled adapter fails closed without an explicit provider configuration", async () => {
  await assert.rejects(new ControlledStoryboardImageAdapter(undefined, undefined).generate(request), /not configured/);
});

test("fixed adapter is deterministic only when explicitly injected by a test", async () => {
  const adapter = new FixedStoryboardImageAdapter();
  const first = await adapter.generate(request);
  const second = await adapter.generate(request);
  assert.deepEqual(first, second);
  assert.equal(first.mediaSha256, createHash("sha256").update(`${request.cellId}:${request.prompt}`).digest("hex"));
});

test("provider receipts must include a valid immutable media hash", async () => {
  const adapter = new ControlledStoryboardImageAdapter("https://image.example/generate", "secret", async () => new Response(JSON.stringify({ mediaUrl: "https://cdn.example/a.png", mediaSha256: "not-a-hash", provider: "p", model: "m", billingReceiptId: "receipt-invalid" })));
  await assert.rejects(adapter.generate(request), /invalid media or billing receipt/);
});

test("controlled adapter forwards the stable idempotency key and normalizes the media hash", async () => {
  let received: RequestInit | undefined;
  const adapter = new ControlledStoryboardImageAdapter("https://image.example/generate", "secret", async (_url, init) => {
    received = init;
    return new Response(JSON.stringify({ mediaUrl: "https://cdn.example/a.png", mediaSha256: "A".repeat(64), provider: "p", model: "m", billingReceiptId: "receipt-1" }));
  });
  const result = await adapter.generate(request);
  assert.equal(new Headers(received?.headers).get("idempotency-key"), request.idempotencyKey);
  assert.equal(JSON.parse(String(received?.body)).idempotency_key, request.idempotencyKey);
  assert.equal(result.mediaSha256, "a".repeat(64));
});
