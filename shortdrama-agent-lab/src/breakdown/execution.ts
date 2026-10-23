import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import { Type, type Static } from "@sinclair/typebox";
import { BreakdownError, PaidModelExecutionError, type PaidModelCallState } from "./errors";
import { findModel } from "../models/registry";
import type { CreateExtractFactsCandidateRequest, PlanRevisionRecord } from "./plan";
import type {
  BreakdownRepository,
  ExecutionSnapshot,
  ModelCallUsage,
  SafeExecutionError,
  StoredScriptVersion,
  ResolvedModelConfig,
} from "./repository";
import { canonicalJsonSha256, type BreakdownService } from "./service";
import {
  buildEvidenceAliasCatalog,
  createPromptChunks,
  type EvidenceAlias,
  type SourceRef,
} from "./source-index";

export const EXTRACT_FACTS_CONTEXT_VERSION = "extract-facts-context/1";
export const EXTRACT_FACTS_PROMPT_VERSION = "extract-facts-prompt/1";
export const SINGLE_CALL_EXECUTOR_VERSION = "single-model-call-executor/1";

export interface StageEvidence {
  alias: string;
  role: "primary" | "context";
  kind: EvidenceAlias["kind"];
  quote: string;
  speakerCandidate: string | null;
}

export interface ExtractFactsStageContext {
  schemaVersion: typeof EXTRACT_FACTS_CONTEXT_VERSION;
  runId: string;
  taskId: string;
  requirements: unknown;
  inputManifest: unknown;
  chunks: Array<{
    id: string;
    boundaryBefore: string;
    sectionHeadingAlias: string | null;
    evidence: StageEvidence[];
  }>;
}

export interface StageModelResult {
  output: unknown;
  providerRequestId: string | null;
  usage: ModelCallUsage | null;
}

export interface StageModelAdapter {
  forRun?(config: ResolvedModelConfig): StageModelAdapter;
  /** Fail before recording an attempt when the real service is not configured. */
  assertConfigured?(): void;
  call(input: {
    model: string;
    reasoningEffort: string;
    maxOutputTokens: number;
    payload: unknown;
  }): Promise<StageModelResult>;
}

export interface RecordedStageModelPort {
  call(payload: unknown): Promise<unknown>;
}

export interface ExtractFactsStageExecutor {
  readonly version: string;
  execute(context: ExtractFactsStageContext, model: RecordedStageModelPort): Promise<unknown>;
}

/** The first executor has one narrow responsibility. Pi can replace this class later. */
export class SingleModelCallExtractFactsExecutor implements ExtractFactsStageExecutor {
  readonly version = SINGLE_CALL_EXECUTOR_VERSION;

  async execute(context: ExtractFactsStageContext, model: RecordedStageModelPort): Promise<unknown> {
    return model.call({
      operation: "extractFacts",
      promptVersion: EXTRACT_FACTS_PROMPT_VERSION,
      rules: {
        preserveStoryFactsAndDialogue: true,
        factualEvidenceMustUsePrimaryAlias: true,
        contextAliasesCannotSolelySupportOutput: true,
        unknownFactsMustRemainNull: true,
      },
      context,
    });
  }
}

export interface ExtractFactsRunResult {
  plan: PlanRevisionRecord;
  execution: ExecutionSnapshot;
}

export interface ExtractFactsStageRunnerOptions {
  now?: () => Date;
  nextId?: (prefix: string) => string;
  targetEstimatedTokens?: number;
}

export class ExtractFactsStageRunner {
  private readonly now: () => Date;
  private readonly nextId: (prefix: string) => string;
  private readonly targetEstimatedTokens: number;

