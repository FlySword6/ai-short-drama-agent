export interface NormalizedProviderStatus {
  status: "pending" | "running" | "succeeded" | "failed";
  rawStatus: string;
  unknownStatus: boolean;
}

export function normalizeArkVideoStatus(value: unknown): NormalizedProviderStatus {
  const rawStatus = typeof value === "string" ? value.trim().toLowerCase() : "";
  switch (rawStatus) {
    case "queued":
    case "pending":
      return { status: "pending", rawStatus, unknownStatus: false };
    case "running":
    case "in_progress":
    case "processing":
      return { status: "running", rawStatus, unknownStatus: false };
    case "succeeded":
    case "completed":
      return { status: "succeeded", rawStatus, unknownStatus: false };
    case "failed":
    case "cancelled":
    case "expired":
      return { status: "failed", rawStatus, unknownStatus: false };
    default:
      // An unknown provider status must not be converted to a terminal state.
      return { status: "running", rawStatus, unknownStatus: true };
  }
}
