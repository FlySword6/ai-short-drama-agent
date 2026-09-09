import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { COMPANY_PROVIDER_ACCOUNT_IDS } from "../shared/companyProviderPolicy.js";
import { ASSET_VECTOR_COLLECTION_NAME } from "./vectorProjection.js";

loadCompatibleDotEnv();

const optionalString = z.string().trim().optional();
const optionalUrl = z.union([z.string().url(), z.literal("")])
  .transform((value) => value || undefined)
  .optional();
const optionalHttpsUrl = z.string().trim().transform((value, context) => {
  if (!value) return undefined;
  try {
    if (new URL(value).protocol !== "https:") throw new Error("not_https");
  } catch {
    context.addIssue({ code: "custom", message: "必须填写 HTTPS 地址" });
    return z.NEVER;
  }
  return value;
}).optional();
const optionalSha256 = z.union([z.string().trim().regex(/^[0-9a-f]{64}$/), z.literal("")])
  .transform((value) => value || undefined)
  .optional();
const companyProviderAllowlistSchema = z.string().default("ark").superRefine((value, context) => {
  const allowed = new Set<string>(COMPANY_PROVIDER_ACCOUNT_IDS);
  for (const item of value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean)) {
    if (!allowed.has(item)) {
      context.addIssue({
        code: "custom",
        message: `unsupported company provider account: ${item}`,
      });
    }
  }
});

// 版本单一来源=仓根 package.json;env 显式设置仍可覆盖(发布流注入用)
function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 未注入构建参数时的取值。查不到就说查不到,不猜、不拿仓库里的值冒充。 */
export const UNKNOWN_COMMIT_SHA = "unknown";

/**
 * commit sha 与 APP_VERSION 的来源结构不同:版本号能从仓根 package.json 推导,
 * sha 推导不出来——写进仓库的任何值在下一个提交后就是谎报。唯一诚实的来源是构建
 * 时注入(Dockerfile `ARG GIT_SHA` → `ENV APP_COMMIT_SHA`),缺失时降级成 unknown。
 *
 * hex 白名单是安全边界不是洁癖:本值经未鉴权的 /api/v1/health 对外可见,收窄格式
 * 后,构建参数误传成分支名、镜像 tag 或主机名时会在启动期崩掉,而不是悄悄外泄。
 * 导出供 test/health-ready.test.ts 独立回归。
 */
export const commitShaSchema = z.string().trim().default("")
  .transform((value) => value || UNKNOWN_COMMIT_SHA)
  .refine(
    (value) => value === UNKNOWN_COMMIT_SHA || /^[0-9a-f]{7,40}$/.test(value),
    "APP_COMMIT_SHA 必须是 7-40 位小写 hex 的 git commit sha",
  );

const trueBooleanEnvValues = new Set(["1", "true", "yes", "y", "on"]);
const falseBooleanEnvValues = new Set(["0", "false", "no", "n", "off"]);

/**
 * Authorization switches must never turn off because of a typo. Keep this
 * exported so startup-failure behavior can be tested without spawning a
 * second application process.
 */
export const strictBooleanEnvSchema = z.string().trim().toLowerCase()
  .refine(
    (value) => trueBooleanEnvValues.has(value) || falseBooleanEnvValues.has(value),
    "必须是 true/false、1/0、yes/no、y/n 或 on/off",
  )
  .transform((value) => trueBooleanEnvValues.has(value));

