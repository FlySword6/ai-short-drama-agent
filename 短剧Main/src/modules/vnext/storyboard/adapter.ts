import { createHash } from "node:crypto";
import type { StoryboardImageAdapter, StoryboardImageRequest, StoryboardImageResult } from "./types.js";

/**
 * Trusted server-to-server boundary. The configured endpoint is the debit
 * authority: it must deduplicate by `idempotency-key`, atomically authorize
 * and charge the actor, and return the immutable billing receipt persisted
 * with the cell version. Missing credentials or receipts fail closed.
 */
export class ControlledStoryboardImageAdapter implements StoryboardImageAdapter {
  constructor(
    private readonly endpoint = process.env.VNEXT_STORYBOARD_IMAGE_ENDPOINT,
    private readonly apiKey = process.env.VNEXT_STORYBOARD_IMAGE_API_KEY,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async generate(request: StoryboardImageRequest): Promise<StoryboardImageResult> {
    if (!request.paidConfirmation) throw new Error("Storyboard image generation requires paid confirmation");
    if (!this.endpoint || !this.apiKey) {
      throw new Error("Storyboard image adapter is not configured");
    }
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}`, "idempotency-key": request.idempotencyKey },
      body: JSON.stringify({
        purpose: "vnext_storyboard",
        project_id: request.projectId,
        actor_id: request.actorId,
        idempotency_key: request.idempotencyKey,
        cell_id: request.cellId,
        prompt: request.prompt,
        source: request.source,
        paid_confirmation: true,
      }),
    });
    if (!response.ok) throw new Error(`Storyboard image provider failed (${response.status})`);
    const body = await response.json() as Partial<StoryboardImageResult>;
    if (!body.mediaUrl || !body.mediaSha256 || !body.provider || !body.model || !body.billingReceiptId || !/^[a-f0-9]{64}$/iu.test(body.mediaSha256)) {
      throw new Error("Storyboard image provider returned an invalid media or billing receipt");
    }
    return { mediaUrl: body.mediaUrl, mediaSha256: body.mediaSha256.toLowerCase(), provider: body.provider, model: body.model, billingReceiptId: body.billingReceiptId };
  }
}

/** Explicit test-only adapter; production composition must use ControlledStoryboardImageAdapter. */
export class FixedStoryboardImageAdapter implements StoryboardImageAdapter {
  constructor(private readonly provider = "test-image", private readonly model = "fixed") {}

  async generate(request: StoryboardImageRequest): Promise<StoryboardImageResult> {
    const mediaSha256 = createHash("sha256").update(`${request.cellId}:${request.prompt}`).digest("hex");
    return {
      mediaUrl: `https://example.invalid/storyboard/${mediaSha256}.png`,
      mediaSha256,
      provider: this.provider,
      model: this.model,
      billingReceiptId: `test-receipt:${request.idempotencyKey}`,
    };
  }
}
