import type { ProjectAccessActor } from "../project-access/types.js";

export const CONTROL_PACKAGE_LANES = [
  "character",
  "scene",
  "prop",
  "camera_motion",
  "reference_video",
  "audio",
] as const;

/**
 * Built-in lanes, kept for response pre-filling. Migration 020 opens the lane
 * to the reference_lane_vocabulary registry, so ref/input lane fields are
 * plain strings validated against that vocabulary at write time.
 */
export type ControlPackageLane = (typeof CONTROL_PACKAGE_LANES)[number];

export interface ControlPackageRef {
  id: string;
  lane: string;
  kind: "asset" | "generated";
  mediaId: string;
  thumbnailUrl: string | null;
  storageUrl: string | null;
  note: string | null;
  sortOrder: number;
}

export interface ControlPackage {
  id: string | null;
  shotId: string;
  ready: {
    markedBy: string;
    markedByName: string;
    markedAt: string;
  } | null;
  lanes: Record<string, ControlPackageRef[]>;
}

export interface AddControlPackageRefInput {
  lane: string;
  assetMediaId?: string;
  mediaResultId?: string;
  note?: string;
}

/**
 * HTTP callers always provide the authenticated actor so the project capability
 * matrix can apply platform roles. The string form is a temporary in-process
 * compatibility boundary for existing repository-only callers; it is treated
 * as a regular member and never gains platform privileges.
 */
export type ControlPackageActor = ProjectAccessActor | string;

export interface ControlPackageStore {
  get(actor: ControlPackageActor, shotId: string): Promise<ControlPackage>;
  setReady(actor: ControlPackageActor, shotId: string, ready: boolean): Promise<ControlPackage>;
  addRef(actor: ControlPackageActor, shotId: string, input: AddControlPackageRefInput): Promise<ControlPackageRef>;
  deleteRef(actor: ControlPackageActor, refId: string): Promise<void>;
}