const envSchema = z.object({
  APP_NAME: z.string().default("Shortdrama Agent"),
  APP_VERSION: z.string().default(readPackageVersion()),
  APP_COMMIT_SHA: commitShaSchema,
  DEBUG: z.string().default("false"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  HOST: z.string().default("0.0.0.0"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
  AUTH_PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).default(8),
  // S57 opens email self-registration. The legacy switch/list are retained
  // only so old manifests parse; they are no longer an authorization source.
  AUTH_REGISTRATION_ENABLED: z.string().default("true"),
  AUTH_REGISTRATION_INVITE_CODES: optionalString,
  AUTH_EMAIL_DELIVERY_MODE: z.enum(["dev_log", "disabled"]).default("dev_log"),
  AUTH_EMAIL_VERIFICATION_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
  AUTH_EMAIL_VERIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  WECOM_LOGIN_ENABLED: strictBooleanEnvSchema.default(false),
  WECOM_CORP_ID: optionalString,
  WECOM_AGENT_ID: optionalString,
  WECOM_CORP_SECRET: optionalString,
  WECOM_CALLBACK_URL: optionalHttpsUrl,
  WECOM_STATE_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(300),
  // 同一个账号能不能同时在多处登录。留空时按 NODE_ENV 推导（生产只留一处，
  // 开发与测试允许多处），运维不配这个键也是安全的。显式配置优先，用于测试
  // 环境临时验证「后登的把先登的挤下线」，或生产临时关掉排障。
  AUTH_SINGLE_ACTIVE_SESSION: strictBooleanEnvSchema.optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  ADMIN_USERNAMES: optionalString,
  // Local dev bootstrap credential pair. The application never reads these —
  // scripts/dev-up.mts parses .env directly — but they are declared here so
  // .env.example stays field-aligned with this schema (test/dev-environment).
  DEV_ADMIN_USERNAME: optionalString,
  DEV_ADMIN_PASSWORD: optionalString,
  // Platform-level project creation policy. The database role remains the
  // runtime authority; this deployment setting only decides whether an
  // ordinary member may create a new project at all.
  ALLOW_MEMBER_CREATE_PROJECT: z.string().default("false"),
  TRASH_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
  GENERATION_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(5_000),
  // Natural-language generation is mock-first. Production must opt into real
  // orchestration explicitly; an omitted value there stays disabled.
  GENERATION_ORCHESTRATION_MODE: z.enum(["mock", "real", "disabled"]).optional(),
  // A paid provider call can legitimately take longer than a short poll
  // interval. Keep the production default long enough for the worker's
  // database-backed heartbeat to survive an ordinary slow submission.
  GENERATION_TASK_LEASE_SECONDS: z.coerce.number().int().min(180).max(600).default(180),
  // Internal pilot access is independent from provider/payment readiness.
  // Keep it fail-closed by default so every persisted quote or new task also
  // requires a provisioned account with positive balance and daily allowance.
  GENERATION_PILOT_CREDIT_GATE_ENABLED: strictBooleanEnvSchema.default(true),
  ALLOW_PAID_GENERATION: z.string().default("false"),
  PAID_GENERATION_BUDGET_FEN: z.coerce.number().int().min(0).default(0),
  PAID_GENERATION_REVIEW_THRESHOLD_FEN: z.coerce.number().int().min(0).default(40_000),
  // R195-5: credentials and model IDs never authorize a company billing
  // account by themselves. Add `newapi` here only after the company gateway
  // account and prices are approved.
  COMPANY_PROVIDER_ALLOWLIST: companyProviderAllowlistSchema,
  DATABASE_URL: optionalString,
  VNEXT_DATABASE_URL: optionalString,
  POSTGRES_HOST: optionalString,
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: optionalString,
  POSTGRES_USER: optionalString,
  POSTGRES_PASSWORD: optionalString,
  // 兜底必须是我们自己的 schema。此前默认为 `common`——那是团队旧系统的活数据
  // schema,且其属主正是本应用使用的数据库账号,漏配一个环境变量就会让本应用以
  // 属主身份连上别人的生产数据。兜底指向自己的 schema,最坏情况只是空库。
  POSTGRES_SCHEMA: z.string().default("app"),
  POSTGRES_SSL_MODE: z.enum(["disable", "verify-full"]).default("disable"),
  POSTGRES_SSL_ROOT_CERT: optionalString,
  ARK_BASE_URL: z.string().url().default("https://ark.cn-beijing.volces.com/api/v3"),
  ARK_API_KEY: optionalString,
  ARK_IMAGE_MODEL: optionalString,
  ARK_VIDEO_MODEL: optionalString,
  // Seedance 2.5 走专用接入点（折扣绑定在 ep 上），本键填该接入点 ep id；
  // 留空 = 2.5 能力保持 fail-closed，不影响 ARK_VIDEO_MODEL 的 2.0 绑定。
  ARK_VIDEO_MODEL_2_5: optionalString,
  // Audio is deliberately separate: an image/video identifier must never be
  // reused as a silent TTS fallback. Audio callers fail closed when absent.
  // openspeech TTS 凭据是语音控制台的 appid + access token,不复用 ARK_API_KEY;
  // 鉴权头格式是 `Bearer;${token}`(分号),与 Ark 图片/视频的空格形式不同。
  OPENSPEECH_TTS_MODEL: optionalString,
  OPENSPEECH_TTS_ENDPOINT: optionalHttpsUrl,
  OPENSPEECH_TTS_TOKEN: optionalString,
  OPENSPEECH_TTS_APPID: optionalString,
  OPENSPEECH_TTS_CLUSTER: optionalString,
  // 豆包音频生成 v3 使用新版语音控制台单头 API Key，与旧 TTS/Ark 凭据均不同。
  SEED_AUDIO_ENDPOINT: optionalHttpsUrl,
  SEED_AUDIO_API_KEY: optionalString,
  SEED_AUDIO_MODEL: optionalString,
  // 阿里云百炼 HappyHorse 参考生视频:Workspace 级 endpoint 与 API Key 必须同地域,
  // 真实 model ID 由部署显式配置,代码不猜(modelProviderRegistry 口径)。
  HAPPYHORSE_API_KEY: optionalString,
  HAPPYHORSE_BASE_URL: optionalHttpsUrl,
  HAPPYHORSE_MODEL: optionalString,
  // MiniMax current multimodal API. The legacy api.minimax.io host is not a
  // compatible substitute for the current Bearer API and is rejected by the
  // provider adapters before any paid request.
  MINIMAX_API_HOST: z.string().url().default("https://api.minimaxi.com"),
  MINIMAX_API_KEY: optionalString,
  // Kept for compatibility with the account export. Current v1/v2 APIs do not
  // require group_id in the request URL or payload.
  MINIMAX_GROUP_ID: optionalString,
  MINIMAX_LLM_MODELS: optionalString,
  MINIMAX_IMAGE_MODELS: optionalString,
  MINIMAX_VIDEO_MODELS: optionalString,
  MINIMAX_AUDIO_MODELS: optionalString,
  MINIMAX_AUDIO_VOICE_ID: z.string().trim().min(1).max(128).default("male-qn-qingse"),
  // Company newapi aggregation gateway. Experimental tiers remain inactive;
  // this separate switch prevents a staged key/model list from becoming
  // routable before the company base URL and account pricing are verified.
  NEWAPI_GENERATION_ENABLED: z.string().default("false"),
  NEWAPI_BASE_URL: optionalHttpsUrl,
  NEWAPI_APPROVED_BASE_URL_SHA256: optionalSha256,
  NEWAPI_API_KEY: optionalString,
  NEWAPI_GPT_IMAGE_MODELS: optionalString,
  NEWAPI_GEMINI_IMAGE_MODELS: optionalString,
  // Temporary company-funded async image gateway. The adapter is address-
  // agnostic so the deployment can replace this origin with the company
  // gateway without changing business code.
  SUCHUANG_GENERATION_ENABLED: z.string().default("false"),
  SUCHUANG_BASE_URL: optionalHttpsUrl,
  SUCHUANG_API_KEY: optionalString,
  // Non-secret identity hash for the one approved dev pricing-seed target.
  // Promotion scripts must not trust a same-command `--target dev` assertion.
  PRICING_SEED_DEV_DATABASE_IDENTITY_SHA256: optionalSha256,
  // Stronger identity for the one-off tier-unfreeze writer. Unlike the
  // legacy pricing-seed fingerprint, this also binds the target schema.
  TIER_UNFREEZE_DEV_TARGET_IDENTITY_SHA256: optionalSha256,
  // Independently provisioned service origin whose health/ready proof must
  // show the guard commit before the database activation can run.
  TIER_UNFREEZE_DEV_DEPLOYMENT_BASE_URL: optionalHttpsUrl,
  // Test has its own approved database+schema fingerprint and service origin.
  // Production cannot reuse either value because the target identity differs.
  TIER_UNFREEZE_TEST_ENV_TARGET_IDENTITY_SHA256: optionalSha256,
  TIER_UNFREEZE_TEST_ENV_DEPLOYMENT_BASE_URL: optionalHttpsUrl,
  // Company Ark credential approved for the single test-env paid smoke.
  TIER_UNFREEZE_TEST_ENV_ARK_CREDENTIAL_SHA256: optionalSha256,
  // Local-only FABLE-007 provider smoke allowlist. These non-secret hashes
  // must be approved independently from the credential values themselves.
  FABLE007_DEV_ARK_CREDENTIAL_SHA256: optionalSha256,
  FABLE007_DEV_MINIMAX_CREDENTIAL_SHA256: optionalSha256,
  FABLE007_DEV_SEED_AUDIO_CREDENTIAL_SHA256: optionalSha256,
  ARK_LLM_MODEL: optionalString,
  ARK_LLM_MODELS: optionalString,
  // Company-owned OpenAI-compatible text gateway. The base URL and API key
  // are injected together at runtime; exact model IDs and per-capability
  // bindings remain non-secret deployment configuration.
  COL_BASE_URL: optionalHttpsUrl,
  COL_APIKEY: optionalString,
  COL_TEXT_MODELS: optionalString,
  COL_SCRIPT_BREAKDOWN_MODEL: optionalString,
  COL_PROMPT_DRAFT_MODEL: optionalString,
  COL_PROMPT_TRANSLATE_MODEL: optionalString,
  // Asset-library registration uses the Ark OpenAPI AK/SK contract. It is
  // separate from ARK_API_KEY and defaults closed so a deployment cannot
  // accidentally register a creator asset.
  SEEDANCE_ASSET_REGISTRATION_ENABLED: z.string().default("false"),
  SEEDANCE_ASSET_GROUP_ID: optionalString,
  SEEDANCE_ASSET_GROUP_NAME: z.string().trim().min(1).max(64).default("中文在线短剧素材"),
  SEEDANCE_ASSET_GROUP_DESCRIPTION: z.string().trim().min(1).max(300)
    .default("中文在线 AI 短剧平台登记的图片参考素材"),
  SEEDANCE_ASSET_PROJECT_NAME: z.string().trim().min(1).max(128).default("default"),
  SEEDANCE_ASSET_REGISTRATION_ENDPOINT: z.string().url()
    .default("https://ark.cn-beijing.volcengineapi.com"),
  SEEDANCE_ASSET_REGISTRATION_REGION: z.string().trim().min(1).max(64).default("cn-beijing"),
  VOLCENGINE_ACCESS_KEY_ID: optionalString,
  VOLCENGINE_SECRET_ACCESS_KEY: optionalString,
  VOLCENGINE_SECURITY_TOKEN: optionalString,
  VOLC_LAS_VIDEO_UNDERSTANDING_ENABLED: strictBooleanEnvSchema.default(false),
  LAS_BASE_URL: optionalUrl,
  LAS_API_KEY: optionalString,
  LAS_VIDEO_UNDERSTANDING_MODEL: optionalString,
  // Server-side LLM gateway. It remains explicitly disabled until a deployment
  // opts in, even when Ark credentials happen to be present.
  AI_GATEWAY_ENABLED: z.string().default("false"),
  AI_DAILY_CALL_LIMIT: z.coerce.number().int().min(1).max(100_000).default(200),
  // Grill Engine: information-insufficient clarification instead of silent
  // defaults. Disabled by default; opt-in per deployment.
  GRILL_ENABLED: z.string().default("false"),
  GRILL_LLM_DAILY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(50),
  // Stable product tiers map to provider model IDs only on the server. The
  // quality tier falls back to ARK_LLM_MODEL/DOUBAO_LLM_MODEL for backward
  // compatibility; the fast tier is optional and never silently aliases the
  // quality tier.
  AI_PROMPT_LLM_QUALITY_MODEL: optionalString,
  AI_PROMPT_LLM_FAST_MODEL: optionalString,
  // 52api is a paid, read-only trend source. Keeping an explicit enable flag
  // and a separately configured ranking cell prevents an accidental request
  // just because a deployment happens to carry a provider key.
  TOPIC_RADAR_52API_ENABLED: z.string().default("false"),
  TOPIC_RADAR_52API_KEY: optionalString,
  // 52api has both historic and new Hongguo ranking products. The purchase
  // owner must select the enabled product endpoint rather than inheriting a
  // guessed default that could spend quota on the wrong source.
  TOPIC_RADAR_52API_ENDPOINT: optionalUrl,
  TOPIC_RADAR_52API_CELL_ID: optionalString,
  TOPIC_RADAR_52API_SUB_CELL_ID: optionalString,
  TOPIC_RADAR_52API_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  PI_REMOTE_API_URL: optionalUrl,
  PI_REMOTE_API_TOKEN: optionalString,
  PI_REMOTE_MODEL: optionalString,
  DOUBAO_LLM_MODEL: optionalString,
  DOUBAO_EMBEDDING_MODEL: optionalString,
  doubao_seedence_mini: optionalString,
  DOUBAO_VISION_MODEL: optionalString,
  DOUBAO_LLM_MODEL_2_0_LITE: optionalString,
  DOUBAO_LLM_MODE_2_0_LITE: optionalString,
  "DOUBAO_LLM_MODE_2.0lite": optionalString,
  TOS_BUCKET: optionalString,
  TOS_ENDPOINT: optionalString,
  TOS_SDK_ENDPOINT: optionalString,
  TOS_PUBLIC_BASE_URL: optionalString,
  ASSET_MEDIA_DISPLAY_BASE_URL: optionalHttpsUrl,
  TOS_REGION: z.string().default("cn-beijing"),
  TOS_UPLOADER_ACCESS_KEY: optionalString,
  TOS_UPLOADER_SECRET_KEY: optionalString,
  TOS_ACCESS_KEY: optionalString,
  TOS_SECRET_KEY: optionalString,
  MILVUS_URI: optionalString,
  MILVUS_USER: optionalString,
  MILVUS_PASSWORD: optionalString,
  MILVUS_COLLECTION_ASSET_ENTITY: z.string().trim().min(1)
    .default(ASSET_VECTOR_COLLECTION_NAME)
    .refine(
      (value) => value === ASSET_VECTOR_COLLECTION_NAME,
      `MILVUS_COLLECTION_ASSET_ENTITY must equal ${ASSET_VECTOR_COLLECTION_NAME}; runtime, rebuild, and deployment must use one collection`,
    ),
  MILVUS_COLLECTION_PROJECT_STORYBOARD: z.string().default("project_storyboard_vectors"),
});

const parsed = envSchema.parse(process.env);

assertCompleteColGatewayConfiguration({
  baseUrlConfigured: Boolean(parsed.COL_BASE_URL),
  apiKeyConfigured: Boolean(parsed.COL_APIKEY),
  textModels: parsed.COL_TEXT_MODELS,
  scriptBreakdownModel: parsed.COL_SCRIPT_BREAKDOWN_MODEL,
  promptDraftModel: parsed.COL_PROMPT_DRAFT_MODEL,
  promptTranslateModel: parsed.COL_PROMPT_TRANSLATE_MODEL,
});
assertCompleteWecomLoginConfiguration({
  enabled: parsed.WECOM_LOGIN_ENABLED,
  corpId: parsed.WECOM_CORP_ID,
  agentId: parsed.WECOM_AGENT_ID,
  corpSecret: parsed.WECOM_CORP_SECRET,
  callbackUrl: parsed.WECOM_CALLBACK_URL,
});

function asBoolean(value: string): boolean {
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

/**
 * 单点登录（同一账号只留一处人工会话）的默认值按运行环境推导：生产开，开发与
 * 测试关。开发和测试经常两三个人共用一个账号排查同一个问题，互相把对方踢下线
 * 只会白耗一轮；生产仍然只留一处。显式配置优先，两个方向都能覆盖。
 */
export function resolveSingleActiveSession(
  configured: boolean | undefined,
  environment: "development" | "test" | "production",
): boolean {
  return configured ?? environment === "production";
}

export function resolveGenerationOrchestrationMode(
  configured: "mock" | "real" | "disabled" | undefined,
  environment: "development" | "test" | "production",
): "mock" | "real" | "disabled" {
  return configured ?? (environment === "production" ? "disabled" : "mock");
}

function buildDatabaseUrl(): string | undefined {
  if (parsed.DATABASE_URL) return parsed.DATABASE_URL;
  if (
    !parsed.POSTGRES_HOST ||
    !parsed.POSTGRES_DB ||
    !parsed.POSTGRES_USER ||
    !parsed.POSTGRES_PASSWORD
  ) {
    return undefined;
  }

  const user = encodeURIComponent(parsed.POSTGRES_USER);
  const password = encodeURIComponent(parsed.POSTGRES_PASSWORD);
  return `postgresql://${user}:${password}@${parsed.POSTGRES_HOST}:${parsed.POSTGRES_PORT}/${parsed.POSTGRES_DB}`;
}

export const settings = {
  appName: parsed.APP_NAME,
  appVersion: parsed.APP_VERSION,
  appCommitSha: parsed.APP_COMMIT_SHA,
  debug: asBoolean(parsed.DEBUG),
  host: parsed.HOST,
  port: parsed.PORT,
  sessionTtlHours: parsed.SESSION_TTL_HOURS,
  authPasswordMinLength: parsed.AUTH_PASSWORD_MIN_LENGTH,
  appEnvironment: parsed.NODE_ENV,
  authRegistrationEnabled: asBoolean(parsed.AUTH_REGISTRATION_ENABLED),
  authRegistrationInviteCodes: commaSeparatedSecretValues(parsed.AUTH_REGISTRATION_INVITE_CODES),
  authEmailDeliveryMode: parsed.AUTH_EMAIL_DELIVERY_MODE,
  authEmailVerificationTtlSeconds: parsed.AUTH_EMAIL_VERIFICATION_TTL_SECONDS,
  authEmailVerificationMaxAttempts: parsed.AUTH_EMAIL_VERIFICATION_MAX_ATTEMPTS,
  wecomLoginEnabled: parsed.WECOM_LOGIN_ENABLED,
  wecomCorpId: parsed.WECOM_CORP_ID,
  wecomAgentId: parsed.WECOM_AGENT_ID,
  wecomCorpSecret: parsed.WECOM_CORP_SECRET,
  wecomCallbackUrl: parsed.WECOM_CALLBACK_URL,
  wecomStateTtlSeconds: parsed.WECOM_STATE_TTL_SECONDS,
  authSingleActiveSession: resolveSingleActiveSession(
    parsed.AUTH_SINGLE_ACTIVE_SESSION,
    parsed.NODE_ENV,
  ),
  adminUsernames: commaSeparatedValues(parsed.ADMIN_USERNAMES),
  allowMemberCreateProject: asBoolean(parsed.ALLOW_MEMBER_CREATE_PROJECT),
  trashRetentionDays: parsed.TRASH_RETENTION_DAYS,
  generationWorkerPollIntervalMs: parsed.GENERATION_WORKER_POLL_INTERVAL_MS,
  generationOrchestrationMode: resolveGenerationOrchestrationMode(
    parsed.GENERATION_ORCHESTRATION_MODE,
    parsed.NODE_ENV,
  ),
  generationTaskLeaseSeconds: parsed.GENERATION_TASK_LEASE_SECONDS,
  generationPilotCreditGateEnabled: parsed.GENERATION_PILOT_CREDIT_GATE_ENABLED,
  allowPaidGeneration: asBoolean(parsed.ALLOW_PAID_GENERATION),
  paidGenerationBudgetFen: parsed.PAID_GENERATION_BUDGET_FEN,
  paidGenerationReviewThresholdFen: parsed.PAID_GENERATION_REVIEW_THRESHOLD_FEN,
  companyProviderAllowlist: commaSeparatedValues(parsed.COMPANY_PROVIDER_ALLOWLIST),
  databaseUrl: buildDatabaseUrl(),
  vnextDatabaseUrl: parsed.VNEXT_DATABASE_URL,
  postgresSchema: parsed.POSTGRES_SCHEMA,
  postgresSslMode: parsed.POSTGRES_SSL_MODE,
  postgresSslRootCert: parsed.POSTGRES_SSL_ROOT_CERT,
  arkBaseUrl: parsed.ARK_BASE_URL,
  arkApiKey: parsed.ARK_API_KEY,
  arkImageModel: parsed.ARK_IMAGE_MODEL,
  arkVideoModel: parsed.ARK_VIDEO_MODEL,
  arkVideoModel25: parsed.ARK_VIDEO_MODEL_2_5,
  openspeechTtsModel: parsed.OPENSPEECH_TTS_MODEL,
  openspeechTtsEndpoint: parsed.OPENSPEECH_TTS_ENDPOINT,
  openspeechTtsToken: parsed.OPENSPEECH_TTS_TOKEN,
  openspeechTtsAppId: parsed.OPENSPEECH_TTS_APPID,
  openspeechTtsCluster: parsed.OPENSPEECH_TTS_CLUSTER,
  seedAudioEndpoint: parsed.SEED_AUDIO_ENDPOINT,
  seedAudioApiKey: parsed.SEED_AUDIO_API_KEY,
  seedAudioModel: parsed.SEED_AUDIO_MODEL,
  happyhorseApiKey: parsed.HAPPYHORSE_API_KEY,
  happyhorseBaseUrl: parsed.HAPPYHORSE_BASE_URL,
  happyhorseModel: parsed.HAPPYHORSE_MODEL,
  minimaxBaseUrl: parsed.MINIMAX_API_HOST,
  minimaxApiKey: parsed.MINIMAX_API_KEY,
  minimaxGroupId: parsed.MINIMAX_GROUP_ID,
  // A credential proves authentication, not model entitlement. Every
  // routable model remains an explicit deployment allowlist.
  minimaxLlmModels: parsed.MINIMAX_LLM_MODELS,
  minimaxImageModels: parsed.MINIMAX_IMAGE_MODELS,
  minimaxVideoModels: parsed.MINIMAX_VIDEO_MODELS,
  minimaxAudioModels: parsed.MINIMAX_AUDIO_MODELS,
  minimaxAudioVoiceId: parsed.MINIMAX_AUDIO_VOICE_ID,
  newapiGenerationEnabled: asBoolean(parsed.NEWAPI_GENERATION_ENABLED),
  newapiBaseUrl: parsed.NEWAPI_BASE_URL,
  newapiApprovedBaseUrlSha256: parsed.NEWAPI_APPROVED_BASE_URL_SHA256,
  newapiApiKey: parsed.NEWAPI_API_KEY,
  newapiGptImageModels: parsed.NEWAPI_GPT_IMAGE_MODELS,
  newapiGeminiImageModels: parsed.NEWAPI_GEMINI_IMAGE_MODELS,
  suchuangGenerationEnabled: asBoolean(parsed.SUCHUANG_GENERATION_ENABLED),
  suchuangBaseUrl: parsed.SUCHUANG_BASE_URL,
  suchuangApiKey: parsed.SUCHUANG_API_KEY,
  pricingSeedDevDatabaseIdentitySha256: parsed.PRICING_SEED_DEV_DATABASE_IDENTITY_SHA256,
  tierUnfreezeDevTargetIdentitySha256: parsed.TIER_UNFREEZE_DEV_TARGET_IDENTITY_SHA256,
  tierUnfreezeDevDeploymentBaseUrl: parsed.TIER_UNFREEZE_DEV_DEPLOYMENT_BASE_URL,
  tierUnfreezeTestEnvTargetIdentitySha256:
    parsed.TIER_UNFREEZE_TEST_ENV_TARGET_IDENTITY_SHA256,
  tierUnfreezeTestEnvDeploymentBaseUrl:
    parsed.TIER_UNFREEZE_TEST_ENV_DEPLOYMENT_BASE_URL,
  tierUnfreezeTestEnvArkCredentialSha256:
    parsed.TIER_UNFREEZE_TEST_ENV_ARK_CREDENTIAL_SHA256,
  fable007DevArkCredentialSha256: parsed.FABLE007_DEV_ARK_CREDENTIAL_SHA256,
  fable007DevMinimaxCredentialSha256: parsed.FABLE007_DEV_MINIMAX_CREDENTIAL_SHA256,
  fable007DevSeedAudioCredentialSha256: parsed.FABLE007_DEV_SEED_AUDIO_CREDENTIAL_SHA256,
  arkLlmModel: parsed.ARK_LLM_MODEL,
  arkLlmModels: parsed.ARK_LLM_MODELS ?? parsed.ARK_LLM_MODEL,
  colBaseUrl: parsed.COL_BASE_URL,
  colApiKey: parsed.COL_APIKEY,
  colApiKeyConfigured: Boolean(parsed.COL_APIKEY),
  colTextModels: parsed.COL_TEXT_MODELS,
  colScriptBreakdownModel: parsed.COL_SCRIPT_BREAKDOWN_MODEL,
  colPromptDraftModel: parsed.COL_PROMPT_DRAFT_MODEL,
  colPromptTranslateModel: parsed.COL_PROMPT_TRANSLATE_MODEL,
  seedanceAssetRegistrationEnabled: asBoolean(parsed.SEEDANCE_ASSET_REGISTRATION_ENABLED),
  seedanceAssetGroupId: parsed.SEEDANCE_ASSET_GROUP_ID,
  seedanceAssetGroupName: parsed.SEEDANCE_ASSET_GROUP_NAME,
  seedanceAssetGroupDescription: parsed.SEEDANCE_ASSET_GROUP_DESCRIPTION,
  seedanceAssetProjectName: parsed.SEEDANCE_ASSET_PROJECT_NAME,
  seedanceAssetRegistrationEndpoint: parsed.SEEDANCE_ASSET_REGISTRATION_ENDPOINT,
  seedanceAssetRegistrationRegion: parsed.SEEDANCE_ASSET_REGISTRATION_REGION,
  volcengineAccessKeyId: parsed.VOLCENGINE_ACCESS_KEY_ID,
  volcengineSecretAccessKey: parsed.VOLCENGINE_SECRET_ACCESS_KEY,
  volcengineSecurityToken: parsed.VOLCENGINE_SECURITY_TOKEN,
  volcLasVideoUnderstandingEnabled: parsed.VOLC_LAS_VIDEO_UNDERSTANDING_ENABLED,
  lasBaseUrl: parsed.LAS_BASE_URL,
  lasApiKey: parsed.LAS_API_KEY,
  lasVideoUnderstandingModel: parsed.LAS_VIDEO_UNDERSTANDING_MODEL,
  // This is an internal readiness bit, not a value that may be exposed from
  // an API. The AI gateway uses it to fail before reserving an audited call.
  arkApiKeyConfigured: Boolean(parsed.ARK_API_KEY),
  aiGatewayEnabled: asBoolean(parsed.AI_GATEWAY_ENABLED),
  aiDailyCallLimit: parsed.AI_DAILY_CALL_LIMIT,
  grillEnabled: asBoolean(parsed.GRILL_ENABLED),
  grillLlmDailyLimit: parsed.GRILL_LLM_DAILY_LIMIT,
  aiPromptLlmQualityModel:
    // 空串视为未配置：quality 档回落到 ARK_LLM_MODEL（豆包主模型），
    // 否则空串会在 ?? 链里短路成「已配置」并把 quality 档带偏。
    parsed.AI_PROMPT_LLM_QUALITY_MODEL ||
    parsed.ARK_LLM_MODEL ||
    parsed.DOUBAO_LLM_MODEL,
  aiPromptLlmFastModel: parsed.AI_PROMPT_LLM_FAST_MODEL,
  topicRadar52ApiEnabled: asBoolean(parsed.TOPIC_RADAR_52API_ENABLED),
  topicRadar52ApiKey: parsed.TOPIC_RADAR_52API_KEY,
  topicRadar52ApiEndpoint: parsed.TOPIC_RADAR_52API_ENDPOINT,
  topicRadar52ApiCellId: parsed.TOPIC_RADAR_52API_CELL_ID,
  topicRadar52ApiSubCellId: parsed.TOPIC_RADAR_52API_SUB_CELL_ID,
  topicRadar52ApiTimeoutMs: parsed.TOPIC_RADAR_52API_TIMEOUT_MS,
  piRemoteApiUrl: parsed.PI_REMOTE_API_URL,
  piRemoteApiToken: parsed.PI_REMOTE_API_TOKEN,
  piRemoteModel: parsed.PI_REMOTE_MODEL,
  doubaoLlmModel: parsed.DOUBAO_LLM_MODEL,
  doubaoEmbeddingModel: parsed.DOUBAO_EMBEDDING_MODEL,
  visionModel:
    parsed.doubao_seedence_mini ??
    parsed.DOUBAO_LLM_MODEL_2_0_LITE ??
    parsed.DOUBAO_LLM_MODE_2_0_LITE ??
    parsed["DOUBAO_LLM_MODE_2.0lite"] ??
    parsed.DOUBAO_VISION_MODEL ??
    parsed.DOUBAO_LLM_MODEL ??
    parsed.ARK_LLM_MODEL,
  tosBucket: parsed.TOS_BUCKET,
  tosEndpoint: parsed.TOS_SDK_ENDPOINT ?? parsed.TOS_ENDPOINT,
  tosPublicBaseUrl: parsed.TOS_PUBLIC_BASE_URL,
  assetMediaDisplayBaseUrl: parsed.ASSET_MEDIA_DISPLAY_BASE_URL,
  tosRegion: parsed.TOS_REGION,
  // New upload paths use the bucket-scoped child credential first. Legacy
  // names remain a temporary compatibility fallback for existing deployments.
  tosAccessKey: parsed.TOS_UPLOADER_ACCESS_KEY ?? parsed.TOS_ACCESS_KEY,
  tosSecretKey: parsed.TOS_UPLOADER_SECRET_KEY ?? parsed.TOS_SECRET_KEY,
  milvusUri: parsed.MILVUS_URI,
  milvusUser: parsed.MILVUS_USER,
  milvusPassword: parsed.MILVUS_PASSWORD,
  milvusCollectionAssetEntity: parsed.MILVUS_COLLECTION_ASSET_ENTITY,
  milvusCollectionProjectStoryboard: parsed.MILVUS_COLLECTION_PROJECT_STORYBOARD,
} as const;

export type Settings = typeof settings;

export interface ColGatewayEnvironment {
  baseUrlConfigured: boolean;
  apiKeyConfigured: boolean;
  textModels?: string;
  scriptBreakdownModel?: string;
  promptDraftModel?: string;
  promptTranslateModel?: string;
}

export interface WecomLoginEnvironment {
  enabled: boolean;
  corpId?: string;
  agentId?: string;
  corpSecret?: string;
  callbackUrl?: string;
}

export function assertCompleteWecomLoginConfiguration(input: WecomLoginEnvironment): void {
  if (!input.enabled) return;
  const required: Array<[string, boolean]> = [
    ["WECOM_CORP_ID", Boolean(input.corpId)],
    ["WECOM_AGENT_ID", Boolean(input.agentId)],
    ["WECOM_CORP_SECRET", Boolean(input.corpSecret)],
    ["WECOM_CALLBACK_URL", Boolean(input.callbackUrl)],
  ];
  const missing = required.filter(([, present]) => !present).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`企业微信登录配置不完整；缺少：${missing.join(", ")}`);
  }
}

