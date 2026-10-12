import 'reflect-metadata';
import { Body, Catch, Controller, Get, HttpCode, HttpException, Inject, Injectable, Module, Param, Post,
  type ArgumentsHost, type ExceptionFilter, type PipeTransform } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AppConfig } from './config';
import { ModelClient } from './models/client';
import { MAX_REQUEST_BYTES, ModelError, parseCall } from './models/contracts';
import { MODELS } from './models/registry';
import {
  parseAdoptPlan,
  parseCreateBreakdownRun,
  parseCreateProject,
  parseCreateScriptVersion,
  parseOpaqueId,
} from './breakdown/contracts';
import { BreakdownError } from './breakdown/errors';
import { parseCreateExtractFactsCandidate } from './breakdown/plan';
import type { StoredScriptVersion } from './breakdown/repository';
import type { ExtractFactsStageRunner } from './breakdown/execution';
import type { StoryboardService } from './breakdown/storyboard';
import { type BreakdownServicePort, UnavailableBreakdownService } from './breakdown/service';

const CONFIG = Symbol('APP_CONFIG');
const TRANSPORT = Symbol('MODEL_TRANSPORT');
const BREAKDOWN_SERVICE = Symbol('BREAKDOWN_SERVICE');
const STAGE_RUNNER = Symbol('STAGE_RUNNER');
const STORYBOARD_SERVICE = Symbol('STORYBOARD_SERVICE');

export interface AppDependencies {
  /** Omit this in model-only tests or before PostgreSQL has been migrated. */
  breakdownService?: BreakdownServicePort;
  stageRunner?: ExtractFactsStageRunner;
  storyboardService?: StoryboardService;
  /** Lets main close the pg Pool when Nest/Fastify shuts down. */
  close?: () => Promise<void>;
}

@Injectable()
class ModelCallPipe implements PipeTransform {
  transform(value: unknown) { return parseCall(value); }
}

@Injectable()
class CreateProjectPipe implements PipeTransform {
  transform(value: unknown) { return parseCreateProject(value); }
}

@Injectable()
class CreateScriptVersionPipe implements PipeTransform {
  transform(value: unknown) { return parseCreateScriptVersion(value); }
}

@Injectable()
class CreateBreakdownRunPipe implements PipeTransform {
  transform(value: unknown) { return parseCreateBreakdownRun(value); }
}

@Injectable()
class CreateExtractFactsCandidatePipe implements PipeTransform {
  transform(value: unknown) { return parseCreateExtractFactsCandidate(value); }
}

@Injectable()
class AdoptPlanPipe implements PipeTransform {
  transform(value: unknown) { return parseAdoptPlan(value); }
}

@Injectable()
class ModelsService {
  private readonly client: ModelClient;
  constructor(@Inject(CONFIG) private readonly config: AppConfig, @Inject(TRANSPORT) transport: typeof fetch) {
    this.client = new ModelClient(config, transport);
  }
  list() {
    return { defaultModel: this.config.defaultModel, streaming: false, automaticFallback: false,
      capabilitySource: 'local-proxy-config-snapshot-2026-09-30',
      verificationNote: '配置不代表实时可用性；本次实测记录见 docs/模型接入验证.md。窗口不是实测硬上限。',
      models: MODELS.map(model => ({ ...model, textInput: true, imageGeneration: false, videoGeneration: false,
        effectiveDefaultReasoningEffort: model.id === this.config.defaultModel && this.config.reasoningEffort !== 'model-default'
          ? this.config.reasoningEffort : model.defaultReasoningEffort })) };
  }
  call(input: unknown) { return this.client.call(input); }
}

@Controller()
class ModelsController {
  constructor(private readonly models: ModelsService) {}
  @Get('healthz') health() { return { status: 'ok', scope: 'local-backend-only', modelAvailabilityChecked: false }; }
  @Get('api/models') list() { return this.models.list(); }
  @Post('api/model-calls') @HttpCode(200)
  call(@Body(new ModelCallPipe()) input: unknown) { return this.models.call(input); }
}

@Controller('api')
class ProjectsController {
  constructor(@Inject(BREAKDOWN_SERVICE) private readonly breakdown: BreakdownServicePort) {}

  @Get('projects')
  async listProjects() { return { items: await this.breakdown.listProjects() }; }

  @Get('projects/:projectId')
  getProject(@Param('projectId') projectId: string) {
    return this.breakdown.getProject(parseOpaqueId(projectId, 'projectId'));
  }

  @Post('projects')
  createProject(@Body(new CreateProjectPipe()) input: unknown) {
    return this.breakdown.createProject(input as ReturnType<typeof parseCreateProject>);
  }

  @Post('projects/:projectId/script-versions')
  async createScriptVersion(
    @Param('projectId') projectId: string,
    @Body(new CreateScriptVersionPipe()) input: unknown,
  ) {
    const script = await this.breakdown.createScriptVersion(
      parseOpaqueId(projectId, 'projectId'),
      input as ReturnType<typeof parseCreateScriptVersion>,
    );
    return scriptVersionResponse(script);
  }

