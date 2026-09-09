import { createHash } from "node:crypto";
import { canViewAsset, type AssetAccessRecord } from "../assets/access.js";
import { platformRoleOrMember } from "../auth/types.js";
import { ProjectAccessRepository } from "../project-access/repository.js";
import { ProjectAccessService } from "../project-access/service.js";
import type { ProjectAccessActor } from "../project-access/types.js";
import { canDecideProjectReview, reviewerForMediaKind } from "../reviews/repository.js";
import type { ReviewMediaKind } from "../reviews/types.js";
import type { Database } from "../../db/client.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import {
  EffectiveShotMediaRepository,
  type EffectiveShotMediaStore,
} from "../shot-media/effectiveSelectionRepository.js";
import {
  assetEndpointKey,
  ObjectContextRepository,
  projectAssetEndpointKey,
  type ProductionHierarchyRow,
  type ProductionMediaRow,
  type SceneProductionRow,
} from "./repository.js";
import type {
  EntityRef,
  ObjectContextQuery,
  ObjectContextResponse,
  ObjectKind,
  ObjectNextAction,
  ObjectState,
  ObjectSubject,
  ProductionGraphNode,
  ProductionGraphProjection,
  ProductionGraphQuery,
  EpisodeProductionStatus,
  SceneProductionStatus,
  SceneProductionStatusKind,
  SceneProductionStatusResponse,
  ProjectScopedEdge,
  RelationEdge,
} from "./types.js";

export interface ObjectContextServiceDependencies {
  access?: ProjectAccessService;
  effectiveShotMedia?: EffectiveShotMediaStore;
}

export class ObjectContextService {
  private readonly access: ProjectAccessService;
  private readonly effectiveShotMedia: EffectiveShotMediaStore;

  constructor(
    private readonly db: Database,
    private readonly repository = new ObjectContextRepository(db),
    dependencies: ObjectContextServiceDependencies = {},
  ) {
    this.access = dependencies.access
      ?? ProjectAccessService.fromDatabase(new ProjectAccessRepository(db));
    this.effectiveShotMedia = dependencies.effectiveShotMedia ?? new EffectiveShotMediaRepository(db);
  }

