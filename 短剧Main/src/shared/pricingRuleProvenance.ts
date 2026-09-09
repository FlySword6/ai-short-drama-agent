/** S58 研究公式的精确来源标签；有公式依据不等于已完成逐档实测和付费解锁。 */
export const INFERRED_EXPERIMENTAL_PRICE_SOURCE_KIND = "官方牌价×加成率(推算)";

/**
 * S58-era 数据曾把研究候选误写为 active/status=active。公共投影和报价必须再按来源
 * fail-closed，直到单档经管理动作改成可追溯的实测来源。
 */
export function isInferredExperimentalPricingRule(metadata: Record<string, unknown>): boolean {
  return metadata.price_source_kind === INFERRED_EXPERIMENTAL_PRICE_SOURCE_KIND;
}