/**
 * A partially staged company gateway must fail during startup with the exact
 * missing key names. The public HTTP layer still keeps its existing Chinese
 * business message; this diagnostic is for deployment operators only.
 */
export function assertCompleteColGatewayConfiguration(
  input: ColGatewayEnvironment,
): void {
  const configured = input.baseUrlConfigured
    || input.apiKeyConfigured
    || Boolean(input.textModels)
    || Boolean(input.scriptBreakdownModel)
    || Boolean(input.promptDraftModel)
    || Boolean(input.promptTranslateModel);
  if (!configured) return;

  const required: Array<[string, boolean]> = [
    ["COL_BASE_URL", input.baseUrlConfigured],
    ["COL_APIKEY", input.apiKeyConfigured],
    ["COL_TEXT_MODELS", Boolean(input.textModels)],
    ["COL_SCRIPT_BREAKDOWN_MODEL", Boolean(input.scriptBreakdownModel)],
    ["COL_PROMPT_DRAFT_MODEL", Boolean(input.promptDraftModel)],
    ["COL_PROMPT_TRANSLATE_MODEL", Boolean(input.promptTranslateModel)],
  ];
  const missing = required.filter(([, present]) => !present).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`公司 COL 文字通道配置不完整；缺少：${missing.join(", ")}`);
  }

  const allowedModels = new Set(commaSeparatedValuesPreservingCase(input.textModels));
  for (const [key, model] of [
    ["COL_SCRIPT_BREAKDOWN_MODEL", input.scriptBreakdownModel],
    ["COL_PROMPT_DRAFT_MODEL", input.promptDraftModel],
    ["COL_PROMPT_TRANSLATE_MODEL", input.promptTranslateModel],
  ] as const) {
    if (model && !allowedModels.has(model.trim())) {
      throw new Error(`${key} 必须列在 COL_TEXT_MODELS 中`);
    }
  }
}