  async context(
    actorInput: ProjectAccessActor,
    kind: ObjectKind,
    id: string,
    input: ObjectContextQuery,
  ): Promise<ObjectContextResponse> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const scoped = new ObjectContextService(
        db,
        new ObjectContextRepository(db),
        {
          access: ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)),
        },
      );
      return scoped.contextWithinSnapshot(actorInput, kind, id, input);
    }, {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  }

  private async contextWithinSnapshot(
    actorInput: ProjectAccessActor,
    kind: ObjectKind,
    id: string,
    input: ObjectContextQuery,
  ): Promise<ObjectContextResponse> {
    const actor = actorWithRole(actorInput);
    if (input.projectContextId) {
      try {
        await this.access.requireReadable(actor, input.projectContextId);
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof ForbiddenError) {
          throw hiddenNotFound();
        }
        throw error;
      }
    }
    const subject = await this.requireSubject(actor, kind, id, input.projectContextId);
    if (input.projectContextId && subject.projectId && subject.projectId !== input.projectContextId) {
      throw hiddenNotFound();
    }

    const raw = await this.repository.loadEdges(kind, id);
    const [originProjection, usage] = await Promise.all([
      this.expandVisibleOrigin(
        actor,
        subject,
        raw.origin,
        input.originDepth,
        input.projectContextId,
      ),
      this.filterVisibleEdges(actor, subject, raw.usage, input.projectContextId),
    ]);
    const sortedOrigin = sortEdges(originProjection.edges);
    const sortedUsage = sortEdges(usage);
    const state = stateFor(
      subject,
      subject.projectId ? await this.canReadCost(actor, subject.projectId) : false,
    );
    const nextActions = input.include.has("next_actions")
      ? await this.actionsFor(actor, subject, input.projectContextId)
      : [];
    const usagePage = input.include.has("usage")
      ? pageEdges(sortedUsage, input.usageCursor, input.usagePageSize)
      : { edges: [], nextCursor: null };
    const originEdges = input.include.has("origin") ? sortedOrigin : [];
    const coverage = coverageFor(kind);
    const revision = revisionOf({
      subject: { ...subject.ref, revision: subject.updatedAt },
      state,
      origin: sortedOrigin,
      usage: sortedUsage,
      coverage,
    });

    return {
      schemaVersion: 1,
      subject: { ...subject.ref, revision: subject.updatedAt },
      revision,
      state,
      origin: { edges: originEdges, truncated: originProjection.truncated },
      usage: usagePage,
      nextActions,
      coverage,
    };
  }

  async productionGraph(
    actorInput: ProjectAccessActor,
    projectId: string,
    input: ProductionGraphQuery,
  ): Promise<ProductionGraphProjection> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const scoped = new ObjectContextService(
        db,
        new ObjectContextRepository(db),
        {
          access: ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)),
        },
      );
      return scoped.productionGraphWithinSnapshot(actorInput, projectId, input);
    }, {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  }

  private async productionGraphWithinSnapshot(
    actorInput: ProjectAccessActor,
    projectId: string,
    input: ProductionGraphQuery,
  ): Promise<ProductionGraphProjection> {
    const actor = actorWithRole(actorInput);
    try {
      await this.access.requireReadable(actor, projectId);
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ForbiddenError) {
        throw hiddenNotFound();
      }
      throw error;
    }
    const scope = await this.repository.resolveScope(
      projectId,
      input.scopeKind,
      input.scopeId,
    );
    if (!scope) throw hiddenNotFound();

    const rows = await this.repository.loadProductionHierarchy(
      projectId,
      input.scopeKind,
      input.scopeId,
    );
    if (rows.length === 0) {
      const project = await this.requireSubject(actor, "project", projectId);
      const state = stateFor(project);
      return graphResponse(projectId, scope, input.preset, [
        graphNode("project", project.ref, state, []),
      ], [], []);
    }
    const shotIds = rows.flatMap((row) => row.shotId ? [row.shotId] : []);
    const [mediaRows, effective] = await Promise.all([
      this.repository.loadProductionMedia(projectId, shotIds),
      this.effectiveShotMedia.resolve(projectId, rows.flatMap((row) => row.shotId ? [{
        id: row.shotId,
        selectedImageResultId: row.selectedImageResultId,
        selectedVideoResultId: row.selectedVideoResultId,
      }] : [])),
    ]);
    const effectiveRows = rows.map((row) => {
      if (!row.shotId) return row;
      const selected = effective.get(row.shotId);
      return {
        ...row,
        selectedImageResultId: selected?.image?.id ?? null,
        selectedVideoResultId: selected?.video?.id ?? null,
      };
    });
    const writable = await this.canCreate(actor, projectId);
    const { nodes, edges, actions } = buildProductionGraph(effectiveRows, mediaRows, writable);
    return graphResponse(projectId, scope, input.preset, nodes, edges, actions);
  }

  async episodeProductionStatus(
    actorInput: ProjectAccessActor,
    episodeId: string,
  ): Promise<EpisodeProductionStatus> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const scoped = new ObjectContextService(db, new ObjectContextRepository(db), {
        access: ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)),
      });
      return scoped.episodeProductionStatusWithinSnapshot(actorInput, episodeId);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async sceneProductionStatus(
    actorInput: ProjectAccessActor,
    sceneId: string,
  ): Promise<SceneProductionStatusResponse> {
    return this.db.transaction(async (transaction) => {
      const db = transaction as unknown as Database;
      const scoped = new ObjectContextService(db, new ObjectContextRepository(db), {
        access: ProjectAccessService.fromDatabase(new ProjectAccessRepository(db)),
      });
      return scoped.sceneProductionStatusWithinSnapshot(actorInput, sceneId);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  private async episodeProductionStatusWithinSnapshot(
    actorInput: ProjectAccessActor,
    episodeId: string,
  ): Promise<EpisodeProductionStatus> {
    const actor = actorWithRole(actorInput);
    const projectId = await this.repository.loadEpisodeProjectId(episodeId);
    if (!projectId) throw hiddenNotFound();
    await this.requireProjectReadable(actor, projectId);
    const scenes = serializeSceneProductionRows(await this.repository.loadEpisodeProductionRows(episodeId));
    const aggregate = aggregateEpisodeProductionStatus(scenes);
    const payload = {
      episodeId,
      projectId,
      productionStatus: aggregate.productionStatus,
      statusLabel: productionStatusLabel(aggregate.productionStatus),
      sceneCount: scenes.length,
      deliveredSceneCount: aggregate.statusCounts.delivered,
      hasInFlight: aggregate.hasInFlight,
      nextSceneId: aggregate.nextSceneId,
      statusCounts: aggregate.statusCounts,
      scenes,
    };
    return { schemaVersion: 1, revision: revisionOf(payload), ...payload };
  }

  private async sceneProductionStatusWithinSnapshot(
    actorInput: ProjectAccessActor,
    sceneId: string,
  ): Promise<SceneProductionStatusResponse> {
    const rows = await this.repository.loadSceneProductionRows(sceneId);
    const first = rows[0];
    if (!first) throw hiddenNotFound();
    await this.requireProjectReadable(actorWithRole(actorInput), first.projectId);
    const scene = serializeSceneProductionRows(rows)[0];
    if (!scene) throw hiddenNotFound();
    const payload = { scene };
    return { schemaVersion: 1, revision: revisionOf(payload), ...payload };
  }

  private async requireProjectReadable(actor: ProjectAccessActor, projectId: string): Promise<void> {
    try {
      await this.access.requireReadable(actor, projectId);
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ForbiddenError) throw hiddenNotFound();
      throw error;
    }
  }

  private async requireSubject(
    actor: ProjectAccessActor,
    kind: ObjectKind,
    id: string,
    projectContextId?: string,
  ): Promise<ObjectSubject> {
    const subject = await this.repository.loadSubject(kind, id);
    if (!subject) throw hiddenNotFound();
    if (kind === "asset_entity" || kind === "asset_media") {
      const record: AssetAccessRecord = {
        id: subject.ref.id,
        ownerUserId: subject.ownerUserId,
        visibility: subject.visibility === "common" ? "common" : "personal",
        status: subject.platformReviewStatus ?? "",
        deletedAt: null,
      };
      const directlyVisible = (
        (subject.visibility === "common" || subject.visibility === "personal")
        && canViewAsset(record, actor.id, false, actor.role === "admin")
      );
      const publicationVisible = (
        subject.visibility !== "common"
        || subject.platformReviewStatus === "approved"
        || actor.role === "admin"
      );
      const projectVisible = !directlyVisible && publicationVisible && projectContextId
        ? (await this.repository.loadProjectAssetEndpointAccess(
          [projectContextId],
          [subject.ref],
        )).has(projectAssetEndpointKey(projectContextId, kind, id))
        : false;
      if (!directlyVisible && !projectVisible) throw hiddenNotFound();
      return subject;
    }
    if (!subject.projectId) throw hiddenNotFound();
    try {
      await this.access.requireReadable(actor, subject.projectId);
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ForbiddenError) {
        throw hiddenNotFound();
      }
      throw error;
    }
    return subject;
  }

  private async filterVisibleEdges(
    actor: ProjectAccessActor,
    subject: ObjectSubject,
    candidates: ProjectScopedEdge[],
    projectContextId?: string,
  ): Promise<RelationEdge[]> {
    const readableProjects = await this.access.filterReadableProjectIds(
      actor,
      candidates.flatMap((candidate) => candidate.projectId ? [candidate.projectId] : []),
    );
    const projectFiltered = candidates.filter((candidate) =>
      candidate.projectId === null || readableProjects.has(candidate.projectId),
    );
    const assetRefs = projectFiltered.flatMap((candidate) =>
      [candidate.edge.from, candidate.edge.to]
        .filter(isAssetRef)
        .filter((ref) => !(ref.kind === subject.ref.kind && ref.id === subject.ref.id)),
    );
    const assetAccess = await this.repository.loadAssetEndpointAccess(assetRefs);
    const projectIds = [
      ...readableProjects,
      ...(projectContextId ? [projectContextId] : []),
    ];
    const projectAssetAccess = await this.repository.loadProjectAssetEndpointAccess(
      projectIds,
      assetRefs,
    );
    const result: RelationEdge[] = [];
    for (const candidate of projectFiltered) {
      const endpointRefs = [candidate.edge.from, candidate.edge.to]
        .filter(isAssetRef)
        .filter((ref) => !(ref.kind === subject.ref.kind && ref.id === subject.ref.id));
      const effectiveProjectId = candidate.projectId ?? projectContextId;
      const visible = endpointRefs.every((ref) => {
        const access = assetAccess.get(assetEndpointKey(ref.kind, ref.id));
        if (!access || (access.visibility !== "common" && access.visibility !== "personal")) return false;
        const directlyVisible = canViewAsset({
          id: access.id,
          ownerUserId: access.ownerUserId,
          visibility: access.visibility,
          status: access.status,
          deletedAt: null,
        }, actor.id, false, actor.role === "admin");
        const publicationVisible = (
          access.visibility !== "common"
          || access.status === "approved"
          || actor.role === "admin"
        );
        return directlyVisible || (publicationVisible && (
          effectiveProjectId !== undefined
          && projectAssetAccess.has(projectAssetEndpointKey(effectiveProjectId, ref.kind, ref.id))
        ));
      });
      if (visible) result.push(candidate.edge);
    }
    return result;
  }

  private async expandVisibleOrigin(
    actor: ProjectAccessActor,
    subject: ObjectSubject,
    firstLevel: ProjectScopedEdge[],
    maxDepth: number,
    projectContextId?: string,
  ): Promise<{ edges: RelationEdge[]; truncated: boolean }> {
    const edgeMap = new Map<string, RelationEdge>();
    const seenNodes = new Set([entityKey(subject.ref)]);
    const expandedNodes = new Set([entityKey(subject.ref)]);
    let candidates = firstLevel;
    let truncated = false;

    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const visible = await this.filterVisibleEdges(
        actor,
        subject,
        candidates,
        projectContextId,
      );
      const nextRefs = new Map<string, EntityRef>();
      for (const edge of visible) {
        const newNodeKeys = [edge.from, edge.to]
          .map(entityKey)
          .filter((key) => !seenNodes.has(key));
        if (seenNodes.size + newNodeKeys.length > 200) {
          truncated = true;
          continue;
        }
        edgeMap.set(edge.id, edge);
        seenNodes.add(entityKey(edge.from));
        seenNodes.add(entityKey(edge.to));
        for (const ref of [edge.from, edge.to]) {
          if (!isObjectRef(ref)) continue;
          const key = entityKey(ref);
          if (expandedNodes.has(key)) continue;
          expandedNodes.add(key);
          nextRefs.set(key, ref);
        }
      }
      if (truncated || nextRefs.size === 0) break;

      const nextCandidates = await this.repository.loadOriginEdges([...nextRefs.values()]);
      if (depth === maxDepth) {
        const visibleContinuation = await this.filterVisibleEdges(
          actor,
          subject,
          nextCandidates,
          projectContextId,
        );
        truncated = visibleContinuation.some((edge) => !edgeMap.has(edge.id));
        break;
      }
      candidates = nextCandidates;
    }

    return { edges: [...edgeMap.values()], truncated };
  }

  private async actionsFor(
    actor: ProjectAccessActor,
    subject: ObjectSubject,
    projectContextId?: string,
  ): Promise<ObjectNextAction[]> {
    if (subject.ref.kind === "asset_entity") {
      return this.assetActions(actor, subject, projectContextId);
    }
    if (subject.ref.kind === "shot") {
      if (!subject.projectId || !subject.shotId) return shotActions(subject, false);
      const [writable, effective] = await Promise.all([
        this.canCreate(actor, subject.projectId),
        this.effectiveShotMedia.resolve(subject.projectId, [{
          id: subject.shotId,
          selectedImageResultId: subject.selectedImageResultId,
          selectedVideoResultId: subject.selectedVideoResultId,
        }]),
      ]);
      const selected = effective.get(subject.shotId);
      return shotActions({
        ...subject,
        selectedImageResultId: selected?.image?.id ?? null,
        selectedVideoResultId: selected?.video?.id ?? null,
      }, writable);
    }
    if (subject.ref.kind === "media_result") {
      const [writable, reviewable] = subject.projectId
        ? await Promise.all([
          this.canCreate(actor, subject.projectId),
          this.canReviewMediaResult(actor, subject),
        ])
        : [false, false];
      return mediaResultActions(
        subject,
        writable,
        reviewable,
      );
    }
    return [];
  }

  private async assetActions(
    actor: ProjectAccessActor,
    subject: ObjectSubject,
    projectContextId?: string,
  ): Promise<ObjectNextAction[]> {
    if (!projectContextId) {
      return [{
        key: "open_asset",
        label: "查看资产",
        enabled: true,
        disabledReason: null,
        reasonCodes: ["asset_visible"],
        effect: "navigation",
        requiresHumanConfirmation: false,
        inputSchemaKey: null,
        invocation: { kind: "route", href: `/assets/${subject.ref.id}` },
      }];
    }
    const [available, writable] = await Promise.all([
      this.repository.isAssetAvailableInProject(subject.ref.id, projectContextId),
      this.canCreate(actor, projectContextId),
    ]);
    return [{
      key: "add_asset_to_project",
      label: available ? "已加入项目" : "加入项目",
      enabled: writable && !available,
      disabledReason: available
        ? "该资产已在项目中"
        : writable ? null : "你在该项目中没有编辑权限",
      reasonCodes: available ? ["already_available_in_project"] : ["asset_not_in_project"],
      effect: "domain_write",
      requiresHumanConfirmation: false,
      inputSchemaKey: "project_asset_reference_v1",
      invocation: writable && !available ? {
        kind: "existing_api",
        method: "POST",
        href: `/api/v1/projects/${projectContextId}/assets`,
        presetBody: { asset_entity_id: subject.ref.id },
      } : null,
    }];
  }

  private async canCreate(actor: ProjectAccessActor, projectId: string): Promise<boolean> {
    try {
      await this.access.requireCreative(actor, projectId);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof NotFoundError) return false;
      throw error;
    }
  }

  private async canReadCost(actor: ProjectAccessActor, projectId: string): Promise<boolean> {
    try {
      await this.access.requireCostReadable(actor, projectId);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenError || error instanceof NotFoundError) return false;
      throw error;
    }
  }

  private async canReviewMediaResult(
    actor: ProjectAccessActor,
    subject: ObjectSubject,
  ): Promise<boolean> {
    if (!subject.projectId) return false;
    const mediaKind = reviewMediaKind(subject.mediaKind);
    if (!mediaKind) return false;
    const access = await this.access.requireReadable(actor, subject.projectId);
    const assignedReviewer = await reviewerForMediaKind(
      this.db,
      subject.projectId,
      mediaKind,
    );
    return canDecideProjectReview(access, actor.id, assignedReviewer);
  }
}

