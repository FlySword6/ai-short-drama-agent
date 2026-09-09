import type { ProjectAccessActor } from "../project-access/types.js";

export const OBJECT_KINDS = [
  "project",
  "shot",
  "asset_entity",
  "asset_media",
  "media_result",
] as const;

export type ObjectKind = typeof OBJECT_KINDS[number];

export type RelatedObjectKind =
  | ObjectKind
  | "user"
  | "episode"
  | "scene"
  | "asset_variant"
  | "generation_request"
  | "generation_attempt"
  | "control_package"
  | "review_action"
  | "delivery"
  | "storyboard_import";

export interface EntityRef {
  kind: RelatedObjectKind;
  id: string;
  revision?: string;
  displayName?: string;
}

export type RelationKind =
  | "created_from"
  | "contains"
  | "available_in"
  | "used_by"
  | "references"
  | "generated_from"
  | "selected_as_primary"
  | "reviewed_by"
  | "delivered_in"
  | "copied_from";

export interface RelationEdge {
  id: string;
  relation: RelationKind;
  from: EntityRef;
  to: EntityRef;
  truth: "authoritative" | "snapshot" | "derived";
  occurredAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectScopedEdge {
  edge: RelationEdge;
  projectId: string | null;
}

export interface ObjectNextAction {
  key: string;
  label: string;
  enabled: boolean;
  disabledReason: string | null;
  reasonCodes: string[];
  effect: "navigation" | "domain_write" | "paid";
  requiresHumanConfirmation: boolean;
  inputSchemaKey: string | null;
  invocation:
    | { kind: "route"; href: string }
    | {
        kind: "existing_api";
        method: "POST" | "PUT" | "PATCH" | "DELETE";
        href: string;
        presetBody?: Record<string, unknown>;
      }
    | {
        kind: "paid_quote";
        method: "POST";
        quoteHref: string;
        confirmFlow: "generation_quote_v1";
      }
    | null;
}

export interface ObjectState {
  lifecycle?: string;
  readiness?: string;
  execution?: string;
  persistence?: string;
  review?: {
    platformStatus: string | null;
    projectStatus: string | null;
    mediaStatus: string | null;
    coverage: "complete" | "legacy_global_only" | "not_applicable";
  };
  delivery?: string;
  providerCost?: {
    calculationStatus: string;
    costCnyMicros: number | null;
    requiresAttention: boolean;
    source: "provider_costs";
  };
  blockers: Array<{ code: string; message: string }>;
}

export interface ObjectContextResponse {
  schemaVersion: 1;
  subject: EntityRef;
  revision: string;
  state: ObjectState;
  origin: { edges: RelationEdge[]; truncated: boolean };
  usage: { edges: RelationEdge[]; nextCursor: string | null };
  nextActions: ObjectNextAction[];
  coverage: { complete: boolean; omittedRelationKinds: string[] };
}

export interface ObjectContextQuery {
  include: Set<"origin" | "usage" | "next_actions">;
  projectContextId?: string;
  originDepth: number;
  usageCursor?: string;
  usagePageSize: number;
}

export interface ObjectSubject {
  ref: EntityRef;
  projectId: string | null;
  ownerUserId: string | null;
  visibility: string | null;
  episodeId: string | null;
  shotId: string | null;
  mediaKind: string | null;
  selectedImageResultId: string | null;
  selectedVideoResultId: string | null;
  lifecycle: string | null;
  platformReviewStatus: string | null;
  mediaReviewStatus: string | null;
  persistenceStatus: string | null;
  executionStatus: string | null;
  controlPackageReady: boolean | null;
  updatedAt: string;
  providerCost: ObjectState["providerCost"] | null;
}

export type ObjectContextActor = ProjectAccessActor;

export interface ProductionGraphNode {
  id: string;
  role: "entity" | "task" | "result" | "group" | "note";
  renderer: string;
  subject?: EntityRef;
  state: ObjectState;
  actionKeys: string[];
}

export interface ProductionGraphProjection {
  schemaVersion: 1;
  graphId: string;
  revision: string;
  scope: EntityRef;
  nodes: ProductionGraphNode[];
  edges: RelationEdge[];
  view: {
    preset: "pipeline" | "canvas";
    interaction: {
      move: "locked" | "free";
      connect: "locked" | "free";
      create: "locked" | "free";
      remove: "locked" | "free";
    };
  };
  actions: ObjectNextAction[];
}

export interface ProductionGraphQuery {
  scopeKind: "project" | "episode" | "scene";
  scopeId?: string;
  preset: "pipeline" | "canvas";
}

export const SCENE_PRODUCTION_STATUSES = [
  "not_broken_down",
  "broken_down",
  "preparing",
  "ready",
  "generating",
  "has_media",
  "delivered",
] as const;

export type SceneProductionStatusKind = typeof SCENE_PRODUCTION_STATUSES[number];

export interface SceneProductionStatus {
  sceneId: string;
  episodeId: string;
  sceneNo: number;
  name: string | null;
  sortOrder: number;
  productionStatus: SceneProductionStatusKind;
  statusLabel: string;
  shotSummary: {
    total: number;
    controlPackageStarted: number;
    ready: number;
    inFlight: number;
    withPrimaryVideo: number;
    delivered: number;
  };
  controlPackageSummary: {
    filledLaneCount: number;
    enabledLaneCount: number;
  };
  attemptSummary: {
    pending: number;
    running: number;
    queuePosition: number | null;
  };
  outputSummary: {
    samplePrimaryCount: number;
    fullPrimaryCount: number;
  };
  coverMedia: {
    mediaResultId: string;
    productionMode: "sample" | "full";
    mediaKind: string;
    storageUrl: string | null;
    mimeType: string | null;
    createdAt: string;
  } | null;
  updatedAt: string;
}

export interface EpisodeProductionStatus {
  schemaVersion: 1;
  revision: string;
  episodeId: string;
  projectId: string;
  productionStatus: SceneProductionStatusKind;
  statusLabel: string;
  sceneCount: number;
  deliveredSceneCount: number;
  hasInFlight: boolean;
  nextSceneId: string | null;
  statusCounts: Record<SceneProductionStatusKind, number>;
  scenes: SceneProductionStatus[];
}

export interface SceneProductionStatusResponse {
  schemaVersion: 1;
  revision: string;
  scene: SceneProductionStatus;
}