  @Get('projects/:projectId/script-versions')
  async listScriptVersions(@Param('projectId') projectId: string) {
    const items = await this.breakdown.listScriptVersions(parseOpaqueId(projectId, 'projectId'));
    return { items };
  }

  @Get('projects/:projectId/script-versions/:scriptVersionId')
  getScriptVersion(@Param('projectId') projectId: string, @Param('scriptVersionId') scriptVersionId: string) {
    return this.breakdown.getScriptVersion(
      parseOpaqueId(projectId, 'projectId'), parseOpaqueId(scriptVersionId, 'scriptVersionId'));
  }

  @Post('projects/:projectId/adoptions')
  adoptPlan(@Param('projectId') projectId: string, @Body(new AdoptPlanPipe()) input: unknown) {
    return this.breakdown.adoptPlan(parseOpaqueId(projectId, 'projectId'),
      input as ReturnType<typeof parseAdoptPlan>);
  }

  @Post('projects/:projectId/breakdown-runs')
  createDraftRun(
    @Param('projectId') projectId: string,
    @Body(new CreateBreakdownRunPipe()) input: unknown,
  ) {
    return this.breakdown.createDraftRun(
      parseOpaqueId(projectId, 'projectId'),
      input as ReturnType<typeof parseCreateBreakdownRun>,
    );
  }

  @Get('projects/:projectId/breakdown-runs')
  async listRuns(@Param('projectId') projectId: string) {
    return { items: await this.breakdown.listRuns(parseOpaqueId(projectId, 'projectId')) };
  }
}

@Controller('api/breakdown-runs')
class BreakdownRunsController {
  constructor(@Inject(BREAKDOWN_SERVICE) private readonly breakdown: BreakdownServicePort,
    @Inject(STAGE_RUNNER) private readonly runner: ExtractFactsStageRunner | null) {}

  @Get(':runId')
  getRun(@Param('runId') runId: string) {
    return this.breakdown.getRun(parseOpaqueId(runId, 'runId'));
  }

  @Post(':runId/execute')
  async execute(@Param('runId') runId: string, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || (body as Record<string, unknown>).allowPaid !== true) {
      throw new BreakdownError(400, 'PAID_CALL_NOT_AUTHORIZED', '执行前须明确传入 allowPaid: true。');
    }
    if (!this.runner) throw new BreakdownError(503, 'STAGE_RUNNER_UNAVAILABLE', '本地数据库或模型执行器尚未就绪。');
    return this.runner.run(parseOpaqueId(runId, 'runId'));
  }

  @Post(':runId/candidate-plan-revisions')
  createCandidate(
    @Param('runId') runId: string,
    @Body(new CreateExtractFactsCandidatePipe()) input: unknown,
  ) {
    return this.breakdown.createExtractFactsCandidate(
      parseOpaqueId(runId, 'runId'),
      input as ReturnType<typeof parseCreateExtractFactsCandidate>,
    );
  }

  @Get(':runId/candidate-plan-revisions')
  async listCandidates(@Param('runId') runId: string) {
    const items = await this.breakdown.listPlanRevisions(parseOpaqueId(runId, 'runId'));
    return { items };
  }
}

@Controller('api/plan-revisions')
class PlanRevisionsController {
  constructor(@Inject(BREAKDOWN_SERVICE) private readonly breakdown: BreakdownServicePort) {}

  @Get(':planRevisionId')
  getPlanRevision(@Param('planRevisionId') planRevisionId: string) {
    return this.breakdown.getPlanRevision(parseOpaqueId(planRevisionId, 'planRevisionId'));
  }

  @Post(':planRevisionId/checks')
  checkPlan(@Param('planRevisionId') planRevisionId: string) {
    return this.breakdown.checkPlan(parseOpaqueId(planRevisionId, 'planRevisionId'));
  }

  @Get(':planRevisionId/checks')
  async listPlanChecks(@Param('planRevisionId') planRevisionId: string) {
    return { items: await this.breakdown.listPlanChecks(parseOpaqueId(planRevisionId, 'planRevisionId')) };
  }

  @Get(':planRevisionId/checks/:checkId/issues')
  async listPlanIssues(@Param('planRevisionId') planRevisionId: string, @Param('checkId') checkId: string) {
    const planId = parseOpaqueId(planRevisionId, 'planRevisionId');
    const check = (await this.breakdown.listPlanChecks(planId)).find(item => item.id === parseOpaqueId(checkId, 'checkId'));
    if (!check) throw new BreakdownError(404, 'PLAN_CHECK_NOT_FOUND', '校验记录不存在。');
    return { items: await this.breakdown.listPlanIssues(check.id) };
  }
}