function commaSeparatedValues(value: string | undefined): readonly string[] {
  return [...new Set((value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean))];
}

function commaSeparatedValuesPreservingCase(value: string | undefined): readonly string[] {
  return [...new Set((value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean))];
}

/** Invite codes are credentials, so unlike usernames their case is preserved. */
function commaSeparatedSecretValues(value: string | undefined): readonly string[] {
  return [...new Set((value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean))];
}

/**
 * Keep the same .env behavior as the previous project configuration.
 * In particular, an unquoted '#' is part of the value instead of an inline comment.
 */
export function parseCompatibleEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) values[key] = value;
  }
  return values;
}

export function resolveCompatibleEnvPaths(input: {
  cwd: string;
  nodeEnv?: string;
  explicitFile?: string;
}): string[] {
  if (input.nodeEnv === "production") return [];
  const explicit = input.explicitFile?.trim();
  if (explicit) return [path.resolve(input.cwd, explicit)];

  const localPath = path.resolve(input.cwd, ".env");
  const marker = `${path.sep}.worktrees${path.sep}`;
  const markerIndex = path.resolve(input.cwd).indexOf(marker);
  if (markerIndex < 0) return [localPath];
  const sharedPath = `${path.resolve(input.cwd).slice(0, markerIndex)}${path.sep}.env`;
  return sharedPath === localPath ? [localPath] : [sharedPath, localPath];
}

