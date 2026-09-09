import type { SnapshotRegistrationReadback } from "./service.js";

export function transportFailure(registrationId: string | null): SnapshotRegistrationReadback {
  return {
    registrationId,
    status: "unknown",
    failureCode: "ASSET_REGISTRY_UNAVAILABLE",
    failureReason: "火山素材注册服务暂时不可用，登记结果不明确",
    readback: null,
  };
}
