/**
 * Platform roles are deliberately separate from project membership roles.
 * Keep this list close to session authentication so every HTTP route has the
 * same, database-backed interpretation of a user's platform role.
 */
import type { UiMode } from "../../db/schema.js";

export const PLATFORM_ROLES = ["admin", "operator", "member"] as const;

export type PlatformRole = typeof PLATFORM_ROLES[number];

export const CREDENTIAL_SOURCES = ["legacy", "web", "cli", "agent"] as const;
export type CredentialSource = typeof CREDENTIAL_SOURCES[number];

export const ACTIVE_CREDENTIAL_SOURCES = ["web", "cli", "agent"] as const;
export type ActiveCredentialSource = typeof ACTIVE_CREDENTIAL_SOURCES[number];

export type HumanCredentialSource = Extract<ActiveCredentialSource, "web" | "cli">;
export type ActorKind = "human" | "agent";

export function isActiveCredentialSource(value: unknown): value is ActiveCredentialSource {
  return value === "web" || value === "cli" || value === "agent";
}

/**
 * A missing/unknown value must never grant a privilege. This also keeps old
 * test fixtures and sessions created before migration 016 safely equivalent
 * to the default platform role while rollout finishes.
 */
export function platformRoleOrMember(value: unknown): PlatformRole {
  return value === "admin" || value === "operator" || value === "member"
    ? value
    : "member";
}

export function isAdministrator(role: PlatformRole | undefined): boolean {
  return platformRoleOrMember(role) === "admin";
}

export function canReadGlobalCosts(role: PlatformRole | undefined): boolean {
  const effectiveRole = platformRoleOrMember(role);
  return effectiveRole === "admin" || effectiveRole === "operator";
}

/**
 * ui_mode 的缺省/未知值一律回落 'full'：不让坏值把人踢进简版（上线默认即 full），
 * 读取端不产生第三种解释（红线 R2：users 表是唯一事实源，这里只做安全归一）。
 */
export function uiModeOrFull(value: unknown): UiMode {
  return value === "lite" || value === "full" ? value : "full";
}
