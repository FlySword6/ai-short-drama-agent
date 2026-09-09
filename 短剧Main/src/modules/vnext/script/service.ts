import { createHash } from "node:crypto";
import type { Database } from "../../../db/client.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import { createAiGatewayService } from "../../ai/service.js";
import type { ProjectAccessActor } from "../../project-access/types.js";
import { VnextProjectRepository } from "../repository.js";
import { VnextProjectService } from "../service.js";
import { mergeShotPlanDiagnostics, validateShotPlanDraft } from "../shot-plan/schema.js";
import type { FormalShotPlanFacts, ShotPlanDraft } from "../shot-plan/types.js";
import { AiGatewayScriptDraftProvider } from "./provider.js";
import { VnextScriptRepository } from "./repository.js";
import {
  ScriptProviderPartialError,
  ScriptProviderTimeoutError,
  ScriptProviderUnavailableError,
  type ScriptDraftProvider,
  type ScriptParseError,
  type ScriptParseRun,
  type ScriptSourceKind,
  type ScriptWorkbenchState,
} from "./types.js";

const MAX_SCRIPT_LENGTH = 200_000;

export class VnextScriptService {
  private readonly repository: VnextScriptRepository;
  private readonly projects: VnextProjectService;
  private readonly projectRepository: VnextProjectRepository;
  private readonly provider: ScriptDraftProvider;

  constructor(
    db: Database,
    provider?: ScriptDraftProvider,
    mainDatabase: Database = db,
  ) {
    this.repository = new VnextScriptRepository(db);
    this.projects = new VnextProjectService(db);
    this.projectRepository = new VnextProjectRepository(db);
    this.provider = provider ?? new AiGatewayScriptDraftProvider(
      () => createAiGatewayService(mainDatabase),
    );
  }

  async createRun(actor: ProjectAccessActor, input: {
    projectId: string;
    sourceKind: ScriptSourceKind;
    fileName?: string;
    scriptContent: string;
    clientIdempotencyKey: string;
  }): Promise<{ run: ScriptParseRun; created: boolean }> {
    await this.requireWrite(actor, input.projectId);
    const content = normalizeScript(input.scriptContent);
    if (!content) throw new BadRequestError("剧本内容不能为空，请粘贴或上传固定测试剧本");
    if (content.length > MAX_SCRIPT_LENGTH) throw new BadRequestError("剧本超过 20 万字，请缩短后重试");
    if (input.sourceKind === "upload" && !input.fileName?.trim()) {
      throw new BadRequestError("上传剧本必须保留文件名");
    }
    return this.repository.createRun({
      projectId: input.projectId,
      actorId: actor.id,
      sourceKind: input.sourceKind,
      fileName: input.sourceKind === "upload" ? input.fileName!.trim().slice(0, 255) : null,
      scriptContent: content,
      contentSha256: createHash("sha256").update(content).digest("hex"),
      clientIdempotencyKey: input.clientIdempotencyKey,
    });
  }

  async workbench(actor: ProjectAccessActor, projectId: string): Promise<ScriptWorkbenchState> {
    await this.projects.getProject(actor, projectId);
    const [run, formalFacts] = await Promise.all([
      this.repository.latestRun(projectId),
      this.repository.latestFormalFacts(projectId),
    ]);
    return { run, formalFacts };
  }

  async executeRun(runId: string): Promise<void> {
    if (!await this.repository.beginRun(runId)) return;
    const source = await this.repository.sourceForAnalysis(runId);
    if (!source) {
      await this.repository.failRun({
        runId,
        status: "failed",
        error: schemaError(),
      });
      return;
    }
    try {
      await pause(90);
      await this.repository.updateProgress(runId, 35, "structuring");
      const result = await this.provider.analyze({
        scriptContent: source.scriptContent,
        actorId: source.actorId,
        runId,
      });
      await pause(90);
      await this.repository.updateProgress(runId, 75, "validating");
      await pause(90);
      const draft = validateShotPlanDraft(result.draft);
      if (result.partialFailure) {
        const partialDraft = withPartialDiagnostics(draft, [result.partialFailure]);
        await this.repository.failRun({
          runId,
          status: "partial_failure",
          draft: partialDraft,
          error: partialError(),
        });
        return;
      }
      await this.repository.completeRun(runId, draft);
    } catch (error) {
      await this.persistProviderFailure(runId, error);
    }
  }

