import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { parseRequest, success } from "../../http/response.js";
import { requireCurrentContext, requireCurrentSessionId, requireCurrentUser } from "../../http/authenticate.js";
import { requireHumanActor } from "../../http/agentAccess.js";
import { AppError, ForbiddenError } from "../../shared/errors.js";
import { AuthService, type CredentialActor } from "./service.js";
import { isAdministrator, platformRoleOrMember } from "./types.js";
import { WecomAuthService, type WecomAuthPort, type WecomErrorCode } from "./wecomService.js";

const emailSchema = z.string().trim().min(3).max(320).email();
const passwordSchema = z.string().min(1);

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  verification_code: z.string().trim().regex(/^\d{6}$/, "邮箱验证码应为 6 位数字"),
  display_name: z.string().trim().min(1).max(128).optional(),
  invitation_code: z.string().trim().min(1).max(256).optional(),
}).strict();

const requestVerificationSchema = z.object({ email: emailSchema }).strict();
const agentCredentialSchema = z.object({
  agent_type: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  label: z.string().trim().min(1).max(128),
}).strict();
const credentialParams = z.object({ credential_id: z.string().uuid() }).strict();
const wecomAuthorizeQuery = z.object({ return_to: z.string().min(1).max(2048).optional() }).strict();
const wecomCallbackQuery = z.object({
  code: z.string().min(1).max(2048),
  state: z.string().min(1).max(256),
}).strict();
const wecomExchangeSchema = z.object({ result: z.string().min(1).max(256) }).strict();
const wecomPrebindParams = z.object({ user_id: z.string().uuid() }).strict();
const wecomPrebindSchema = z.object({ wecom_user_id: z.string().trim().min(1).max(64) }).strict();

const wecomNonceCookie = "__Host-wecom_oauth_nonce";
const wecomCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
};

// `username` remains accepted for legacy Day-0/admin accounts. New callers
// should use `email`; both map to the same login identifier lookup.
const loginSchema = z.object({
  username: z.string().trim().min(1).max(320).optional(),
  email: emailSchema.optional(),
  password: passwordSchema,
}).strict().refine((value) => Boolean(value.email || value.username), {
  message: "登录没成：邮箱或用户名没填，请补充后再试。",
  path: ["email"],
});

// 红线 R2：界面模式是服务端状态，本人只能在这两个取值之间切换。
const updateUiModeSchema = z.object({
  ui_mode: z.enum(["lite", "full"]),
}).strict();

export type AuthServicePort = Pick<AuthService,
  "requestEmailVerification" | "register" | "login" | "loginCli"
  | "issueAgentCredential" | "listAgentCredentials" | "revokeAgentCredential" | "logout"
  | "getUiMode" | "updateUiMode">;

export interface AuthRouteDependencies {
  createService?: () => AuthServicePort;
  createWecomService?: () => WecomAuthPort;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: AuthRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.() ?? new AuthService(getDatabase());
  // The WeCom adapter owns the process-local access-token cache and its
  // concurrent refresh single-flight. Keep one lazily-created service for this
  // Fastify application instead of rebuilding that cache for every request.
  let appWecomService: WecomAuthPort | undefined;
  const wecomService = () => appWecomService ??= dependencies.createWecomService?.() ?? new WecomAuthService(getDatabase());

  app.get("/api/v1/auth/wecom/status", async () => success(wecomService().status()));

  app.get("/api/v1/auth/wecom/authorize", async (request, reply) => {
    const query = parseRequest(wecomAuthorizeQuery, request.query);
    const authorization = await wecomService().authorize(query.return_to);
    reply.setCookie(wecomNonceCookie, authorization.nonce, {
      ...wecomCookieOptions,
      maxAge: authorization.expiresInSeconds,
    });
    return reply.code(302).redirect(authorization.location);
  });

  app.get("/api/v1/auth/wecom/callback", async (request, reply) => {
    reply.header("Referrer-Policy", "no-referrer");
    try {
      const parsed = wecomCallbackQuery.safeParse(request.query);
      if (!parsed.success) return callbackFailure(reply, "wecom_transaction_invalid");
      const result = await wecomService().callback({
        code: parsed.data.code,
        state: parsed.data.state,
        nonce: request.cookies[wecomNonceCookie],
      });
      const location = `/landing#wecom_result=${encodeURIComponent(result.result)}&redirect=${encodeURIComponent(result.returnPath)}`;
      return reply.code(303).redirect(location);
    } catch (error) {
      if (isWecomAppError(error)) return callbackFailure(reply, error.code);
      throw error;
    }
  });

  app.post("/api/v1/auth/wecom/exchange", async (request) => {
    const input = parseRequest(wecomExchangeSchema, request.body);
    return success(await wecomService().exchange({
      result: input.result,
      nonce: request.cookies[wecomNonceCookie],
      userAgent: observedUserAgent(request),
    }));
  });