@Controller('api')
class StoryboardController {
  constructor(@Inject(STORYBOARD_SERVICE) private readonly storyboards: StoryboardService | null) {}
  private service() {
    if (!this.storyboards) throw new BreakdownError(503, 'STORYBOARD_UNAVAILABLE', '分镜服务尚未就绪。');
    return this.storyboards;
  }
  @Post('projects/:projectId/storyboards')
  generate(@Param('projectId') projectId: string, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || (body as Record<string, unknown>).allowPaid !== true) {
      throw new BreakdownError(400, 'PAID_CALL_NOT_AUTHORIZED', '生成分镜前须明确传入 allowPaid: true。');
    }
    return this.service().generate(parseOpaqueId(projectId, 'projectId'));
  }
  @Get('projects/:projectId/storyboards')
  async list(@Param('projectId') projectId: string) {
    return { items: await this.service().list(parseOpaqueId(projectId, 'projectId')) };
  }
  @Get('storyboards/:revisionId')
  get(@Param('revisionId') revisionId: string) {
    return this.service().get(parseOpaqueId(revisionId, 'revisionId'));
  }
  @Post('projects/:projectId/storyboards/:revisionId/adoptions')
  adopt(@Param('projectId') projectId: string, @Param('revisionId') revisionId: string, @Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || !('expectedActiveStoryboardRevisionId' in body)) {
      throw new BreakdownError(400, 'INVALID_STORYBOARD_ADOPTION', '分镜采用请求不完整。');
    }
    const expected = (body as Record<string, unknown>).expectedActiveStoryboardRevisionId;
    if (expected !== null && (typeof expected !== 'string' || !/^[a-z][a-z0-9_-]{2,127}$/.test(expected))) {
      throw new BreakdownError(400, 'INVALID_STORYBOARD_ADOPTION', '已采用分镜版本 ID 不合法。');
    }
    return this.service().adopt(parseOpaqueId(projectId, 'projectId'), parseOpaqueId(revisionId, 'revisionId'), expected);
  }
}

function scriptVersionResponse(script: StoredScriptVersion) {
  // SourceIndex is persisted and verified internally.  This creation response
  // returns only counts so a large script is not immediately echoed back.
  return {
    id: script.id,
    projectId: script.projectId,
    version: script.version,
    contentSha256: script.contentSha256,
    createdAt: script.createdAt,
    sourceIndex: {
      schemaVersion: script.sourceIndex.schemaVersion,
      unitCount: script.sourceIndex.units.length,
      spanCount: script.sourceIndex.spans.length,
      blockCount: script.sourceIndex.blocks.length,
    },
  };
}

@Catch()
class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse();
    if (error instanceof ModelError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message, ...error.details } });
    }
    if (error instanceof BreakdownError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    const status = error instanceof HttpException ? error.getStatus() :
      error && typeof error === 'object' && 'statusCode' in error && [400, 413, 415].includes(Number(error.statusCode)) ? Number(error.statusCode) : 500;
    // Never reflect raw provider bodies, headers, prompts or stack traces.
    return reply.status(status).send({ error: { code: status < 500 ? 'HTTP_REQUEST_ERROR' : 'INTERNAL_ERROR',
      message: status < 500 ? '请求格式、大小或路径不受支持。' : '本机服务内部错误。' } });
  }
}

export async function createApp(config: AppConfig, transport: typeof fetch = fetch, dependencies: AppDependencies = {}) {
  const breakdownService = dependencies.breakdownService ?? new UnavailableBreakdownService();
  @Module({ controllers: [ModelsController, ProjectsController, BreakdownRunsController, PlanRevisionsController, StoryboardController], providers: [ModelsService,
    { provide: CONFIG, useValue: config }, { provide: TRANSPORT, useValue: transport },
    { provide: BREAKDOWN_SERVICE, useValue: breakdownService },
    { provide: STAGE_RUNNER, useValue: dependencies.stageRunner ?? null },
    { provide: STORYBOARD_SERVICE, useValue: dependencies.storyboardService ?? null }] })
  class ModelsModule {}
  const adapter = new FastifyAdapter({ bodyLimit: MAX_REQUEST_BYTES, logger: false });
  adapter.getInstance().addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    const allowedBrowser = origin === 'http://127.0.0.1:5173' || origin === 'http://localhost:5173';
    if (allowedBrowser) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, X-Shortdrama-Call');
    }
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host ?? '') || (origin && !allowedBrowser) ||
        (request.method === 'POST' && request.headers['x-shortdrama-call'] !== '1')) {
      return reply.code(403).send({ error: { code: 'LOCAL_CLIENT_ONLY', message: '仅允许本机客户端访问；POST 需 X-Shortdrama-Call: 1。' } });
    }
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });
  if (dependencies.close) {
    adapter.getInstance().addHook('onClose', async () => { await dependencies.close?.(); });
  }
  const app = await NestFactory.create<NestFastifyApplication>(ModelsModule, adapter, { logger: false });
  app.useGlobalFilters(new SafeErrors());
  await app.init();
  await adapter.getInstance().ready();
  return app;
}