function actorWithRole(actor: ProjectAccessActor): ProjectAccessActor {
  return { id: actor.id, role: platformRoleOrMember(actor.role) };
}

function isAssetRef(
  ref: EntityRef,
): ref is EntityRef & { kind: "asset_entity" | "asset_media" } {
  return ref.kind === "asset_entity" || ref.kind === "asset_media";
}

function isObjectRef(ref: EntityRef): ref is EntityRef & { kind: ObjectKind } {
  return ref.kind === "project"
    || ref.kind === "shot"
    || ref.kind === "asset_entity"
    || ref.kind === "asset_media"
    || ref.kind === "media_result";
}

function entityKey(ref: EntityRef): string {
  return `${ref.kind}:${ref.id}`;
}

function stateFor(subject: ObjectSubject, includeProviderCost = false): ObjectState {
  const blockers: ObjectState["blockers"] = [];
  if (subject.ref.kind === "shot" && subject.controlPackageReady === false) {
    blockers.push({ code: "control_package_not_ready", message: "控制包尚未由人标记就绪" });
  }
  if (subject.ref.kind === "media_result" && subject.persistenceStatus !== "persisted") {
    blockers.push({ code: "media_not_persisted", message: "产物尚未完成持久化" });
  }
  if (subject.ref.kind === "media_result" && subject.mediaReviewStatus === "needs_review") {
    blockers.push({ code: "media_needs_review", message: "产物等待人工审核" });
  }
  const review: ObjectState["review"] = subject.ref.kind === "asset_entity" || subject.ref.kind === "asset_media"
    ? {
      platformStatus: subject.platformReviewStatus,
      projectStatus: null,
      mediaStatus: null,
      coverage: "legacy_global_only",
    }
    : subject.ref.kind === "media_result"
      ? {
        platformStatus: null,
        projectStatus: null,
        mediaStatus: subject.mediaReviewStatus,
        coverage: "complete",
      }
      : {
        platformStatus: null,
        projectStatus: null,
        mediaStatus: null,
        coverage: "not_applicable",
      };
  return {
    ...(subject.lifecycle ? { lifecycle: subject.lifecycle } : {}),
    ...(subject.ref.kind === "shot" ? {
      readiness: subject.controlPackageReady ? "ready" : "not_ready",
    } : {}),
    ...(subject.executionStatus ? { execution: subject.executionStatus } : {}),
    ...(subject.persistenceStatus ? { persistence: subject.persistenceStatus } : {}),
    review,
    ...(subject.ref.kind === "media_result" ? {
      delivery: isSelected(subject) ? "selected_primary" : "not_selected",
    } : {}),
    ...(includeProviderCost && subject.providerCost ? { providerCost: subject.providerCost } : {}),
    blockers,
  };
}

