import {
  PRODUCTION_WORKFLOW_VERSION, canonicalDigest, productionId, productionStageOrder,
  type CreateProductionRun, type OutboxEvent, type ProductionStage, type ProductionTask,
  type StoredProductionRun,
} from './contracts';

export const productionStageLabels: Record<ProductionStage, string> = {
  prepare: '输入与生产预检',
  breakdown: '剧本拆解',
  assets: '资产匹配与补齐',
  storyboard: '分镜设计',
  director: '3D 导演预演',
  video: '镜头视频生成',
  candidates: '候选抽卡与选优',
  review: '镜头技术复核',
  compose: '成片时间线合成',
  deliver: '成片技术校验与交付',
};

function maxAttempts(input: CreateProductionRun): number {
  return input.qualityPreset === 'fast' ? 1 : input.qualityPreset === 'balanced' ? 2 : 3;
}

function initialEvent(runId: string, at: string): OutboxEvent {
  return { id: productionId('pevent'), runId, sequence: 1, type: 'production.run.created',
    payload: { workflowVersion: PRODUCTION_WORKFLOW_VERSION }, createdAt: at };
}

export function compileProductionRun(input: CreateProductionRun, now: string, id = productionId('production')): StoredProductionRun {
  const requestDigest = canonicalDigest(input);
  const taskIds = Object.fromEntries(productionStageOrder.map(stage => [stage, productionId('ptask')])) as Record<ProductionStage, string>;
  const tasks: ProductionTask[] = productionStageOrder.map((stage, index) => {
    const skippedDirector = stage === 'director' && input.directorPolicy === 'never';
    return {
      id: taskIds[stage], runId: id, stage, label: productionStageLabels[stage], scope: { kind: 'episode', id: null },
      status: skippedDirector ? 'skipped' : index === 0 ? 'ready' : 'pending',
      dependencies: index === 0 ? [] : stage === 'video' && input.directorPolicy === 'never'
        ? [taskIds.storyboard, taskIds.director]
        : [taskIds[productionStageOrder[index - 1]!]],
      attemptCount: 0, maxAttempts: stage === 'prepare' ? 1 : maxAttempts(input), version: 0,
      blockingReason: skippedDirector ? { code: 'DIRECTOR_POLICY_DISABLED', message: '本次运行已选择不使用 3D 预演。' } : null,
      inputManifest: [
        { kind: 'script', id: input.scriptVersionId, revisionId: input.scriptVersionId, digest: requestDigest },
        { kind: 'productionPolicy', id, revisionId: PRODUCTION_WORKFLOW_VERSION, digest: requestDigest },
      ],
      createdAt: now, updatedAt: now,
    };
  });
  // Skipping the optional director task must not make the following task ready
  // until the storyboard dependency has genuinely completed. Readiness is
  // promoted by the scheduler after every durable transition.
  return {
    ...structuredClone(input), id, workflowVersion: PRODUCTION_WORKFLOW_VERSION,
    status: 'queued', version: 0, pausedAt: null, createdAt: now, updatedAt: now,
    tasks, attempts: [], externalOperations: [], artifacts: [], candidateSets: [], issues: [],
    qualityChecks: [], reviews: [], timeline: [], delivery: null, budgetLedger: [], outbox: [initialEvent(id, now)],
  };
}
