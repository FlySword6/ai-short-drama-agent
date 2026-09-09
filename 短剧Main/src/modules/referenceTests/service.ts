import type { GenerationDefaultStrategyService } from "../generation/defaults/service.js";
import type { PutGenerationDefaultStrategyInput } from "../generation/defaults/types.js";
import { BadRequestError } from "../../shared/errors.js";
import { assertSafeParameters } from "../generation/defaults/service.js";
import {
  DrizzleReferenceTestRepository,
} from "./repository.js";
import type { Database } from "../../db/client.js";
import type {
  AttachReferenceTestResultInput,
  Page,
  ReferenceTest,
  ReferenceTestInput,
  ReferenceTestMediaKind,
  ReferenceTestResult,
  ProjectReferenceTestResult,
} from "./types.js";

export interface ReferenceTestStore {
  assertProjectOwner(actorId: string, projectId: string): Promise<void>;
  create(actorId: string, projectId: string, input: ReferenceTestInput): Promise<ReferenceTest>;
  get(actorId: string, projectId: string, referenceTestId: string): Promise<ReferenceTest>;
  list(actorId: string, projectId: string, page: number, pageSize: number, mediaKind?: ReferenceTestMediaKind): Promise<Page<ReferenceTest>>;
  update(actorId: string, projectId: string, referenceTestId: string, input: ReferenceTestInput, expectedVersion: number): Promise<ReferenceTest>;
  remove(actorId: string, projectId: string, referenceTestId: string, expectedVersion: number): Promise<void>;
  attachResult(actorId: string, projectId: string, referenceTestId: string, input: AttachReferenceTestResultInput): Promise<ReferenceTestResult>;
  listResults(actorId: string, projectId: string, referenceTestId: string, page: number, pageSize: number): Promise<Page<ProjectReferenceTestResult>>;
  listProjectResults(actorId: string, projectId: string, page: number, pageSize: number, mediaKind?: ReferenceTestMediaKind): Promise<Page<ProjectReferenceTestResult>>;
  getResultForDefault(actorId: string, projectId: string, referenceTestId: string, resultId: string): Promise<ReferenceTestResult>;
}

export interface ReferenceDefaultStore {
  put(actorId: string, projectId: string, input: PutGenerationDefaultStrategyInput): ReturnType<GenerationDefaultStrategyService["put"]>;
}

/**
 * A test record only prepares/records a configuration. Attaching a result only
 * links a result already persisted by the normal generation chain. Neither
 * path can create a paid task or call a model provider.
 */
export class ReferenceTestService {
  constructor(
    private readonly repository: ReferenceTestStore,
    private readonly defaults: ReferenceDefaultStore,
  ) {}

  async create(actorId: string, projectId: string, input: ReferenceTestInput): Promise<ReferenceTest> {
    assertReferenceTestInput(input);
    return this.repository.create(actorId, projectId, input);
  }

  async get(actorId: string, projectId: string, referenceTestId: string): Promise<ReferenceTest> {
    return this.repository.get(actorId, projectId, referenceTestId);
  }

  async list(actorId: string, projectId: string, page: number, pageSize: number, mediaKind?: ReferenceTestMediaKind): Promise<Page<ReferenceTest>> {
    return this.repository.list(actorId, projectId, page, pageSize, mediaKind);
  }

  async update(actorId: string, projectId: string, referenceTestId: string, input: ReferenceTestInput, expectedVersion: number): Promise<ReferenceTest> {
    assertReferenceTestInput(input);
    return this.repository.update(actorId, projectId, referenceTestId, input, expectedVersion);
  }

  async remove(actorId: string, projectId: string, referenceTestId: string, expectedVersion: number): Promise<void> {
    return this.repository.remove(actorId, projectId, referenceTestId, expectedVersion);
  }

  async attachResult(actorId: string, projectId: string, referenceTestId: string, input: AttachReferenceTestResultInput): Promise<ReferenceTestResult> {
    return this.repository.attachResult(actorId, projectId, referenceTestId, input);
  }

  async listResults(actorId: string, projectId: string, referenceTestId: string, page: number, pageSize: number): Promise<Page<ProjectReferenceTestResult>> {
    return this.repository.listResults(actorId, projectId, referenceTestId, page, pageSize);
  }

  async listProjectResults(actorId: string, projectId: string, page: number, pageSize: number, mediaKind?: ReferenceTestMediaKind): Promise<Page<ProjectReferenceTestResult>> {
    return this.repository.listProjectResults(actorId, projectId, page, pageSize, mediaKind);
  }

  /** Human-only operation: the caller must explicitly invoke this endpoint. */
  async setResultAsDefault(
    actorId: string,
    projectId: string,
    referenceTestId: string,
    resultId: string,
    expectedVersion: number,
  ) {
    const result = await this.repository.getResultForDefault(actorId, projectId, referenceTestId, resultId);
    return this.defaults.put(actorId, projectId, {
      mediaKind: result.mediaKind,
      mode: result.mode,
      modelKey: result.modelKey,
      parameters: result.parameters,
      sourceGenerationRequestId: result.generationRequestId,
      expectedVersion,
    });
  }
}

export function createReferenceTestService(
  db: Database,
  defaults: ReferenceDefaultStore,
): ReferenceTestService {
  return new ReferenceTestService(new DrizzleReferenceTestRepository(db), defaults);
}

function assertReferenceTestInput(input: ReferenceTestInput): void {
  assertSafeParameters(input.parameters);
  if (input.referenceMediaIds.length > 50) throw new BadRequestError("参考素材最多 50 个");
  if (new Set(input.referenceMediaIds).size !== input.referenceMediaIds.length) {
    throw new BadRequestError("参考素材不能重复");
  }
}
