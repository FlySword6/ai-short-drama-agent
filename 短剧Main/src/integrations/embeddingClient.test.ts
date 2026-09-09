import assert from "node:assert/strict";
import test from "node:test";
import {
  DoubaoEmbeddingClient,
  type EmbeddingFetch,
} from "./embeddingClient.js";

const endpoint = "https://ark.example.invalid/api/v3";

function embeddingResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(fetchImpl: EmbeddingFetch): DoubaoEmbeddingClient {
  return new DoubaoEmbeddingClient("test-api-key", "configured-embedding-model", endpoint, fetchImpl);
}

test("embedding adapter uses injected fetch and preserves the EmbeddingClient contract", async () => {
  let request: RequestInit | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    request = init;
    return embeddingResponse({ data: { embedding: [0.25, -0.5] } });
  }) as EmbeddingFetch;

  assert.deepEqual(await client(fetchImpl).embedText("雨夜巷口"), [0.25, -0.5]);
  assert.deepEqual(JSON.parse(String(request?.body)), {
    model: "configured-embedding-model",
    input: [{ type: "text", text: "雨夜巷口" }],
  });
});

test("embedding HTTP failure does not leak provider response body", async () => {
  const failingClient = client((async () => embeddingResponse({
    error: { message: "provider_secret_should_not_appear" },
  }, 429)) as EmbeddingFetch);

  await assert.rejects(
    failingClient.embedText("测试"),
    (error: unknown) => error instanceof Error
      && error.message === "Doubao embedding: request failed with status 429"
      && !error.message.includes("provider_secret_should_not_appear"),
  );
});

test("embedding invalid JSON does not leak provider response body", async () => {
  const failingClient = client((async () => new Response(
    "provider_secret_should_not_appear",
    { status: 200, headers: { "Content-Type": "application/json" } },
  )) as EmbeddingFetch);

  await assert.rejects(
    failingClient.embedText("测试"),
    (error: unknown) => error instanceof Error
      && error.message === "Doubao embedding: response returned invalid JSON"
      && !error.message.includes("provider_secret_should_not_appear"),
  );
});

test("embedding response without a usable vector does not leak provider response body", async () => {
  const failingClient = client((async () => embeddingResponse({
    data: { embedding: [] },
    debug: "provider_secret_should_not_appear",
  })) as EmbeddingFetch);

  await assert.rejects(
    failingClient.embedText("测试"),
    (error: unknown) => error instanceof Error
      && error.message === "Doubao embedding: response does not contain a usable vector"
      && !error.message.includes("provider_secret_should_not_appear"),
  );
});

test("embedding network error does not leak fetch implementation detail", async () => {
  const failingClient = client((async () => {
    throw new Error("provider_secret_should_not_appear");
  }) as EmbeddingFetch);

  await assert.rejects(
    failingClient.embedText("测试"),
    (error: unknown) => error instanceof Error
      && error.message === "Doubao embedding: request failed"
      && !error.message.includes("provider_secret_should_not_appear"),
  );
});
test("embedImage sends image input to the multimodal endpoint and returns the vector", async () => {
  let request: RequestInit | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    request = init;
    return embeddingResponse({ data: { embedding: [0.3, -0.7] } });
  }) as EmbeddingFetch;

  const client = new DoubaoEmbeddingClient("test-api-key", "configured-embedding-model", endpoint, fetchImpl);
  const buffer = Buffer.from("fake-image-bytes");
  const vector = await client.embedImage(buffer, "image/png");

  assert.deepEqual(vector, [0.3, -0.7]);
  const body = JSON.parse(String(request?.body));
  assert.equal(body.model, "configured-embedding-model");
  assert.equal(body.input[0].type, "image_url");
  assert.ok(body.input[0].image_url.url.startsWith("data:"));
});

test("embedImage image processing failure falls back to raw bytes", async () => {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    return embeddingResponse({ data: { embedding: [0.5, 0.5] } });
  }) as EmbeddingFetch;

  const client = new DoubaoEmbeddingClient("test-api-key", "configured-embedding-model", endpoint, fetchImpl);
  const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const vector = await client.embedImage(buffer, "image/jpeg");
  assert.deepEqual(vector, [0.5, 0.5]);
});
