import sharp from "sharp";
import { settings } from "../config/env.js";
import { ExternalServiceError } from "../shared/errors.js";
import { isRecord } from "../shared/json.js";

export interface EmbeddingClient {
  embedText(text: string): Promise<number[]>;
  embedImage(content: Buffer, contentType: string | null): Promise<number[]>;
}

/** Injectable only so adapter behavior can be verified without a network call. */
export type EmbeddingFetch = typeof fetch;

type EmbeddingInputItem =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export class DoubaoEmbeddingClient implements EmbeddingClient {
  private readonly endpoint: string;

  constructor(
    private readonly apiKey = settings.arkApiKey,
    private readonly model = settings.doubaoEmbeddingModel,
    baseUrl = settings.arkBaseUrl,
    private readonly fetchImpl: EmbeddingFetch = fetch,
  ) {
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/embeddings/multimodal`;
  }

  async embedText(text: string): Promise<number[]> {
    return this.embed([{ type: "text", text }]);
  }

  async embedImage(content: Buffer, contentType: string | null): Promise<number[]> {
    const { base64, mimeType } = await prepareImageForEmbedding(content, contentType);
    return this.embed([
      { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
    ]);
  }

  private async embed(input: EmbeddingInputItem[]): Promise<number[]> {
    if (!this.apiKey) throw new ExternalServiceError("Doubao embedding", "Missing ARK_API_KEY");
    if (!this.model) throw new ExternalServiceError("Doubao embedding", "Missing DOUBAO_EMBEDDING_MODEL");
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.model, input }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      // Fetch implementations can include endpoint or upstream details in an
      // Error message. Keep those outside the application error/log path.
      throw new ExternalServiceError("Doubao embedding", "request failed");
    }
    if (!response.ok) {
      throw new ExternalServiceError("Doubao embedding", `request failed with status ${response.status}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      // Response.json() commonly exposes a snippet of the response body in its
      // error. Do not pass provider content through our public error surface.
      throw new ExternalServiceError("Doubao embedding", "response returned invalid JSON");
    }
    const vector = extractEmbeddingVector(payload);
    if (!vector || !vector.length) {
      throw new ExternalServiceError("Doubao embedding", "response does not contain a usable vector");
    }
    return vector;
  }
}

/** Resize and transcode an image so the embedding endpoint receives a compact,
 *  uniform JPEG. Mirrors the vision client's preprocessing. Falls back to the
 *  raw bytes when sharp cannot decode the input. */
async function prepareImageForEmbedding(
  content: Buffer,
  contentType: string | null,
): Promise<{ base64: string; mimeType: string }> {
  try {
    const buffer = await sharp(content)
      .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "white" })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    return { base64: buffer.toString("base64"), mimeType: "image/jpeg" };
  } catch {
    return { base64: content.toString("base64"), mimeType: contentType ?? "application/octet-stream" };
  }
}

/** Supports the current Ark object response and the older array-shaped response. */
export function extractEmbeddingVector(payload: unknown): number[] | null {
  if (!isRecord(payload)) return null;
  const data = payload.data;
  if (isRecord(data) && Array.isArray(data.embedding)) {
    return data.embedding.filter((value): value is number => typeof value === "number");
  }
  if (Array.isArray(data)) {
    const first = data[0];
    if (isRecord(first) && Array.isArray(first.embedding)) {
      return first.embedding.filter((value): value is number => typeof value === "number");
    }
  }
  return null;
}