  constructor(
    private readonly repository: BreakdownRepository,
    private readonly service: BreakdownService,
    private readonly executor: ExtractFactsStageExecutor,
    private readonly adapter: StageModelAdapter,
    options: ExtractFactsStageRunnerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.nextId = options.nextId ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`);
    this.targetEstimatedTokens = options.targetEstimatedTokens ?? 4_000;
  }

  async run(runId: string): Promise<ExtractFactsRunResult> {
    const run = await this.service.getRun(runId);
    const model = findModel(run.modelConfig.model);
    if (!this.adapter.forRun && (run.modelConfig.provider !== "maas" || !model || !model.reasoningEfforts.includes(run.modelConfig.reasoningEffort))) {
      throw new BreakdownError(409, "MODEL_CONFIGURATION_CHANGED", "此 Run 使用已移除的模型配置。历史结果仍可查看和校对，请新建 Run 使用当前模型。");
    }
    const adapter = this.adapter.forRun?.(run.modelConfig) ?? this.adapter;
    adapter.assertConfigured?.();
    const script = await this.repository.getScriptVersion(run.projectId, run.scriptVersionId);
    if (!script) throw new BreakdownError(409, "SCRIPT_VERSION_UNAVAILABLE", "执行所需剧本版本不可用。");
    const built = buildExtractFactsStageContext(run, script, this.targetEstimatedTokens);
    const inputDigest = canonicalJsonSha256({
      contextVersion: EXTRACT_FACTS_CONTEXT_VERSION,
      promptVersion: EXTRACT_FACTS_PROMPT_VERSION,
      executorVersion: this.executor.version,
      targetEstimatedTokens: this.targetEstimatedTokens,
      inputManifest: run.task.inputManifest,
      chunks: built.context.chunks,
    });
    const attempt = await this.repository.beginAttempt({
      id: this.nextId("attempt"),
      runId: run.id,
      taskId: run.task.id,
      promptVersion: EXTRACT_FACTS_PROMPT_VERSION,
      executorVersion: this.executor.version,
      inputDigest,
      startedAt: this.timestamp(),
    });

    let callOrdinal = 0;
    const modelPort: RecordedStageModelPort = {
      call: async (payload) => {
        callOrdinal += 1;
        const call = await this.repository.createModelCall({
          id: this.nextId("modelcall"),
          attemptId: attempt.id,
          operationKey: `${attempt.id}:extractFacts:${callOrdinal}`,
          provider: run.modelConfig.provider,
          model: run.modelConfig.model,
          requestDigest: canonicalJsonSha256(payload),
          createdAt: this.timestamp(),
        });
        await this.repository.markModelCallSubmitted(call.id);
        try {
          const result = await adapter.call({
            model: run.modelConfig.model,
            reasoningEffort: run.modelConfig.reasoningEffort,
            maxOutputTokens: run.task.maxOutputTokens,
            payload,
          });
          await this.repository.completeModelCall({
            modelCallId: call.id,
            providerRequestId: result.providerRequestId,
            usage: normalizeUsage(result.usage),
            endedAt: this.timestamp(),
          });
          return result.output;
        } catch (_error) {
          await this.repository.failModelCall({
            modelCallId: call.id,
            providerRequestId: null,
            error: { code: "MODEL_ADAPTER_FAILED", message: "模型适配器调用失败。" },
            endedAt: this.timestamp(),
          });
          throw new BreakdownError(502, "MODEL_ADAPTER_FAILED", "模型适配器调用失败。");
        }
      },
    };

    try {
      const rawOutput = await this.executor.execute(built.context, modelPort);
      const candidate = resolveAliasedExtractFactsCandidate(rawOutput, built.aliases);
      const plan = await this.service.createExtractFactsCandidateForAttempt(run.id, attempt.id, candidate);
      await this.repository.completeAttempt({
        attemptId: attempt.id,
        planRevisionId: plan.id,
        endedAt: this.timestamp(),
      });
      const execution = await this.repository.getExecutionSnapshot(attempt.id);
      if (!execution) throw new Error("execution snapshot missing after completion");
      return { plan, execution };
    } catch (error) {
      const snapshot = await this.repository.getExecutionSnapshot(attempt.id);
      if (snapshot?.attempt.status === "running") {
        await this.repository.failAttempt({
          attemptId: attempt.id,
          error: safeExecutionError(error),
          endedAt: this.timestamp(),
        });
      }
      const paidModelCallState: PaidModelCallState = snapshot?.modelCalls.some(call => call.status === "succeeded")
        ? "confirmed"
        : snapshot?.modelCalls.some(call => call.status === "submitted" || call.status === "failed")
          ? "unknown"
          : "none";
      if (error instanceof BreakdownError) {
        throw new PaidModelExecutionError(error.status, error.code, error.message, paidModelCallState);
      }
      throw new PaidModelExecutionError(422, "STAGE_OUTPUT_INVALID", "事实提取结果未通过程序校验。", paidModelCallState);
    }
  }

  private timestamp(): string {
    const value = this.now();
    if (Number.isNaN(value.valueOf())) throw new Error("Clock returned an invalid date");
    return value.toISOString();
  }
}

interface BuiltStageContext {
  context: ExtractFactsStageContext;
  aliases: Map<string, EvidenceAlias>;
}

function buildExtractFactsStageContext(
  run: Awaited<ReturnType<BreakdownService["getRun"]>>,
  script: StoredScriptVersion,
  targetEstimatedTokens: number,
): BuiltStageContext {
  const chunks = createPromptChunks(script.sourceIndex, { targetEstimatedTokens });
  const aliases = new Map<string, EvidenceAlias>();
  const contextChunks = chunks.map((chunk) => {
    const catalog = buildEvidenceAliasCatalog(script.sourceIndex, chunk);
    for (const evidence of catalog) aliases.set(aliasKey(chunk.id, evidence.alias), evidence);
    const heading = chunk.sectionHeadingSpanId
      ? catalog.find((entry) => entry.spanId === chunk.sectionHeadingSpanId)
      : undefined;
    return {
      id: chunk.id,
      boundaryBefore: chunk.boundaryBefore,
      sectionHeadingAlias: heading?.alias ?? null,
      evidence: catalog.map((entry): StageEvidence => ({
        alias: entry.alias,
        role: entry.role,
        kind: entry.kind,
        quote: entry.sourceRef.quote,
        speakerCandidate: entry.speakerCandidate,
      })),
    };
  });
  return {
    context: {
      schemaVersion: EXTRACT_FACTS_CONTEXT_VERSION,
      runId: run.id,
      taskId: run.task.id,
      requirements: structuredClone(run.requirements),
      inputManifest: structuredClone(run.task.inputManifest),
      chunks: contextChunks,
    },
    aliases,
  };
}

const OpaqueId = Type.String({ minLength: 3, maxLength: 128, pattern: "^[a-z][a-z0-9_-]*$" });
const Nonblank = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const AliasPointerSchema = Type.Object({
  chunkId: Type.String({ pattern: "^chunk_[0-9]{4}$" }),
  alias: Type.String({ pattern: "^[EC][0-9]{3}$" }),
}, { additionalProperties: false });
const EvidenceListSchema = Type.Array(AliasPointerSchema, { minItems: 1, maxItems: 1_000 });
const AliasedSourcedTextSchema = Type.Object({
  value: Nonblank(20_000),
  evidence: EvidenceListSchema,
}, { additionalProperties: false });
const AliasedEntitySchema = Type.Object({
  tempId: OpaqueId,
  name: AliasedSourcedTextSchema,
  aliases: Type.Array(AliasedSourcedTextSchema, { maxItems: 128 }),
  description: Type.Union([Type.Null(), AliasedSourcedTextSchema]),
  evidence: EvidenceListSchema,
}, { additionalProperties: false });
const AliasedSceneSchema = Type.Object({
  tempId: OpaqueId,
  order: Type.Integer({ minimum: 1, maximum: 100_000 }),
  title: AliasedSourcedTextSchema,
  locationTempId: Type.Union([Type.Null(), OpaqueId]),
  characterTempIds: Type.Array(OpaqueId, { maxItems: 1_000, uniqueItems: true }),
  evidence: EvidenceListSchema,
  timeOfDay: Type.Union([Type.Null(), AliasedSourcedTextSchema]),
}, { additionalProperties: false });
const AliasedDialogueSchema = Type.Object({
  tempId: OpaqueId,
  sceneTempId: OpaqueId,
  speakerTempId: Type.Union([Type.Null(), OpaqueId]),
  speakerEvidence: Type.Array(AliasPointerSchema, { maxItems: 1_000 }),
  source: Type.Object({
    evidence: AliasPointerSchema,
    quote: Nonblank(20_000),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
const AliasedCandidateSchema = Type.Object({
  synopsis: Type.Union([Type.Null(), AliasedSourcedTextSchema]),
  characters: Type.Array(AliasedEntitySchema, { maxItems: 2_000 }),
  locations: Type.Array(AliasedEntitySchema, { maxItems: 2_000 }),
  props: Type.Array(AliasedEntitySchema, { maxItems: 2_000 }),
  scenes: Type.Array(AliasedSceneSchema, { maxItems: 2_000 }),
  dialogues: Type.Array(AliasedDialogueSchema, { maxItems: 20_000 }),
}, { additionalProperties: false });

type AliasPointer = Static<typeof AliasPointerSchema>;
type AliasedSourcedText = Static<typeof AliasedSourcedTextSchema>;
type AliasedEntity = Static<typeof AliasedEntitySchema>;
type AliasedScene = Static<typeof AliasedSceneSchema>;
type AliasedDialogue = Static<typeof AliasedDialogueSchema>;
type AliasedCandidate = Static<typeof AliasedCandidateSchema>;

const validateAliasedCandidate = new Ajv({ allErrors: false }).compile<AliasedCandidate>(AliasedCandidateSchema);

export function resolveAliasedExtractFactsCandidate(
  value: unknown,
  aliases: ReadonlyMap<string, EvidenceAlias>,
): CreateExtractFactsCandidateRequest {
  if (!validateAliasedCandidate(value)) invalidStageOutput();
  const candidate = structuredClone(value) as AliasedCandidate;
  const resolveEvidence = (pointers: AliasPointer[]): SourceRef[] => {
    const resolved = pointers.map((pointer) => requireAlias(aliases, pointer));
    if (!resolved.some((entry) => entry.role === "primary")) {
      throw new BreakdownError(422, "CONTEXT_ONLY_EVIDENCE", "事实不能只引用上下文别名。");
    }
    return uniqueRefs(resolved.map((entry) => entry.sourceRef));
  };
  const sourced = (entry: AliasedSourcedText) => ({
    value: entry.value,
    origin: "source" as const,
    sourceRefs: resolveEvidence(entry.evidence),
    answerIds: [] as [],
  });
  const entity = (entry: AliasedEntity) => ({
    tempId: entry.tempId,
    name: sourced(entry.name),
    aliases: entry.aliases.map(sourced),
    description: entry.description ? sourced(entry.description) : null,
    sourceRefs: resolveEvidence(entry.evidence),
  });
  const scene = (entry: AliasedScene) => ({
    tempId: entry.tempId,
    order: entry.order,
    title: sourced(entry.title),
    locationTempId: entry.locationTempId,
    characterTempIds: [...entry.characterTempIds],
    sourceRefs: resolveEvidence(entry.evidence),
    timeOfDay: entry.timeOfDay ? sourced(entry.timeOfDay) : null,
  });
  const dialogue = (entry: AliasedDialogue) => {
    const sourceAlias = requireAlias(aliases, entry.source.evidence);
    if (sourceAlias.role !== "primary") {
      throw new BreakdownError(422, "CONTEXT_ONLY_EVIDENCE", "对白原文必须引用主证据别名。");
    }
    const speakerSourceRefs = entry.speakerEvidence.length ? resolveEvidence(entry.speakerEvidence) : [];
    if (entry.speakerTempId !== null && speakerSourceRefs.length === 0) invalidStageOutput();
    if (entry.speakerTempId === null && speakerSourceRefs.length > 0) invalidStageOutput();
    return {
      tempId: entry.tempId,
      sceneTempId: entry.sceneTempId,
      speakerTempId: entry.speakerTempId,
      speakerSourceRefs,
      speakerAnswerIds: [] as [],
      sourceRef: narrowQuote(sourceAlias.sourceRef, entry.source.quote),
    };
  };
  return {
    synopsis: candidate.synopsis ? sourced(candidate.synopsis) : null,
    characters: candidate.characters.map(entity),
    locations: candidate.locations.map(entity),
    props: candidate.props.map(entity),
    scenes: candidate.scenes.map(scene),
    dialogues: candidate.dialogues.map(dialogue),
  };
}

function requireAlias(aliases: ReadonlyMap<string, EvidenceAlias>, pointer: AliasPointer): EvidenceAlias {
  const alias = aliases.get(aliasKey(pointer.chunkId, pointer.alias));
  if (!alias) throw new BreakdownError(422, "UNKNOWN_EVIDENCE_ALIAS", "结果引用了当前任务不存在的证据别名。");
  return alias;
}

function aliasKey(chunkId: string, alias: string): string {
  return `${chunkId}:${alias}`;
}

function narrowQuote(container: SourceRef, quote: string): SourceRef {
  const haystack = Array.from(container.quote);
  const needle = Array.from(quote);
  const matches: number[] = [];
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((point, offset) => point === haystack[start + offset])) matches.push(start);
  }
  if (matches.length !== 1) {
    throw new BreakdownError(422, "DIALOGUE_QUOTE_AMBIGUOUS", "对白必须在所引证据中精确且唯一出现。");
  }
  const start = container.start + matches[0]!;
  return { scriptVersionId: container.scriptVersionId, start, end: start + needle.length, quote };
}

function uniqueRefs(refs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.scriptVersionId}:${ref.start}:${ref.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((ref) => ({ ...ref }));
}

function normalizeUsage(value: ModelCallUsage | null): ModelCallUsage | null {
  if (value === null) return null;
  const result: ModelCallUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const amount = value[key];
    if (amount !== undefined) {
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new BreakdownError(502, "MODEL_USAGE_INVALID", "模型适配器返回了无效的用量信息。");
      }
      result[key] = amount;
    }
  }
  return result;
}

function safeExecutionError(error: unknown): SafeExecutionError {
  if (error instanceof BreakdownError) return { code: error.code, message: error.message };
  return { code: "STAGE_EXECUTION_FAILED", message: "事实提取执行失败。" };
}

function invalidStageOutput(): never {
  throw new BreakdownError(422, "STAGE_OUTPUT_INVALID", "事实提取结果不符合阶段输出协议。");
}
