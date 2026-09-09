import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { episodes, projects, shots } from "../../db/schema.js";
import { AppError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { HybridAssetSearchService } from "../assets/hybridSearchService.js";
import { LlmSearchQueryTokenizer } from "../assets/llmSearchQueryTokenizer.js";
import { DrizzleAiCallRepository } from "../ai/repository.js";
import { AiGatewayService, ArkAiCompletionProvider } from "../ai/service.js";
import { ProjectAssetService } from "../project-assets/service.js";
import { configuredGenerationModel, createGenerationRepository, createGenerationService } from "../generation/factory.js";
import { generationData, generationParameters } from "../generation/routes.js";
import type { AssistantToolServices, DirectorCommandPort } from "./types.js";

export function createAssistantToolServices(
  db: Database,
  dependencies: AssistantToolServiceDependencies = {},
): AssistantToolServices {
  const assetSearch = () => dependencies.createHybridSearchService?.(db)
    ?? createDefaultHybridSearchService(db);
  return {
    searchAssets: async (input) => {
      const result = await assetSearch().search({
        actorId: input.actorId,
        query: input.query,
        page: 1,
        pageSize: input.limit,
      });
      return receipt("asset_search", {
        items: result.items.map((item) => ({
          score: item.score,
          lexical_hit: item.lexicalHit === true,
          semantic_hit: item.semanticHit === true,
          source_table: item.sourceTable,
          source_id: item.sourceId,
          asset_kind: item.assetKind ?? null,
          name: item.name ?? null,
          display_name: item.displayName ?? null,
          description: item.description ?? item.intro ?? null,
        })),
        count: result.items.length,
        mode: "hybrid",
        degraded: !result.diagnostics.semanticAvailable,
        ...(!result.diagnostics.semanticAvailable ? { degraded_reason: "semantic_search_unavailable" } : {}),
        diagnostics: result.diagnostics,
      });
    },

    addProjectAsset: async (input) => {
      const reference = await new ProjectAssetService(db).addReference(
        input.actorId,
        input.projectId,
        {
          assetEntityId: input.assetEntityId,
          assetVariantId: input.assetVariantId,
          assetMediaId: input.assetMediaId,
        },
      );
      return receipt("project_asset_added", {
        added: true,
        reference_id: reference.id,
        project_id: reference.project_id,
        asset_entity_id: reference.asset_entity_id,
        asset_variant_id: reference.asset_variant_id,
        asset_media_id: reference.asset_media_id,
      });
    },

    executeDirectorCommand: async (input) => {
      await assertProjectAccess(db, input.actorId, input.projectId);
      const result = await (dependencies.director ?? unavailableDirectorPort).execute(input);
      return receipt("director_command", result);
    },

    prepareGenerationCard: async (input) => {
      if (input.shotId) {
        await assertShotAccess(db, input.actorId, input.projectId, input.shotId);
      }
      const model = configuredGenerationModel(input.mediaKind)?.trim();
      if (!model) throw new AppError(503, "generation_model_missing", "生成模型还没有配置");
      const repository = createGenerationRepository(db);
      const referenceMediaIds = [...new Set(input.referenceMediaIds)];
      const snapshots = await repository.resolveReferenceSnapshots(
        input.actorId,
        input.mediaKind,
        referenceMediaIds,
      );
      return receipt("generation_preparation", {
        preparation_card: {
          project_id: input.projectId,
          shot_id: input.shotId,
          media_kind: input.mediaKind,
          model,
          prompt: input.prompt,
          parameters: generationParameters(input.parameters),
          reference_media_ids: referenceMediaIds,
          reference_count: snapshots.length,
        },
        submission_required: true,
        notice: "已准备生成卡；请在页面检查后由人点击一次生成。助手不会创建任务、自动重试或夜间生成。",
      });
    },

    getGenerationTask: async (input) => {
      const repository = createGenerationRepository(db);
      const view = await createGenerationService(repository).get(
        { userId: input.actorId },
        input.requestId,
      );
      return receipt("generation_task", assistantGenerationData(view));
    },
  };
}

interface AssistantToolServiceDependencies {
  director?: DirectorCommandPort;
  createHybridSearchService?: (db: Database) => Pick<HybridAssetSearchService, "search">;
}

function createDefaultHybridSearchService(db: Database): HybridAssetSearchService {
  const gateway = new AiGatewayService(
    new DrizzleAiCallRepository(db),
    new ArkAiCompletionProvider(),
  );
  return new HybridAssetSearchService(db, {
    lexicalTokenizer: new LlmSearchQueryTokenizer(gateway),
  });
}

const unavailableDirectorPort: DirectorCommandPort = {
  async execute() {
    throw new AppError(503, "director_service_unavailable", "导演台暂未接入，未执行任何动作", true);
  },
};

function receipt(kind: string, result: Record<string, unknown>): Record<string, unknown> {
  return { receipt: { kind, status: "completed" }, ...result };
}

async function assertProjectAccess(db: Database, actorId: string, projectId: string): Promise<void> {
  const project = (await db.select({ ownerUserId: projects.ownerUserId }).from(projects).where(and(
    eq(projects.id, projectId), isNull(projects.deletedAt),
  )).limit(1))[0];
  if (!project) throw new NotFoundError("项目不存在");
  if (project.ownerUserId !== actorId) throw new ForbiddenError();
}

async function assertShotAccess(
  db: Database,
  actorId: string,
  projectId: string,
  shotId: string,
): Promise<void> {
  const row = (await db.select({ ownerUserId: projects.ownerUserId }).from(shots)
    .innerJoin(episodes, eq(shots.episodeId, episodes.id))
    .innerJoin(projects, eq(episodes.projectId, projects.id))
    .where(and(
      eq(shots.id, shotId),
      eq(projects.id, projectId),
      isNull(shots.deletedAt), isNull(episodes.deletedAt), isNull(projects.deletedAt),
    )).limit(1))[0];
  if (!row) throw new NotFoundError("分镜不存在或不属于当前项目");
  if (row.ownerUserId !== actorId) throw new ForbiddenError();
}

export function assistantGenerationData(
  view: Parameters<typeof generationData>[0],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  // Keep this assistant projection tied to the generation module's public
  // serializer. Provider model IDs, task handles, and raw failures therefore
  // cannot reappear here when the generation view evolves.
  const publicView = generationData(view);
  return {
    ...extra,
    generation_request_id: publicView.generation_request_id,
    current_attempt_id: publicView.current_attempt_id,
    status: publicView.status,
    phase: publicView.phase,
    attempt_no: publicView.attempt_no,
    media_kind: view.mediaKind,
    tier_id: publicView.tier_id,
    display_reason: publicView.display_reason,
    estimated_cost_fen: publicView.estimated_cost_fen,
    result_count: view.media.length,
    updated_at: publicView.updated_at,
  };
}
