export type VnextVideoProviderReferenceKind = "image" | "video" | "audio";
export type VnextVideoProviderContentRole =
  | "reference_image"
  | "reference_video"
  | "reference_audio"
  | "first_frame"
  | "last_frame";

export interface VnextVideoProviderSubmitRequest {
  prompt: string;
  ratio: string;
  resolution: string;
  durationSeconds: number;
  nativeAudio: boolean;
  references: Array<{
    kind: VnextVideoProviderReferenceKind;
    url: string;
    role?: VnextVideoProviderContentRole;
    durationSeconds?: number;
  }>;
}

export interface VnextVideoProviderSubmitResult {
  providerTaskId: string;
  rawStatus: string;
}

export interface VnextVideoProviderQueryResult {
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

export interface VnextVideoProvider {
  readonly id: string;
  checkReadiness(): { ok: true; modelId: string } | { ok: false; reason: string };
  resolveParameters(raw: Record<string, unknown>): Record<string, unknown>;
  lockedTaskParameters(): Record<string, unknown>;
  /**
   * 判定是否属于「本地契约拦截：确定未发出、确定未扣费」。
   * 返回判别联合而非布尔，是因为调用方在记失败时要用错误码；
   * 拆成两个方法会让同一个判断被调用两次，一致性无从保证。
   */
  isLocalContractViolation(error: unknown): { violated: true; code: string } | { violated: false };
  submit(
    request: VnextVideoProviderSubmitRequest,
    signal?: AbortSignal,
  ): Promise<VnextVideoProviderSubmitResult>;
  query(providerTaskId: string, signal?: AbortSignal): Promise<VnextVideoProviderQueryResult>;
}