function shotActions(subject: ObjectSubject, writable: boolean): ObjectNextAction[] {
  const actions: ObjectNextAction[] = [];
  if (!subject.controlPackageReady) {
    actions.push({
      key: "complete_control_package",
      label: "补充参考",
      enabled: true,
      disabledReason: null,
      reasonCodes: ["control_package_not_ready"],
      effect: "navigation",
      requiresHumanConfirmation: false,
      inputSchemaKey: null,
      invocation: { kind: "route", href: `/shots/${subject.ref.id}/workbench` },
    });
    actions.push({
      key: "mark_control_package_ready",
      label: "标记就绪",
      enabled: writable,
      disabledReason: writable ? null : "你在该项目中没有编辑权限",
      reasonCodes: ["human_readiness_required"],
      effect: "domain_write",
      requiresHumanConfirmation: true,
      inputSchemaKey: null,
      invocation: writable ? {
        kind: "existing_api",
        method: "PUT",
        href: `/api/v1/shots/${subject.ref.id}/control-package/ready`,
        presetBody: { ready: true },
      } : null,
    });
  }
  const targetKind = subject.selectedImageResultId ? "video" : "image";
  actions.push({
    key: `estimate_${targetKind}_generation`,
    label: `估价并生成${targetKind === "image" ? "图片" : "视频"}`,
    enabled: writable && subject.controlPackageReady === true,
    disabledReason: !writable
      ? "你在该项目中没有编辑权限"
      : subject.controlPackageReady ? null : "请先由人确认控制包就绪",
    reasonCodes: subject.controlPackageReady ? ["generation_input_ready"] : ["control_package_not_ready"],
    effect: "paid",
    requiresHumanConfirmation: true,
    inputSchemaKey: `generation_estimate_${targetKind}_v1`,
    invocation: writable && subject.controlPackageReady ? {
      kind: "paid_quote",
      method: "POST",
      quoteHref: "/api/v1/generations/estimate",
      confirmFlow: "generation_quote_v1",
    } : null,
  });
  return actions;
}

