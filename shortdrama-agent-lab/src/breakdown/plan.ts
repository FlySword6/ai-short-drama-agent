import Ajv from "ajv";
import { Type, type Static } from "@sinclair/typebox";
import type { BreakdownRequirements } from "./contracts";
import { BreakdownError } from "./errors";
import { sliceCodePoints, type SourceRef } from "./source-index";

export const PLAN_CONTENT_SCHEMA_VERSION = "breakdown-plan-content/1";
export const PLAN_VALIDATOR_VERSION = "extract-facts-validator/1";

const OpaqueId = Type.String({ minLength: 3, maxLength: 128, pattern: "^[a-z][a-z0-9_-]*$" });
const Nonblank = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: "\\S" });
const SourceRefSchema = Type.Object({
  scriptVersionId: OpaqueId,
  start: Type.Integer({ minimum: 0 }),
  end: Type.Integer({ minimum: 1 }),
  quote: Nonblank(200_000),
}, { additionalProperties: false });
const SourceRefs = Type.Array(SourceRefSchema, { minItems: 1, maxItems: 1_000 });
const SourcedTextSchema = Type.Object({
  value: Nonblank(20_000),
  origin: Type.Literal("source"),
  sourceRefs: SourceRefs,
  answerIds: Type.Array(OpaqueId, { maxItems: 0 }),
}, { additionalProperties: false });
const CandidateEntitySchema = Type.Object({
  tempId: OpaqueId,
  name: SourcedTextSchema,
  aliases: Type.Array(SourcedTextSchema, { maxItems: 128 }),
  description: Type.Union([Type.Null(), SourcedTextSchema]),
  sourceRefs: SourceRefs,
}, { additionalProperties: false });
const CandidateSceneSchema = Type.Object({
  tempId: OpaqueId,
  order: Type.Integer({ minimum: 1, maximum: 100_000 }),
  title: SourcedTextSchema,
  locationTempId: Type.Union([Type.Null(), OpaqueId]),
  characterTempIds: Type.Array(OpaqueId, { maxItems: 1_000, uniqueItems: true }),
  sourceRefs: SourceRefs,
  timeOfDay: Type.Union([Type.Null(), SourcedTextSchema]),
}, { additionalProperties: false });
const CandidateDialogueSchema = Type.Object({
  tempId: OpaqueId,
  sceneTempId: OpaqueId,
  speakerTempId: Type.Union([Type.Null(), OpaqueId]),
  speakerSourceRefs: Type.Array(SourceRefSchema, { maxItems: 1_000 }),
  speakerAnswerIds: Type.Array(OpaqueId, { maxItems: 0 }),
  sourceRef: SourceRefSchema,
}, { additionalProperties: false });

export const CreateExtractFactsCandidateSchema = Type.Object({
  synopsis: Type.Union([Type.Null(), SourcedTextSchema]),
  characters: Type.Array(CandidateEntitySchema, { maxItems: 2_000 }),
  locations: Type.Array(CandidateEntitySchema, { maxItems: 2_000 }),
  props: Type.Array(CandidateEntitySchema, { maxItems: 2_000 }),
  scenes: Type.Array(CandidateSceneSchema, { maxItems: 2_000 }),
  dialogues: Type.Array(CandidateDialogueSchema, { maxItems: 20_000 }),
}, { additionalProperties: false });

export type CreateExtractFactsCandidateRequest = Static<typeof CreateExtractFactsCandidateSchema>;
export type SourcedText = Static<typeof SourcedTextSchema>;

export interface PlanEntity extends Omit<Static<typeof CandidateEntitySchema>, "tempId"> { id: string }
export interface PlanScene extends Omit<Static<typeof CandidateSceneSchema>, "tempId" | "locationTempId" | "characterTempIds"> {
  id: string;
  locationId: string | null;
  characterIds: string[];
  shots: [];
}
export interface PlanDialogue extends Omit<Static<typeof CandidateDialogueSchema>, "tempId" | "sceneTempId" | "speakerTempId"> {
  id: string;
  sceneId: string;
  speakerId: string | null;
}
export interface ExtractFactsPlanContent {
  schemaVersion: typeof PLAN_CONTENT_SCHEMA_VERSION;
  synopsis: SourcedText | null;
  characters: PlanEntity[];
  locations: PlanEntity[];
  props: PlanEntity[];
  dialogues: PlanDialogue[];
  scenes: PlanScene[];
  assetRequirements: [];
  manualLocks: [];
}

export interface PlanRevisionRecord {
  id: string;
  projectId: string;
  scriptVersionId: string;
  runId: string;
  sourceTaskId: string;
  /** Null for a manually submitted P0.3 candidate; set for a recorded stage execution. */
  attemptId: string | null;
  parentRevisionId: null;
  rebasedFromRevisionId: null;
  createdAt: string;
  createdBy: "agent";
  reason: "extract";
  scope: { kind: "project"; targetId: null };
  requirements: BreakdownRequirements;
  content: ExtractFactsPlanContent;
  status: "candidate";
  validatorVersion: typeof PLAN_VALIDATOR_VERSION;
}

