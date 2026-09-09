import { BadRequestError, ConflictError, NotFoundError } from "../../../shared/errors.js";
import { GenerationDefaultStrategyRepository } from "./repository.js";
import type {
  GenerationDefaultMediaKind,
  GenerationDefaultStrategy,
  PutGenerationDefaultStrategyInput,
} from "./types.js";

export interface GenerationDefaultStrategyStore {
  listForActor(
    actorId: string,
    projectId: string,
    authorizedProjectId?: string,
  ): Promise<GenerationDefaultStrategy[]>;
  getForActor(
    actorId: string,
    projectId: string,
    mediaKind: GenerationDefaultMediaKind,
    authorizedProjectId?: string,
  ): Promise<GenerationDefaultStrategy | undefined>;
  putForActor(
    actorId: string,
    projectId: string,
    input: PutGenerationDefaultStrategyInput,
    authorizedProjectId?: string,
  ): Promise<GenerationDefaultStrategy>;
}

/**
 * Test-domain defaults are deliberate, human-approved configuration. This
 * service deliberately does not create generation tasks or call providers.
 */
export class GenerationDefaultStrategyService {
  constructor(private readonly repository: GenerationDefaultStrategyStore) {}

  async list(
    actorId: string,
    projectId: string,
    authorizedProjectId?: string,
  ): Promise<GenerationDefaultStrategy[]> {
    return this.repository.listForActor(actorId, projectId, authorizedProjectId);
  }

  async get(
    actorId: string,
    projectId: string,
    mediaKind: GenerationDefaultMediaKind,
    authorizedProjectId?: string,
  ): Promise<GenerationDefaultStrategy> {
    const strategy = await this.repository.getForActor(actorId, projectId, mediaKind, authorizedProjectId);
    if (!strategy) throw new NotFoundError("当前项目还没有该媒体类型的默认策略");
    return strategy;
  }

  async put(
    actorId: string,
    projectId: string,
    input: PutGenerationDefaultStrategyInput,
    authorizedProjectId?: string,
  ): Promise<GenerationDefaultStrategy> {
    assertSafeParameters(input.parameters);
    return this.repository.putForActor(actorId, projectId, input, authorizedProjectId);
  }
}

export function createGenerationDefaultStrategyService(repository: GenerationDefaultStrategyRepository): GenerationDefaultStrategyService {
  return new GenerationDefaultStrategyService(repository);
}

/** Reject secret-looking / raw-provider-response keys recursively before persistence. */
export function assertSafeParameters(parameters: Record<string, unknown>): void {
  const serialized = JSON.stringify(parameters);
  if (serialized.length > 64 * 1024) {
    throw new BadRequestError("默认策略设置内容过多，请精简后再试");
  }
  walkParameters(parameters, "parameters", 0);
}

function walkParameters(value: unknown, path: string, depth: number): void {
  if (depth > 12) throw new BadRequestError("默认策略设置层级过多，请精简后再试");
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) walkParameters(value[index], `${path}[${index}]`, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
    if (isSensitiveParameterKey(normalized)) {
      throw new BadRequestError("默认策略设置包含不能保存的内容，请移除后再试");
    }
    walkParameters(child, `${path}.${key}`, depth + 1);
  }
}

function isSensitiveParameterKey(normalized: string): boolean {
  return normalized === "secret"
    || normalized.endsWith("secret")
    || normalized === "password"
    || normalized.endsWith("password")
    || normalized === "authorization"
    || normalized.endsWith("apikey")
    || normalized.endsWith("accesstoken")
    || normalized.endsWith("authtoken")
    || normalized.endsWith("bearertoken")
    || normalized.includes("providerresponse")
    || normalized.includes("rawresponse");
}

export function asVersionConflict(error: unknown): ConflictError | null {
  return error instanceof ConflictError && error.code === "generation_default_version_conflict" ? error : null;
}