function mediaResultActions(
  subject: ObjectSubject,
  writable: boolean,
  reviewable: boolean,
): ObjectNextAction[] {
  const actions: ObjectNextAction[] = [];
  if (subject.mediaReviewStatus === "needs_review" && subject.projectId) {
    actions.push({
      key: "review_media_result",
      label: "审核产物",
      enabled: reviewable,
      disabledReason: reviewable ? null : "你在该项目中没有审核权限",
      reasonCodes: ["media_needs_review"],
      effect: "domain_write",
      requiresHumanConfirmation: true,
      inputSchemaKey: "media_review_decision_v1",
      invocation: reviewable ? {
        kind: "existing_api",
        method: "POST",
        href: `/api/v1/projects/${subject.projectId}/media-reviews/decisions`,
        presetBody: { decisions: [{ media_result_id: subject.ref.id }] },
      } : null,
    });
  }
  if (!isSelected(subject) && subject.shotId) {
    actions.push({
      key: "select_primary_media",
      label: "设为主版本",
      enabled: writable && subject.mediaReviewStatus === "accepted",
      disabledReason: !writable
        ? "你在该项目中没有编辑权限"
        : subject.mediaReviewStatus === "accepted" ? null : "产物通过审核后才能设为主版本",
      reasonCodes: subject.mediaReviewStatus === "accepted"
        ? ["media_review_cleared"]
        : ["media_review_not_cleared"],
      effect: "domain_write",
      requiresHumanConfirmation: true,
      inputSchemaKey: null,
      invocation: writable && subject.mediaReviewStatus === "accepted" ? {
        kind: "existing_api",
        method: "POST",
        href: `/api/v1/shots/${subject.shotId}/media/${subject.ref.id}/set-primary`,
      } : null,
    });
  }
  return actions;
}

