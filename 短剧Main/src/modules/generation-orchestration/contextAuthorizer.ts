import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import {
  episodes,
  generationAttempts,
  generationRequests,
  mediaProvenanceSubjects,
  projectAssetRefs,
  scenes,
  shots,
} from "../../db/schema.js";
import { ConflictError } from "../../shared/errors.js";
import { DbVoiceCatalogProvider } from "../audio/voiceCatalogProvider.js";
import type { VoiceCatalogProvider } from "../audio/types.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import { DrizzleGenerationReferenceResolver } from "./quoteAdapters.js";
import type {
  AuthorizedGenerationTurnContext,
  GenerationReferenceResolver,
  GenerationTurnContext,
  GenerationTurnContextAuthorizer,
  GenerationVoiceResolver,
  TrustedSelectedAudioSource,
} from "./types.js";

type CreativeAccess = Pick<ProjectAccessService, "requireCreative">;

/**
 * One authorization path for mock and real orchestration. The provider mode is
 * intentionally absent: changing from mock to real cannot change what project
 * context or selected media the caller is allowed to use.
 */
export class DrizzleGenerationTurnContextAuthorizer implements GenerationTurnContextAuthorizer {
  private readonly references: GenerationReferenceResolver;
  private readonly access: CreativeAccess;

  constructor(
    private readonly db: Database,
    dependencies: {
      references?: GenerationReferenceResolver;
      access?: CreativeAccess;
    } = {},
  ) {
    this.references = dependencies.references ?? new DrizzleGenerationReferenceResolver(db);
    this.access = dependencies.access
      ?? ProjectAccessService.fromDatabase(new ProjectAccessRepository(db));
  }

  async authorize(
    actorId: string,
    context: GenerationTurnContext,
    mediaKind?: "image" | "video" | "audio",
  ): Promise<AuthorizedGenerationTurnContext> {
    await this.access.requireCreative({ id: actorId }, context.projectId);
    await this.assertHierarchy(context);
    if (mediaKind && context.referenceMediaIds.length > 0) {
      await this.references.resolve(actorId, mediaKind, context.referenceMediaIds);
    }

    if (!context.selectedAsset) return { context };
    const selectedSnapshots = await this.references.resolve(
      actorId,
      context.selectedAsset.mediaKind,
      [context.selectedAsset.mediaId],
    );
    const selectedSnapshot = selectedSnapshots[0];
    if (!selectedSnapshot) throw selectedAssetMismatch();
    const selectedAsset = await this.references.resolveSelectedAsset(
      context.selectedAsset,
      selectedSnapshot,
    );
    await this.assertSelectedAssetInProject(context.projectId, selectedAsset.assetEntityId);
    const authorizedContext = {
      ...context,
      selectedAsset,
    };
    if (selectedAsset.mediaKind !== "audio") {
      return { context: authorizedContext };
    }
    const selectedAudioSource = await this.loadTrustedAudioSource(
      context.projectId,
      selectedAsset.mediaId,
    );
    return {
      context: authorizedContext,
      ...(selectedAudioSource ? { selectedAudioSource } : {}),
    };
  }

  private async assertHierarchy(context: GenerationTurnContext): Promise<void> {
    if (context.episodeId) {
      const episode = (await this.db.select({
        id: episodes.id,
        projectId: episodes.projectId,
      }).from(episodes).where(and(
        eq(episodes.id, context.episodeId),
        isNull(episodes.deletedAt),
      )).limit(1))[0];
      if (!episode || episode.projectId !== context.projectId) throw hierarchyMismatch();
    }

    if (context.sceneId) {
      const scene = (await this.db.select({
        id: scenes.id,
        episodeId: scenes.episodeId,
        projectId: episodes.projectId,
      }).from(scenes).innerJoin(
        episodes,
        eq(scenes.episodeId, episodes.id),
      ).where(and(
        eq(scenes.id, context.sceneId),
        isNull(scenes.deletedAt),
        isNull(episodes.deletedAt),
      )).limit(1))[0];
      if (
        !scene
        || scene.projectId !== context.projectId
        || (context.episodeId !== undefined && scene.episodeId !== context.episodeId)
      ) {
        throw hierarchyMismatch();
      }
    }

    if (context.shotId) {
      const shot = (await this.db.select({
        id: shots.id,
        episodeId: shots.episodeId,
        sceneId: shots.sceneId,
        projectId: episodes.projectId,
        linkedSceneId: scenes.id,
        linkedSceneEpisodeId: scenes.episodeId,
        linkedSceneDeletedAt: scenes.deletedAt,
      }).from(shots).innerJoin(
        episodes,
        eq(shots.episodeId, episodes.id),
      ).leftJoin(
        scenes,
        eq(shots.sceneId, scenes.id),
      ).where(and(
        eq(shots.id, context.shotId),
        isNull(shots.deletedAt),
        isNull(episodes.deletedAt),
      )).limit(1))[0];
      if (
        !shot
        || shot.projectId !== context.projectId
        || (context.episodeId !== undefined && shot.episodeId !== context.episodeId)
        || (context.sceneId !== undefined && shot.sceneId !== context.sceneId)
        || !linkedShotSceneIsConsistent({
          shotEpisodeId: shot.episodeId,
          shotSceneId: shot.sceneId,
          linkedSceneId: shot.linkedSceneId,
          linkedSceneEpisodeId: shot.linkedSceneEpisodeId,
          linkedSceneDeletedAt: shot.linkedSceneDeletedAt,
        })
      ) {
        throw hierarchyMismatch();
      }
    }
  }

