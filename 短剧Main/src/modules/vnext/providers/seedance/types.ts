import type { Seedance25ContentRole, Seedance25ReferenceKind } from "../../generation/seedance25Constraints.js";

export interface Seedance25ProviderOptions {
  apiKey: string;
  endpointModel: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Test seam. */
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface Seedance25SubmitRequest {
  prompt: string;
  /** Aspect ratio, e.g. "9:16", or "adaptive" for locked reference tasks. */
  ratio: string;
  resolution: string;
  durationSeconds: number;
  /** When true, enable native audio (dialogue/narration/ambience/SFX). BGM disabled. */
  nativeAudio: boolean;
  references: Array<{
    kind: Seedance25ReferenceKind;
    url: string;
    role?: Seedance25ContentRole;
    durationSeconds?: number;
  }>;
}

export interface Seedance25SubmitResult {
  providerTaskId: string;
  rawStatus: string;
}

export interface Seedance25QueryResult {
  status: "pending" | "running" | "succeeded" | "failed";
  rawStatus: string;
  unknownStatus: boolean;
  providerTaskId: string;
  mediaUrls: string[];
  errorCode?: string;
  errorMessage?: string;
  actualModelId?: string;
  durationSeconds?: number;
}