function isSelected(subject: ObjectSubject): boolean {
  return subject.selectedImageResultId === subject.ref.id || subject.selectedVideoResultId === subject.ref.id;
}

function reviewMediaKind(value: string | null): ReviewMediaKind | null {
  return value === "image" || value === "video" || value === "audio" ? value : null;
}

function coverageFor(kind: ObjectKind): ObjectContextResponse["coverage"] {
  switch (kind) {
    case "project":
      return { complete: false, omittedRelationKinds: ["project_origin", "storyboard_import_products"] };
    case "shot":
      return { complete: false, omittedRelationKinds: ["storyboard_import_product"] };
    case "asset_entity":
      return { complete: false, omittedRelationKinds: ["reference_tests", "project_review_status"] };
    case "asset_media":
      return { complete: false, omittedRelationKinds: ["media_provenance", "reference_tests"] };
    case "media_result":
      return { complete: false, omittedRelationKinds: ["normalized_delivery_items"] };
  }
}

function pageEdges(
  edges: RelationEdge[],
  cursor: string | undefined,
  pageSize: number,
): { edges: RelationEdge[]; nextCursor: string | null } {
  let start = 0;
  if (cursor) {
    let decoded: string;
    try {
      decoded = Buffer.from(cursor, "base64url").toString("utf8");
    } catch {
      throw new BadRequestError("素材使用记录的翻页标记无效，请重新加载");
    }
    const found = edges.findIndex((edge) => edge.id === decoded);
    if (found < 0) throw new BadRequestError("素材使用记录已更新，请重新加载");
    start = found + 1;
  }
  const page = edges.slice(start, start + pageSize);
  const hasMore = start + page.length < edges.length;
  return {
    edges: page,
    nextCursor: hasMore && page.length
      ? Buffer.from(page[page.length - 1]!.id, "utf8").toString("base64url")
      : null,
  };
}

function sortEdges(edges: RelationEdge[]): RelationEdge[] {
  return [...edges].sort((a, b) => a.id.localeCompare(b.id));
}

function revisionOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const productionStatusOrder: SceneProductionStatusKind[] = [
  "not_broken_down", "broken_down", "preparing", "ready", "generating", "has_media", "delivered",
];

const productionStatusLabels: Record<SceneProductionStatusKind, string> = {
  not_broken_down: "未拆解",
  broken_down: "已拆解",
  preparing: "备戏中",
  ready: "就位",
  generating: "生成中",
  has_media: "有样片或成片",
  delivered: "已交付",
};

function productionStatusLabel(status: SceneProductionStatusKind): string {
  return productionStatusLabels[status];
}

function serializeSceneProductionRows(rows: SceneProductionRow[]): SceneProductionStatus[] {
  const byScene = new Map<string, SceneProductionRow[]>();
  for (const row of rows) {
    const list = byScene.get(row.sceneId) ?? [];
    list.push(row);
    byScene.set(row.sceneId, list);
  }
  return [...byScene.values()].map((sceneRows) => serializeSceneProductionStatus(sceneRows));
}