export function assertCompatibleLocalEnvAllowed(
  injectedNodeEnv: string | undefined,
  localValues: Readonly<Record<string, string>>,
): void {
  if (injectedNodeEnv !== "production" && localValues.NODE_ENV === "production") {
    throw new Error("production 运行环境禁止从本地配置文件加载变量");
  }
}

function loadCompatibleDotEnv(): void {
  const explicitFile = process.env.SHORTDRAMA_ENV_FILE;
  const paths = resolveCompatibleEnvPaths({
    cwd: process.cwd(),
    nodeEnv: process.env.NODE_ENV,
    explicitFile,
  });
  if (explicitFile?.trim() && paths.length > 0 && !existsSync(paths[0]!)) {
    throw new Error("SHORTDRAMA_ENV_FILE 指向的配置文件不存在");
  }
  const originallyInjected = new Set(Object.keys(process.env));
  const merged: Record<string, string> = {};
  for (const envPath of paths) {
    if (!existsSync(envPath)) continue;
    Object.assign(merged, parseCompatibleEnv(readFileSync(envPath, "utf8")));
  }
  assertCompatibleLocalEnvAllowed(process.env.NODE_ENV, merged);
  // 配置文件选择器只由启动环境提供；从 .env 注入相对路径会被子进程按其 cwd 重解。
  for (const [key, value] of Object.entries(merged)) {
    if (key !== "SHORTDRAMA_ENV_FILE" && !originallyInjected.has(key)) process.env[key] = value;
  }
}