  app.put("/api/v1/admin/users/:user_id/wecom-identity", {
    config: { agentAccess: "human_only" },
  }, async (request) => {
    requireHumanActor(request);
    const context = requireCurrentContext(request);
    if (!isAdministrator(context.user.role)) {
      throw new ForbiddenError("绑定没成：当前账号没有管理员权限。");
    }
    const params = parseRequest(wecomPrebindParams, request.params);
    const input = parseRequest(wecomPrebindSchema, request.body);
    return success(await wecomService().prebind({
      userId: context.user.id,
      sessionId: context.credential.sessionId,
    }, params.user_id, input.wecom_user_id));
  });

  app.post("/api/v1/auth/email-verification-codes", async (request, reply) => {
    const input = parseRequest(requestVerificationSchema, request.body);
    const issued = await service().requestEmailVerification({ email: input.email });
    // S57 does not integrate an external sender. The value is intentionally
    // emitted only in development logs, never in HTTP responses or database.
    request.log.info({
      event: "auth.email_verification_code_dev",
      email: issued.email,
      verification_code: issued.devLogCode,
      expires_at: issued.expiresAt.toISOString(),
    }, "development email verification code issued");
    return reply.code(202).send(success({
      email: issued.email,
      expires_at: issued.expiresAt.toISOString(),
      delivery: "dev_log",
    }));
  });

  app.post("/api/v1/auth/register", async (request, reply) => {
    const input = parseRequest(registerSchema, request.body);
    const registration = await service().register({
      email: input.email,
      password: input.password,
      verificationCode: input.verification_code,
      displayName: input.display_name,
      invitationCode: input.invitation_code,
    });
    return reply.code(201).send(success(registration));
  });

  app.post("/api/v1/auth/login", async (request) => {
    const input = parseRequest(loginSchema, request.body);
    return success(await service().login({
      username: input.email ?? input.username ?? "",
      password: input.password,
    }, observedUserAgent(request)));
  });

  app.post("/api/v1/auth/cli/login", async (request) => {
    const input = parseRequest(loginSchema, request.body);
    return success(await service().loginCli({
      username: input.email ?? input.username ?? "",
      password: input.password,
    }, observedUserAgent(request)));
  });

  app.get("/api/v1/auth/me", async (request) => {
    const user = requireCurrentUser(request);
    // ui_mode 不入会话快照，每次实时读 users 表，保证切换后下一次请求即生效。
    const uiMode = await service().getUiMode(user.id);
    return success({
      id: user.id,
      username: user.username,
      display_name: user.displayName,
      role: platformRoleOrMember(user.role),
      ui_mode: uiMode,
    });
  });

  app.patch("/api/v1/auth/me/ui-mode", async (request) => {
    const user = requireCurrentUser(request);
    const input = parseRequest(updateUiModeSchema, request.body);
    const uiMode = await service().updateUiMode(user.id, input.ui_mode);
    return success({ ui_mode: uiMode });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    await service().logout(requireCurrentSessionId(request));
    return reply.send(success({ logged_out: true }));
  });

  app.post("/api/v1/auth/agent-credentials", {
    config: { agentAccess: "human_only" },
  }, async (request, reply) => {
    requireHumanActor(request);
    const input = parseRequest(agentCredentialSchema, request.body);
    const issued = await service().issueAgentCredential(
      credentialActor(request),
      { agentType: input.agent_type, label: input.label },
      observedUserAgent(request),
    );
    return reply.code(201).send(success({
      credential_id: issued.credentialId,
      token: issued.token,
      source: issued.source,
      agent_type: issued.agentType,
      label: issued.label,
      expires_at: issued.expiresAt.toISOString(),
    }));
  });

  app.get("/api/v1/auth/agent-credentials", async (request) => {
    requireHumanActor(request);
    const items = await service().listAgentCredentials(credentialActor(request));
    return success({
      items: items.map((item) => ({
        credential_id: item.id,
        agent_type: item.agentType,
        label: item.label,
        user_agent: item.userAgent,
        expires_at: item.expiresAt.toISOString(),
        revoked_at: item.revokedAt?.toISOString() ?? null,
        created_at: item.createdAt.toISOString(),
        active: item.active,
      })),
      count: items.length,
    });
  });

  app.delete("/api/v1/auth/agent-credentials/:credential_id", {
    config: { agentAccess: "human_only" },
  }, async (request) => {
    requireHumanActor(request);
    const params = parseRequest(credentialParams, request.params);
    const revoked = await service().revokeAgentCredential(credentialActor(request), params.credential_id);
    return success({ credential_id: params.credential_id, revoked });
  });
}

function callbackFailure(reply: FastifyReply, code: WecomErrorCode) {
  return reply.code(303).redirect(`/landing#wecom_error=${encodeURIComponent(code)}`);
}

function isWecomAppError(error: unknown): error is AppError & { code: WecomErrorCode } {
  return error instanceof AppError && error.code.startsWith("wecom_");
}

function credentialActor(request: Parameters<typeof requireCurrentContext>[0]): CredentialActor {
  const context = requireCurrentContext(request);
  return {
    userId: context.user.id,
    sessionId: context.credential.sessionId,
    source: context.credential.source,
  };
}

function observedUserAgent(request: Parameters<typeof requireCurrentContext>[0]): string | undefined {
  return request.headers["user-agent"];
}