  async recoverInterrupted(runId: string): Promise<void> {
    await this.repository.recoverInterrupted(runId);
  }

  async retry(actor: ProjectAccessActor, runId: string): Promise<{
    run: ScriptParseRun;
    outcome: "created" | "replayed";
  }> {
    const existing = await this.requireRunWrite(actor, runId);
    if (existing.status === "queued" || existing.status === "running") {
      return { run: existing, outcome: "replayed" };
    }
    if (!existing.error?.retryable) {
      throw new ConflictError("当前失败不能直接重试，请修正剧本后重新导入", "script_retry_not_allowed");
    }
    const reset = await this.repository.resetForRetry(runId);
    if (!reset) throw new ConflictError("解析状态已经变化，请刷新后重试", "script_state_conflict");
    return {
      run: reset.run,
      outcome: reset.transitioned ? "created" : "replayed",
    };
  }

  async confirm(actor: ProjectAccessActor, runId: string, clientIdempotencyKey: string): Promise<FormalShotPlanFacts> {
    const run = await this.requireRunWrite(actor, runId);
    if (run.status !== "draft" && run.status !== "confirmed") {
      throw new ConflictError("草稿尚未完整可用，不能确认正式分镜", "script_draft_not_confirmable");
    }
    const facts = await this.repository.confirm({ runId, actorId: actor.id, clientIdempotencyKey });
    if (!facts) throw new ConflictError("草稿状态已经变化，请刷新后重试", "script_state_conflict");
    return facts;
  }

  private async requireRunWrite(actor: ProjectAccessActor, runId: string): Promise<ScriptParseRun> {
    const run = await this.repository.findRun(runId);
    if (!run) throw new NotFoundError("剧本解析任务不存在");
    await this.requireWrite(actor, run.projectId);
    return run;
  }

  private async requireWrite(actor: ProjectAccessActor, projectId: string): Promise<void> {
    await this.projects.getProject(actor, projectId);
    const role = await this.projectRepository.findMemberRole(projectId, actor.id);
    if (role === "viewer") throw new ForbiddenError("你没有在这个 vNext 项目中导入或确认剧本的权限");
  }

  private async persistProviderFailure(runId: string, error: unknown): Promise<void> {
    if (error instanceof ScriptProviderPartialError) {
      let draft: ShotPlanDraft | undefined;
      try {
        draft = validateShotPlanDraft(error.draft);
      } catch {
        await this.repository.failRun({ runId, status: "failed", error: schemaError() });
        return;
      }
      const partialDraft = withPartialDiagnostics(draft, error.details);
      await this.repository.failRun({
        runId,
        status: "partial_failure",
        draft: partialDraft,
        error: partialError(),
      });
      return;
    }
    await this.repository.failRun({
      runId,
      status: "failed",
      error: error instanceof ScriptProviderUnavailableError
        ? unavailableError()
        : error instanceof ScriptProviderTimeoutError
          ? timeoutError()
          : schemaError(),
    });
  }
}

function normalizeScript(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function partialError(): ScriptParseError {
  return {
    code: "script_partial_failure",
    message: "部分镜头没能整理完整。请查看草稿中的诊断后重试解析。",
    retryable: true,
  };
}

function withPartialDiagnostics(draft: ShotPlanDraft, details: string[]): ShotPlanDraft {
  if (details.length === 0) return draft;
  return validateShotPlanDraft({
    ...draft,
    warnings: mergeShotPlanDiagnostics(draft.warnings, details),
  });
}

function unavailableError(): ScriptParseError {
  return {
    code: "script_model_unavailable",
    message: "剧本解析服务当前不可用。请稍后重试，原剧本已安全保留。",
    retryable: true,
  };
}

function timeoutError(): ScriptParseError {
  return {
    code: "script_parse_timeout",
    message: "剧本解析超时。请重试，原剧本和当前进度已保留。",
    retryable: true,
  };
}

function schemaError(): ScriptParseError {
  return {
    code: "script_schema_validation_failed",
    message: "解析结果结构不完整。请重新解析；若持续失败，请联系管理员检查解析规则。",
    retryable: true,
  };
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
