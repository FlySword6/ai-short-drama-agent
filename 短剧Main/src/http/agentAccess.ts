import type { FastifyRequest } from "fastify";
import { AppError, UnauthorizedError } from "../shared/errors.js";

export const AGENT_ACCESS_LEVELS = ["candidate", "prep", "quote", "human_only"] as const;
export type AgentAccess = typeof AGENT_ACCESS_LEVELS[number];

declare module "fastify" {
  interface FastifyContextConfig {
    agentAccess?: AgentAccess;
  }
}

const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Agent credentials fail closed for every mutation. A route becomes writable
 * only when the server-owned route config explicitly classifies it.
 */
export function enforceAgentAccess(request: FastifyRequest): void {
  if (request.authContext?.credential.source !== "agent" || readMethods.has(request.method)) return;
  const access = request.routeOptions.config.agentAccess;
  if (access === "candidate" || access === "prep" || access === "quote") return;
  if (access === "human_only") throw humanConfirmationRequired();
  throw new AppError(
    403,
    "agent_action_not_allowed",
    "Agent 不能执行这项写操作，请由已登录的人完成。",
    false,
  );
}

export function requireHumanActor(request: FastifyRequest): void {
  if (!request.authContext) throw new UnauthorizedError();
  if (request.authContext.credential.source === "agent") throw humanConfirmationRequired();
}

export function humanConfirmationRequired(): AppError {
  return new AppError(
    403,
    "human_confirmation_required",
    "这一步需要由已登录的人确认，Agent 只能准备内容或报价。",
    false,
  );
}
