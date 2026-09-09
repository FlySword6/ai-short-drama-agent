import type { FastifyRequest } from "fastify";
import type { Database } from "../db/client.js";
import { UnauthorizedError } from "../shared/errors.js";
import { AuthService } from "../modules/auth/service.js";
import type { ActiveCredentialSource, ActorKind, PlatformRole } from "../modules/auth/types.js";
import { enforceAgentAccess } from "./agentAccess.js";

export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string;
  /**
   * Sessions loaded after migration 016 always carry this database-backed
   * value. It remains optional in the request type so old test fixtures and
   * pre-rollout callers fail closed as a member rather than gaining access.
   */
  role?: PlatformRole;
}

export interface AuthenticatedRequestContext {
  user: AuthenticatedUser;
  credential: {
    sessionId: string;
    source: ActiveCredentialSource;
    actorKind: ActorKind;
    agentType: string | null;
    userAgent: string | null;
    expiresAt: Date;
  };
}

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthenticatedUser;
    authSessionId?: string;
    authContext?: AuthenticatedRequestContext;
  }
}

const publicApiRoutes = new Set([
  "/api/v1/health",
  // 就绪探针必须公开:LB 与受控迁移验收都在拿到 token 之前调用它,
  // 挂在鉴权后会让「库不可用」表现成 401,验收无从判别。
  "/api/v1/ready",
  "/api/v1/auth/register",
  "/api/v1/auth/email-verification-codes",
  "/api/v1/auth/login",
  "/api/v1/auth/cli/login",
  "/api/v1/auth/wecom/status",
  "/api/v1/auth/wecom/authorize",
  "/api/v1/auth/wecom/callback",
  "/api/v1/auth/wecom/exchange",
]);

export function createAuthenticationHook(getDatabase: () => Database) {
  return async function authenticateRequest(request: FastifyRequest): Promise<void> {
    const path = request.url.split("?", 1)[0] ?? request.url;
    const protectedApi = path.startsWith("/api/v1/") || path.startsWith("/api/vnext/");
    if (request.method === "OPTIONS" || !protectedApi || publicApiRoutes.has(path)) return;
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match?.[1]) throw new UnauthorizedError();
    const session = await new AuthService(getDatabase()).authenticate(match[1]);
    request.authUser = session.user;
    request.authSessionId = session.sessionId;
    request.authContext = {
      user: session.user,
      credential: {
        sessionId: session.sessionId,
        source: session.credential.source,
        actorKind: session.credential.source === "agent" ? "agent" : "human",
        agentType: session.credential.agentType,
        userAgent: session.credential.userAgent,
        expiresAt: session.credential.expiresAt,
      },
    };
    enforceAgentAccess(request);
  };
}

export function requireCurrentUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.authUser) throw new UnauthorizedError();
  return request.authUser;
}

export function requireCurrentSessionId(request: FastifyRequest): string {
  if (!request.authSessionId) throw new UnauthorizedError();
  return request.authSessionId;
}

export function requireCurrentContext(request: FastifyRequest): AuthenticatedRequestContext {
  if (!request.authContext) throw new UnauthorizedError();
  return request.authContext;
}
