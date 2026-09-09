export type GraphNodeKind = "scene" | "asset" | "task" | "note";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  position: { x: number; y: number };
  data?: Record<string, string | number | boolean | null>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface GraphDocument {
  schemaVersion: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface VnextProject {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

/** 画布事实的来源:同一 HTTP 服务写入,界面与 Agent 共用。 */
export type VnextActorKind = "human" | "agent";

export interface VnextLastWrite {
  kind: VnextActorKind;
  userId: string | null;
  at: Date;
}

export interface VnextGraphDocument {
  projectId: string;
  revision: number;
  document: GraphDocument;
  updatedAt: Date;
  lastWrite: VnextLastWrite | null;
}

export interface VnextRevisionSummary {
  revision: number;
  createdByUserId: string;
  createdByKind: VnextActorKind;
  createdAt: Date;
}

export interface GenerationTelemetryEvent {
  id: string;
  userId: string;
  requestId: string;
  projectId: string;
  taskId: string;
  eventType: string;
  provider?: string;
  model?: string;
  capabilitySnapshotVersion?: string;
  paidConfirmation?: boolean;
  queueLatencyMs?: number;
  providerLatencyMs?: number;
  providerCostFen?: number;
  resultStatus?: string;
  retryReason?: string;
}