interface ScriptForPlanValidation { id: string; rawText: string }

const ajv = new Ajv({ allErrors: false });
const validateRequest = ajv.compile<CreateExtractFactsCandidateRequest>(CreateExtractFactsCandidateSchema);

export function parseCreateExtractFactsCandidate(value: unknown): CreateExtractFactsCandidateRequest {
  if (!validateRequest(value)) {
    throw new BreakdownError(400, "INVALID_CANDIDATE_PLAN_REQUEST", "候选事实请求不符合约定。");
  }
  return structuredClone(value) as CreateExtractFactsCandidateRequest;
}

export function materializeExtractFactsCandidate(input: CreateExtractFactsCandidateRequest, context: {
  script: ScriptForPlanValidation;
  nextId: (prefix: string) => string;
}): ExtractFactsPlanContent {
  if (!validateRequest(input)) invalid("候选事实结构无效。");
  const tempIds = new Set<string>();
  for (const entry of [...input.characters, ...input.locations, ...input.props, ...input.scenes, ...input.dialogues]) {
    if (tempIds.has(entry.tempId)) invalid("临时 ID 必须在候选内唯一。");
    tempIds.add(entry.tempId);
  }

  const characterIds = allocate(input.characters, "character", context.nextId);
  const locationIds = allocate(input.locations, "location", context.nextId);
  const propIds = allocate(input.props, "prop", context.nextId);
  const sceneIds = allocate(input.scenes, "scene", context.nextId);
  const dialogueIds = allocate(input.dialogues, "dialogue", context.nextId);

  validateSceneOrder(input.scenes.map((scene) => scene.order));
  validateCandidateSourceRefs(input, context.script);

  const scenes = [...input.scenes].sort((left, right) => left.order - right.order).map((scene): PlanScene => {
    const locationId = scene.locationTempId === null ? null : locationIds.get(scene.locationTempId);
    if (scene.locationTempId !== null && !locationId) invalid("场次引用了不存在的地点。");
    const mappedCharacters = scene.characterTempIds.map((tempId) => {
      const id = characterIds.get(tempId);
      if (!id) invalid("场次引用了不存在的人物。");
      return id;
    });
    return {
      id: required(sceneIds.get(scene.tempId)), order: scene.order, title: cloneSourced(scene.title),
      locationId: locationId ?? null, characterIds: mappedCharacters,
      sourceRefs: cloneRefs(scene.sourceRefs), timeOfDay: scene.timeOfDay ? cloneSourced(scene.timeOfDay) : null,
      shots: [],
    };
  });

  const candidateScenes = new Map(input.scenes.map((scene) => [scene.tempId, scene]));
  const dialogues = input.dialogues.map((dialogue): PlanDialogue => {
    const scene = candidateScenes.get(dialogue.sceneTempId);
    const sceneId = sceneIds.get(dialogue.sceneTempId);
    if (!scene || !sceneId) invalid("对白引用了不存在的场次。");
    const speakerId = dialogue.speakerTempId === null ? null : characterIds.get(dialogue.speakerTempId);
    if (dialogue.speakerTempId !== null && !speakerId) invalid("对白引用了不存在的人物。");
    if (dialogue.speakerTempId !== null) {
      if (!scene.characterTempIds.includes(dialogue.speakerTempId)) invalid("对白说话人不在所属场次人物列表中。");
      if (dialogue.speakerSourceRefs.length === 0) invalid("已确认的对白说话人必须有原文依据。");
    } else if (dialogue.speakerSourceRefs.length > 0) {
      invalid("说话人未知时不能保存已确认的说话人依据。");
    }
    if (!scene.sourceRefs.some((ref) => contains(ref, dialogue.sourceRef))) {
      invalid("对白原文必须位于所属场次的原文范围内。");
    }
    return {
      id: required(dialogueIds.get(dialogue.tempId)), sceneId, speakerId: speakerId ?? null,
      speakerSourceRefs: cloneRefs(dialogue.speakerSourceRefs), speakerAnswerIds: [],
      sourceRef: { ...dialogue.sourceRef },
    };
  });
  validateDialogueOrder(dialogues, scenes);

  return {
    schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
    synopsis: input.synopsis ? cloneSourced(input.synopsis) : null,
    characters: input.characters.map((entity) => materializeEntity(entity, required(characterIds.get(entity.tempId)))),
    locations: input.locations.map((entity) => materializeEntity(entity, required(locationIds.get(entity.tempId)))),
    props: input.props.map((entity) => materializeEntity(entity, required(propIds.get(entity.tempId)))),
    dialogues,
    scenes,
    assetRequirements: [],
    manualLocks: [],
  };
}

