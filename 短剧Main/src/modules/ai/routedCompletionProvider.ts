import {
  COMPANY_PROVIDER_NOT_ENABLED_MESSAGE,
  isCompanyProviderAllowed,
  normalizeCompanyProviderAllowlist,
  type CompanyProviderAccountId,
} from "../../shared/companyProviderPolicy.js";
import { AppError, ExternalServiceError } from "../../shared/errors.js";
import type {
  AiCompletionProvider,
  AiProviderCompletion,
  AiProviderToolTurn,
  AiThinkingMode,
  AiToolTurnRequest,
} from "./types.js";

export interface AiCompletionRoute {
  providerId: "ark" | "minimax" | "col";
  models: readonly string[];
  adapter: AiCompletionProvider;
}

export interface RoutedAiCompletionProviderOptions {
  companyProviderAllowlist: readonly string[];
}

/**
 * Exact-model router for the shared audited AI gateway. It never infers a
 * provider from a client string: every routable model came from deployment
 * configuration and is bound to one adapter at startup.
 */
export class RoutedAiCompletionProvider implements AiCompletionProvider {
  private readonly routes = new Map<string, AiCompletionRoute>();
  private readonly companyProviderAllowlist: ReadonlySet<CompanyProviderAccountId>;

  constructor(
    routes: readonly AiCompletionRoute[],
    options: RoutedAiCompletionProviderOptions,
  ) {
    this.companyProviderAllowlist = normalizeCompanyProviderAllowlist(
      options.companyProviderAllowlist,
    );
    for (const route of routes) {
      for (const value of route.models) {
        const model = value.trim();
        if (!model) continue;
        if (this.routes.has(model)) {
          throw new Error(`AI completion model is configured more than once: ${model}`);
        }
        this.routes.set(model, route);
      }
    }
  }

  providerForModel(model: string): string {
    return this.requireRoute(model).providerId;
  }

  complete(input: {
    system: string;
    prompt: string;
    model?: string;
    thinking?: AiThinkingMode;
    maxTokens: number;
    /** 网关按用途解析后的单次请求超时;原样透传给命中的适配器。 */
    timeoutMs?: number;
  }): Promise<AiProviderCompletion> {
    const model = input.model?.trim();
    if (!model) {
      throw new ExternalServiceError("AI model", "missing configured model route");
    }
    return this.allowedRoute(model).adapter.complete({ ...input, model });
  }

  completeToolTurn(input: AiToolTurnRequest): Promise<AiProviderToolTurn> {
    const model = input.model?.trim();
    if (!model) {
      throw new ExternalServiceError("AI model", "missing configured model route");
    }
    const adapter = this.allowedRoute(model).adapter;
    if (!adapter.completeToolTurn) {
      throw new ExternalServiceError("AI model", "model route does not support tool calling");
    }
    return adapter.completeToolTurn({ ...input, model });
  }

  private allowedRoute(model: string): AiCompletionRoute {
    const route = this.requireRoute(model);
    if (!isCompanyProviderAllowed(route.providerId, this.companyProviderAllowlist)) {
      throw new AppError(
        503,
        "provider_company_account_not_enabled",
        COMPANY_PROVIDER_NOT_ENABLED_MESSAGE,
        false,
      );
    }
    return route;
  }

  private requireRoute(model: string): AiCompletionRoute {
    const route = this.routes.get(model.trim());
    if (!route) {
      throw new ExternalServiceError("AI model", "model route is not configured");
    }
    return route;
  }
}
