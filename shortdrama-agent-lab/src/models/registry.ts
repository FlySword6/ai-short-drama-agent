export interface ModelSpec {
  id: string;
  imageInput: boolean;
  configuredContextTokens: number;
  reasoningEfforts: readonly string[];
  defaultReasoningEffort: string;
  note?: string;
}

const gpt = ['low', 'medium', 'high', 'xhigh', 'max'];
const other = ['low', 'high', 'max'];
const qwen = ['low', 'medium', 'xhigh'];
const spec = (id: string, imageInput: boolean, configuredContextTokens: number,
  reasoningEfforts: string[], defaultReasoningEffort: string, note?: string): ModelSpec =>
  Object.freeze({ id, imageInput, configuredContextTokens,
    reasoningEfforts: Object.freeze([...reasoningEfforts]), defaultReasoningEffort, note });

// Snapshot of the existing local proxy's capability/effort configuration (2026-09-30).
// These are configured limits, NOT independently verified provider hard limits.
export const MODELS: readonly ModelSpec[] = Object.freeze([
  spec('gpt-5.6-terra', true, 900000, gpt, 'max'),
  spec('gpt-5.6-luna', true, 900000, gpt, 'max', '历史图片测试曾受上游资源限制，当前可用性需单独核实。'),
  spec('deepseek-v4-pro-0813-ali', false, 1000000, other, 'max'),
  spec('deepseek-v4.1-flash-ali', true, 1000000, other, 'max'),
  spec('kimi-k3', true, 1000000, other, 'max'),
  spec('glm-5.3', false, 1000000, other, 'max'),
  spec('glm-5.3-flash', true, 1000000, other, 'max'),
  spec('qwen3.7-plus', true, 1000000, ['high'], 'high', 'high 仅表示启用 thinking，不表示供应商原生 high 档。'),
  spec('qwen3.8-flash', true, 1000000, qwen, 'xhigh'),
  spec('codewiz-qwen3.8-max', true, 1000000, qwen, 'xhigh'),
  spec('gemini-3.1-pro-preview(high)', true, 200000, ['high'], 'high', '同一模型的 High 预设；长文本准确性未保证。'),
  spec('gemini-3.1-pro-preview(low)', true, 200000, ['low'], 'low', '同一模型的 Low 预设；长文本准确性未保证。'),
  spec('gemini-3.8-flash', true, 1000000, ['low', 'medium', 'high'], 'high'),
  spec('claude-sonnet-5', true, 1000000, gpt, 'max'),
]);

export function findModel(id: string): ModelSpec | undefined {
  return MODELS.find(model => model.id === id);
}