function serializeSceneProductionStatus(rows: SceneProductionRow[]): SceneProductionStatus {
  const first = rows[0]!;
  const shots = new Map<string, SceneProductionRow[]>();
  for (const row of rows) {
    if (!row.shotId) continue;
    const list = shots.get(row.shotId) ?? [];
    list.push(row);
    shots.set(row.shotId, list);
  }
  const shotRows = [...shots.values()];
  const attempts = rows.filter((row) => row.attemptStatus === "pending" || row.attemptStatus === "running");
  const inFlightShots = shotRows.filter((entries) => entries.some((row) => (
    row.attemptStatus === "pending" || row.attemptStatus === "running"
  )));
  const primaryShots = shotRows.filter((entries) => entries[0]!.primaryMediaResultId !== null);
  const deliveredShots = primaryShots.filter((entries) => entries[0]!.primaryDelivered);
  const controlPackageStarted = shotRows.filter((entries) => entries[0]!.controlPackageId !== null).length;
  const readyShots = shotRows.filter((entries) => entries[0]!.controlPackageReady).length;
  const allPrimaryDelivered = shotRows.length > 0 && deliveredShots.length === shotRows.length;
  const allHavePrimaryVideo = shotRows.length > 0 && primaryShots.length === shotRows.length;
  const allReady = shotRows.length > 0 && readyShots === shotRows.length;
  const productionStatus: SceneProductionStatusKind = shotRows.length === 0
    ? "not_broken_down"
    : inFlightShots.length > 0 ? "generating"
      : allPrimaryDelivered ? "delivered"
        : allHavePrimaryVideo ? "has_media"
          : allReady ? "ready"
            : controlPackageStarted > 0 ? "preparing"
              : "broken_down";
  const primaryModes = primaryShots.map((entries) => entries[0]!.primaryProductionMode);
  const cover = primaryShots[0]?.[0];
  const updatedAt = rows.reduce((latest, row) => {
    for (const candidate of [row.sceneUpdatedAt, row.shotUpdatedAt, row.attemptUpdatedAt, row.primaryMediaCreatedAt]) {
      if (candidate && candidate > latest) latest = candidate;
    }
    return latest;
  }, first.sceneUpdatedAt);
  return {
    sceneId: first.sceneId,
    episodeId: first.episodeId,
    sceneNo: first.sceneNo,
    name: first.sceneName,
    sortOrder: first.sceneSortOrder,
    productionStatus,
    statusLabel: productionStatusLabel(productionStatus),
    shotSummary: {
      total: shotRows.length,
      controlPackageStarted,
      ready: readyShots,
      inFlight: inFlightShots.length,
      withPrimaryVideo: primaryShots.length,
      delivered: deliveredShots.length,
    },
    controlPackageSummary: {
      filledLaneCount: new Set(shotRows.flatMap((entries) => entries[0]!.filledLanes)).size,
      enabledLaneCount: first.enabledLaneCount,
    },
    attemptSummary: {
      pending: attempts.filter((row) => row.attemptStatus === "pending").length,
      running: attempts.filter((row) => row.attemptStatus === "running").length,
      queuePosition: minQueuePosition(attempts),
    },
    outputSummary: {
      samplePrimaryCount: primaryModes.filter((mode) => mode === "sample").length,
      fullPrimaryCount: primaryModes.filter((mode) => mode === "full").length,
    },
    coverMedia: cover?.primaryMediaResultId ? {
      mediaResultId: cover.primaryMediaResultId,
      productionMode: cover.primaryProductionMode,
      mediaKind: cover.primaryMediaKind ?? "video",
      storageUrl: cover.primaryMediaStorageUrl,
      mimeType: cover.primaryMediaMimeType,
      createdAt: cover.primaryMediaCreatedAt ?? cover.shotUpdatedAt ?? first.sceneUpdatedAt,
    } : null,
    updatedAt,
  };
}

function minQueuePosition(rows: SceneProductionRow[]): number | null {
  const positions = rows.flatMap((row) => row.attemptStatus === "pending" && row.queuePosition !== null
    ? [row.queuePosition] : []);
  return positions.length ? Math.min(...positions) : null;
}

function aggregateEpisodeProductionStatus(scenes: SceneProductionStatus[]): {
  productionStatus: SceneProductionStatusKind;
  statusCounts: Record<SceneProductionStatusKind, number>;
  hasInFlight: boolean;
  nextSceneId: string | null;
} {
  const statusCounts = Object.fromEntries(
    productionStatusOrder.map((status) => [status, 0]),
  ) as Record<SceneProductionStatusKind, number>;
  for (const scene of scenes) statusCounts[scene.productionStatus] += 1;
  const productionStatus = scenes.length === 0 ? "not_broken_down" : productionStatusOrder.find(
    (status) => statusCounts[status] > 0,
  )!;
  return {
    productionStatus,
    statusCounts,
    hasInFlight: scenes.some((scene) => scene.shotSummary.inFlight > 0),
    nextSceneId: scenes.find((scene) => scene.productionStatus === productionStatus)?.sceneId ?? null,
  };
}

function hiddenNotFound(): NotFoundError {
  return new NotFoundError("对象不存在或你没有访问权限");
}

