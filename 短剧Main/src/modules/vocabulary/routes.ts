import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { requireAdministrator } from "../auth/admin.js";
import { DrizzleVocabularyRepository } from "./repository.js";
import { AssetKindVocabularyService, TagVocabularyService, VocabularyService } from "./service.js";
import {
  VOCABULARY_DOMAINS,
  type AssetKindVocabularyRepository,
  type AssetTagRepository,
  type TagVocabularyRepository,
  type VocabularyRepository,
} from "./types.js";

const entryIdSchema = z.string().regex(
  /^[a-z][a-z0-9_]{0,23}$/,
  "编号请用小写字母开头，只能包含小写字母、数字或下划线，最多 24 个字符",
);

const laneRecommendationBody = z.object({
  key: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(200),
  required: z.boolean(),
}).strict();

const createEntryBody = z.object({
  id: entryIdSchema,
  display_name: z.string().trim().min(1).max(64),
  domain: z.enum(VOCABULARY_DOMAINS),
  pick_kind: z.string().trim().min(1).max(32).nullish(),
  sort: z.number().int().min(0).max(9999).default(0),
  recommended: z.array(laneRecommendationBody).max(20).optional(),
}).strict();

const createGenreBody = z.object({
  id: z.string().trim().min(1).max(32),
  sort: z.number().int().min(0).max(9999).default(0),
}).strict();

const ensureGenreBody = z.object({
  id: z.string().trim().min(1).max(32),
}).strict();

// S41:标签/资产类型 id 是开放字符串(允许中文,genre 先例),不走 entryIdSchema。
const tagIdSchema = z.string().trim().min(1).max(64);
const assetKindIdSchema = z.string().trim().min(1).max(32);
const tagDomainSchema = z.string().trim().min(1).max(32);

const ensureTagBody = z.object({
  id: tagIdSchema,
  domain: tagDomainSchema.optional(),
  display_name: z.string().trim().min(1).max(64).optional(),
  sort: z.number().int().min(0).max(9999).default(0),
}).strict();

const createTagBody = z.object({
  id: tagIdSchema,
  canonical_id: tagIdSchema.optional(),
  domain: tagDomainSchema.optional(),
  display_name: z.string().trim().min(1).max(64).optional(),
  sort: z.number().int().min(0).max(9999).default(0),
}).strict();

const createAssetKindBody = z.object({
  id: assetKindIdSchema,
  canonical_id: assetKindIdSchema.optional(),
  display_name: z.string().trim().min(1).max(64).optional(),
  sort: z.number().int().min(0).max(9999).default(0),
}).strict();

export interface RegisterVocabularyRoutesOptions {
  createRepository?: () => VocabularyRepository;
  createTagRepository?: () => TagVocabularyRepository & AssetTagRepository;
  createAssetKindRepository?: () => AssetKindVocabularyRepository;
}

/**
 * Vocabulary reads are login-readable (S18 picker source); writes are admin
 * only. The integration owner wires this once from src/http/routes.ts.
 */