export function validateStoredPlanContent(content: ExtractFactsPlanContent, script: ScriptForPlanValidation): void {
  if (content.schemaVersion !== PLAN_CONTENT_SCHEMA_VERSION) invalid("候选计划版本不受支持。");
  if (!Array.isArray(content.assetRequirements) || content.assetRequirements.length !== 0
    || !Array.isArray(content.manualLocks) || content.manualLocks.length !== 0
    || !Array.isArray(content.scenes) || content.scenes.some((scene) => !Array.isArray(scene.shots) || scene.shots.length !== 0)) {
    invalid("事实候选不能提前包含分镜、资产需求或人工锁。");
  }
  const ids = new Set<string>();
  for (const item of [...content.characters, ...content.locations, ...content.props, ...content.scenes, ...content.dialogues]) {
    if (ids.has(item.id)) invalid("候选计划稳定 ID 重复。");
    ids.add(item.id);
  }
  const candidate: CreateExtractFactsCandidateRequest = {
    synopsis: content.synopsis,
    characters: content.characters.map(({ id, ...entry }) => ({ tempId: id, ...entry })),
    locations: content.locations.map(({ id, ...entry }) => ({ tempId: id, ...entry })),
    props: content.props.map(({ id, ...entry }) => ({ tempId: id, ...entry })),
    scenes: content.scenes.map(({ id, locationId, characterIds, shots, ...entry }) => ({
      tempId: id, locationTempId: locationId, characterTempIds: characterIds, ...entry,
    })),
    dialogues: content.dialogues.map(({ id, sceneId, speakerId, ...entry }) => ({
      tempId: id, sceneTempId: sceneId, speakerTempId: speakerId, ...entry,
    })),
  };
  if (!validateRequest(candidate)) invalid("已保存的候选计划结构无效。");
  let ordinal = 0;
  materializeExtractFactsCandidate(candidate, { script, nextId: (_prefix) => `validated_${++ordinal}` });
}

function materializeEntity(entity: Static<typeof CandidateEntitySchema>, id: string): PlanEntity {
  return {
    id, name: cloneSourced(entity.name), aliases: entity.aliases.map(cloneSourced),
    description: entity.description ? cloneSourced(entity.description) : null,
    sourceRefs: cloneRefs(entity.sourceRefs),
  };
}

function validateCandidateSourceRefs(input: CreateExtractFactsCandidateRequest, script: ScriptForPlanValidation): void {
  const refs: SourceRef[] = [];
  const addValue = (value: SourcedText | null) => { if (value) refs.push(...value.sourceRefs); };
  addValue(input.synopsis);
  for (const entity of [...input.characters, ...input.locations, ...input.props]) {
    addValue(entity.name); entity.aliases.forEach(addValue); addValue(entity.description); refs.push(...entity.sourceRefs);
  }
  for (const scene of input.scenes) {
    addValue(scene.title); addValue(scene.timeOfDay); refs.push(...scene.sourceRefs);
  }
  for (const dialogue of input.dialogues) refs.push(dialogue.sourceRef, ...dialogue.speakerSourceRefs);
  for (const ref of refs) {
    if (ref.scriptVersionId !== script.id || ref.end <= ref.start) invalid("原文引用没有绑定当前剧本版本或范围无效。");
    let quote: string;
    try { quote = sliceCodePoints(script.rawText, ref.start, ref.end); }
    catch { invalid("原文引用超出剧本范围。"); }
    if (quote! !== ref.quote) invalid("原文引用的 quote 与 Unicode 码点范围不一致。");
  }
}

function validateSceneOrder(orders: number[]): void {
  const sorted = [...orders].sort((a, b) => a - b);
  if (sorted.some((order, index) => order !== index + 1)) invalid("场次 order 必须从 1 开始且连续唯一。");
}

function validateDialogueOrder(dialogues: PlanDialogue[], scenes: PlanScene[]): void {
  const sceneOrder = new Map(scenes.map((scene) => [scene.id, scene.order]));
  let previous: [number, number] | null = null;
  for (const dialogue of dialogues) {
    const current: [number, number] = [required(sceneOrder.get(dialogue.sceneId)), dialogue.sourceRef.start];
    if (previous && (current[0] < previous[0] || (current[0] === previous[0] && current[1] <= previous[1]))) {
      invalid("对白必须按场次和原文顺序排列，且不能重复起点。");
    }
    previous = current;
  }
}

function allocate<T extends { tempId: string }>(items: T[], prefix: string, nextId: (prefix: string) => string): Map<string, string> {
  return new Map(items.map((item) => [item.tempId, nextId(prefix)]));
}
function cloneSourced(value: SourcedText): SourcedText { return { ...value, sourceRefs: cloneRefs(value.sourceRefs), answerIds: [] }; }
function cloneRefs(refs: SourceRef[]): SourceRef[] { return refs.map((ref) => ({ ...ref })); }
function contains(outer: SourceRef, inner: SourceRef): boolean {
  return outer.scriptVersionId === inner.scriptVersionId && outer.start <= inner.start && outer.end >= inner.end;
}
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error("internal candidate mapping error"); return value; }
function invalid(message: string): never { throw new BreakdownError(422, "CANDIDATE_PLAN_INVALID", message); }
