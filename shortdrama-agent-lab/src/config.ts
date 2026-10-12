import { findModel } from './models/registry';

export interface AppConfig {
  port: number;
  baseUrl: string;
  defaultModel: string;
  reasoningEffort: string;
  maxOutputTokens: number;
  timeoutMs: number;
  maxConcurrentCalls: number;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  let url: URL;
  try { url = new URL(env.LLM_BASE_URL ?? 'http://127.0.0.1:8787/v1'); }
  catch { throw new Error('Invalid LLM_BASE_URL'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.search || url.hash || !['/v1', '/v1/'].includes(url.pathname)) {
    throw new Error('LLM_BASE_URL must be http://127.0.0.1:<port>/v1; remote deployment is not configured');
  }
  const defaultModel = env.LLM_DEFAULT_MODEL ?? 'gpt-5.6-terra';
  const model = findModel(defaultModel);
  if (!model) throw new Error('Invalid LLM_DEFAULT_MODEL');
  // Keep the default model within a practical first-pass budget.  Other
  // explicitly selected models still retain their own registry defaults.
  const reasoningEffort = env.LLM_REASONING_EFFORT ?? 'medium';
  if (reasoningEffort !== 'model-default' && !model.reasoningEfforts.includes(reasoningEffort)) {
    throw new Error('LLM_REASONING_EFFORT is unsupported for LLM_DEFAULT_MODEL');
  }
  const port = integer('PORT', 8788, 1024, 65535);
  if (port === Number(url.port || 80)) throw new Error('PORT must differ from the proxy port');
  return Object.freeze({ port, baseUrl: url.href.replace(/\/$/, ''), defaultModel, reasoningEffort,
    maxOutputTokens: integer('LLM_MAX_OUTPUT_TOKENS', 8192, 256, 32768),
    timeoutMs: integer('LLM_TIMEOUT_MS', 180000, 1000, 600000),
    maxConcurrentCalls: integer('LLM_MAX_CONCURRENT_CALLS', 2, 1, 8) });
}