export async function registerVocabularyRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  options: RegisterVocabularyRoutesOptions = {},
): Promise<void> {
  const createRepository = options.createRepository
    ?? (() => new DrizzleVocabularyRepository(getDatabase()));
  const service = () => new VocabularyService(createRepository());
  const createTagRepository = options.createTagRepository
    ?? (() => new DrizzleVocabularyRepository(getDatabase()));
  const tagService = () => new TagVocabularyService(createTagRepository(), createTagRepository());
  const createAssetKindRepository = options.createAssetKindRepository
    ?? (() => new DrizzleVocabularyRepository(getDatabase()));
  const assetKindService = () => new AssetKindVocabularyService(createAssetKindRepository());

  app.get("/api/v1/vocabulary/reference-lanes", async (request) => {
    requireCurrentUser(request);
    const lanes = await service().listReferenceLanes();
    return success({ lanes });
  });

  app.get("/api/v1/vocabulary/asset-roles", async (request) => {
    requireCurrentUser(request);
    const roles = await service().listAssetRoles();
    return success({ roles });
  });

  app.get("/api/v1/vocabulary/genres", async (request) => {
    requireCurrentUser(request);
    const genres = await service().listGenres();
    return success({ genres });
  });

  app.post("/api/v1/admin/vocabulary/reference-lanes", async (request, reply) => {
    const user = requireCurrentUser(request);
    requireAdministrator(user);
    const input = parseRequest(createEntryBody, request.body);
    const entry = await service().createReferenceLane({
      id: input.id,
      displayName: input.display_name,
      domain: input.domain,
      pickKind: input.pick_kind ?? null,
      sort: input.sort,
      recommended: input.recommended,
      createdBy: user.id,
    });
    return reply.code(201).send(success({ entry }));
  });

  app.post("/api/v1/admin/vocabulary/asset-roles", async (request, reply) => {
    const user = requireCurrentUser(request);
    requireAdministrator(user);
    const input = parseRequest(createEntryBody, request.body);
    const entry = await service().createAssetRole({
      id: input.id,
      displayName: input.display_name,
      domain: input.domain,
      pickKind: input.pick_kind ?? null,
      sort: input.sort,
      createdBy: user.id,
    });
    return reply.code(201).send(success({ entry }));
  });

  app.post("/api/v1/vocabulary/genres", async (request, reply) => {
    const user = requireCurrentUser(request);
    const input = parseRequest(ensureGenreBody, request.body);
    const { entry, created } = await service().ensureGenre(input.id, user.id);
    return reply.code(created ? 201 : 200).send(success({ entry }));
  });

  app.post("/api/v1/admin/vocabulary/genres", async (request, reply) => {
    const user = requireCurrentUser(request);
    requireAdministrator(user);
    const input = parseRequest(createGenreBody, request.body);
    const entry = await service().createGenre({
      id: input.id,
      sort: input.sort,
      createdBy: user.id,
    });
    return reply.code(201).send(success({ entry }));
  });

  /* ---------------- S41 标签词表(自指 canonical) ---------------- */

  app.get("/api/v1/vocabulary/tags", async (request) => {
    requireCurrentUser(request);
    const tags = await tagService().listTags();
    return success({ tags });
  });

  // 登录即可 ensure 规范词(幂等):用户输入的新标签长成共享词表的规范词。
  app.post("/api/v1/vocabulary/tags", async (request, reply) => {
    const user = requireCurrentUser(request);
    const input = parseRequest(ensureTagBody, request.body);
    const { entry, created } = await tagService().ensureTag(input.id, {
      domain: input.domain,
      displayName: input.display_name,
      sort: input.sort,
      createdBy: user.id,
    });
    return reply.code(created ? 201 : 200).send(success({ entry, created }));
  });

  // 管理员:可登记规范词或别名(别名做一跳校验,目标必须本身是规范词)。
  app.post("/api/v1/admin/vocabulary/tags", async (request, reply) => {
    const user = requireCurrentUser(request);
    requireAdministrator(user);
    const input = parseRequest(createTagBody, request.body);
    const entry = await tagService().createTag({
      id: input.id,
      canonicalId: input.canonical_id ?? input.id,
      domain: input.domain,
      displayName: input.display_name,
      sort: input.sort,
      createdBy: user.id,
    });
    return reply.code(201).send(success({ entry }));
  });

  /* ---------------- S41 资产类型词表(自指 canonical) ---------------- */

  app.get("/api/v1/vocabulary/asset-kinds", async (request) => {
    requireCurrentUser(request);
    const kinds = await assetKindService().listAssetKinds();
    return success({ kinds });
  });

  app.post("/api/v1/admin/vocabulary/asset-kinds", async (request, reply) => {
    const user = requireCurrentUser(request);
    requireAdministrator(user);
    const input = parseRequest(createAssetKindBody, request.body);
    const entry = await assetKindService().createAssetKind({
      id: input.id,
      canonicalId: input.canonical_id ?? input.id,
      displayName: input.display_name,
      sort: input.sort,
      createdBy: user.id,
    });
    return reply.code(201).send(success({ entry }));
  });
}