  private async assertSelectedAssetInProject(
    projectId: string,
    assetEntityId: string,
  ): Promise<void> {
    const row = (await this.db.select({ id: projectAssetRefs.id })
      .from(projectAssetRefs)
      .where(and(
        eq(projectAssetRefs.projectId, projectId),
        eq(projectAssetRefs.assetEntityId, assetEntityId),
        isNull(projectAssetRefs.deletedAt),
      ))
      .limit(1))[0];
    if (!row) throw selectedAssetMismatch();
  }

  private async loadTrustedAudioSource(
    projectId: string,
    mediaId: string,
  ): Promise<TrustedSelectedAudioSource | undefined> {
    const row = (await this.db.select({
      prompt: generationRequests.prompt,
      parameters: generationRequests.parameters,
    }).from(mediaProvenanceSubjects).innerJoin(
      generationAttempts,
      eq(mediaProvenanceSubjects.sourceGenerationAttemptId, generationAttempts.id),
    ).innerJoin(
      generationRequests,
      eq(generationAttempts.requestId, generationRequests.id),
    ).where(and(
      eq(mediaProvenanceSubjects.assetMediaId, mediaId),
      eq(generationAttempts.status, "succeeded"),
      eq(generationRequests.projectId, projectId),
      eq(generationRequests.mediaKind, "audio"),
    )).limit(1))[0];
    if (!row) return undefined;
    const prompt = row.prompt.trim();
    if (!prompt) return undefined;
    return {
      prompt,
      parameters: row.parameters,
    };
  }
}

export class CatalogGenerationVoiceResolver implements GenerationVoiceResolver {
  constructor(
    private readonly catalog: VoiceCatalogProvider,
  ) {}

  static fromDatabase(db: Database): CatalogGenerationVoiceResolver {
    return new CatalogGenerationVoiceResolver(new DbVoiceCatalogProvider(() => db));
  }

  async resolveByGender(
    gender: "male" | "female",
  ): Promise<{ speakerId: string; displayName: string } | null> {
    const voices = await this.catalog.listVoices();
    const matched = voices.find((voice) => matchesGender(voice.gender, gender));
    return matched
      ? { speakerId: matched.id, displayName: matched.displayName }
      : null;
  }

  async resolveSpeakerId(speakerId: string): Promise<string | null> {
    const needle = speakerId.trim();
    if (!needle) return null;
    const voice = (await this.catalog.listVoices()).find((item) => item.id === needle);
    return voice?.id ?? null;
  }

  async listSpeakerIds(): Promise<string[]> {
    return (await this.catalog.listVoices()).map((voice) => voice.id);
  }
}

export function linkedShotSceneIsConsistent(input: {
  shotEpisodeId: string;
  shotSceneId: string | null;
  linkedSceneId: string | null;
  linkedSceneEpisodeId: string | null;
  linkedSceneDeletedAt: Date | null;
}): boolean {
  if (input.shotSceneId === null) return true;
  return input.linkedSceneId === input.shotSceneId
    && input.linkedSceneEpisodeId === input.shotEpisodeId
    && input.linkedSceneDeletedAt === null;
}

function matchesGender(
  value: string | undefined,
  expected: "male" | "female",
): boolean {
  const normalized = value?.normalize("NFKC").trim().toLowerCase() ?? "";
  return expected === "male"
    ? normalized === "男" || normalized === "男声" || normalized === "male"
    : normalized === "女" || normalized === "女声" || normalized === "female";
}

function hierarchyMismatch(): ConflictError {
  return new ConflictError(
    "当前项目、集、场或镜头的归属不一致，请刷新后重试。",
    "assistant_context_mismatch",
  );
}

function selectedAssetMismatch(): ConflictError {
  return new ConflictError(
    "当前选中媒体不属于这个项目或与资产不一致，请刷新后重试。",
    "selected_asset_mismatch",
  );
}