function buildProductionGraph(
  rows: ProductionHierarchyRow[],
  mediaRows: ProductionMediaRow[],
  writable: boolean,
): {
  nodes: ProductionGraphNode[];
  edges: RelationEdge[];
  actions: ObjectNextAction[];
} {
  const nodes = new Map<string, ProductionGraphNode>();
  const edges = new Map<string, RelationEdge>();
  const actions = new Map<string, ObjectNextAction>();
  const first = rows[0]!;
  const projectRef: EntityRef = {
    kind: "project",
    id: first.projectId,
    displayName: first.projectName,
  };
  nodes.set(`project:${first.projectId}`, graphNode(
    "project",
    projectRef,
    { lifecycle: first.projectStatus, review: notApplicableReview(), blockers: [] },
    [],
  ));

  const mediaByShot = new Map<string, ProductionMediaRow[]>();
  for (const media of mediaRows) {
    const list = mediaByShot.get(media.shotId) ?? [];
    list.push(media);
    mediaByShot.set(media.shotId, list);
  }

  for (const row of rows) {
    if (!row.episodeId) continue;
    const episodeRef: EntityRef = {
      kind: "episode",
      id: row.episodeId,
      displayName: row.episodeName ?? `第${row.episodeNo}集`,
    };
    nodes.set(`episode:${row.episodeId}`, graphNode(
      "episode",
      episodeRef,
      { lifecycle: row.episodeStatus ?? "active", review: notApplicableReview(), blockers: [] },
      [],
    ));
    edges.set(
      `contains:project:${row.projectId}:episode:${row.episodeId}`,
      edge("contains", projectRef, episodeRef, "authoritative"),
    );
    if (row.sceneId) {
      const sceneRef: EntityRef = {
        kind: "scene",
        id: row.sceneId,
        displayName: row.sceneName ?? `第${row.sceneNo}场`,
      };
      nodes.set(`scene:${row.sceneId}`, graphNode(
        "scene",
        sceneRef,
        { lifecycle: "active", review: notApplicableReview(), blockers: [] },
        [],
      ));
      edges.set(
        `contains:episode:${row.episodeId}:scene:${row.sceneId}`,
        edge("contains", episodeRef, sceneRef, "authoritative"),
      );
    }
    if (!row.shotId) continue;
    const shotRef: EntityRef = {
      kind: "shot",
      id: row.shotId,
      displayName: row.shotTitle ?? row.shotCode ?? row.shotId,
    };
    const blockers: ObjectState["blockers"] = row.controlPackageReady
      ? [] : [{ code: "control_package_not_ready", message: "控制包尚未由人标记就绪" }];
    const shotState: ObjectState = {
      lifecycle: "active",
      readiness: row.controlPackageReady ? "ready" : "not_ready",
      review: notApplicableReview(),
      blockers,
    };
    const projectedSubject: ObjectSubject = {
      ref: shotRef,
      projectId: row.projectId,
      ownerUserId: null,
      visibility: null,
      episodeId: row.episodeId,
      shotId: row.shotId,
      mediaKind: null,
      selectedImageResultId: row.selectedImageResultId,
      selectedVideoResultId: row.selectedVideoResultId,
      lifecycle: "active",
      platformReviewStatus: null,
      mediaReviewStatus: null,
      persistenceStatus: null,
      executionStatus: null,
      controlPackageReady: row.controlPackageReady,
      updatedAt: row.shotUpdatedAt ?? row.projectUpdatedAt,
      providerCost: null,
    };
    const shotActionList = shotActions(projectedSubject, writable).map((action) => ({
      ...action,
      key: `shot:${row.shotId}:${action.key}`,
    }));
    for (const action of shotActionList) actions.set(action.key, action);
    nodes.set(`shot:${row.shotId}`, graphNode(
      "shot",
      shotRef,
      shotState,
      shotActionList.map((action) => action.key),
    ));
    edges.set(
      `contains:episode:${row.episodeId}:shot:${row.shotId}`,
      edge("contains", episodeRef, shotRef, "authoritative"),
    );
    if (row.sceneId) {
      const sceneRef = nodes.get(`scene:${row.sceneId}`)!.subject!;
      edges.set(
        `contains:scene:${row.sceneId}:shot:${row.shotId}`,
        edge("contains", sceneRef, shotRef, "authoritative"),
      );
    }
    for (const media of mediaByShot.get(row.shotId) ?? []) {
      const mediaRef: EntityRef = {
        kind: "media_result",
        id: media.id,
        displayName: `${media.mediaKind} result`,
      };
      const mediaState: ObjectState = {
        execution: media.executionStatus ?? undefined,
        persistence: media.persistenceStatus,
        review: {
          platformStatus: null,
          projectStatus: null,
          mediaStatus: media.reviewStatus,
          coverage: "complete",
        },
        delivery: row.selectedImageResultId === media.id || row.selectedVideoResultId === media.id
          ? "selected_primary" : "not_selected",
        blockers: [],
      };
      nodes.set(`media_result:${media.id}`, graphNode("media-result", mediaRef, mediaState, []));
      edges.set(
        `contains:shot:${row.shotId}:media_result:${media.id}`,
        edge("contains", shotRef, mediaRef, "authoritative"),
      );
    }
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    actions: [...actions.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

function graphResponse(
  projectId: string,
  scope: EntityRef,
  preset: "pipeline" | "canvas",
  nodes: ProductionGraphNode[],
  edges: RelationEdge[],
  actions: ObjectNextAction[],
): ProductionGraphProjection {
  const interaction = preset === "pipeline"
    ? { move: "locked", connect: "locked", create: "locked", remove: "locked" } as const
    : { move: "free", connect: "free", create: "free", remove: "free" } as const;
  const payload = { scope, nodes, edges, actions };
  return {
    schemaVersion: 1,
    graphId: `${projectId}:${scope.kind}:${scope.id}`,
    revision: revisionOf(payload),
    scope,
    nodes,
    edges,
    view: { preset, interaction },
    actions,
  };
}

function graphNode(
  renderer: string,
  subject: EntityRef,
  state: ObjectState,
  actionKeys: string[],
): ProductionGraphNode {
  return {
    id: `${renderer}:${subject.kind}:${subject.id}`,
    role: subject.kind === "project" || subject.kind === "episode" || subject.kind === "scene"
      ? "group" : subject.kind === "media_result" ? "result" : "entity",
    renderer,
    subject,
    state,
    actionKeys,
  };
}

function edge(
  relation: RelationEdge["relation"],
  from: EntityRef,
  to: EntityRef,
  truth: RelationEdge["truth"],
): RelationEdge {
  return {
    id: `${relation}:${from.kind}:${from.id}:${to.kind}:${to.id}`,
    relation,
    from,
    to,
    truth,
  };
}

function notApplicableReview(): NonNullable<ObjectState["review"]> {
  return {
    platformStatus: null,
    projectStatus: null,
    mediaStatus: null,
    coverage: "not_applicable",
  };
}
