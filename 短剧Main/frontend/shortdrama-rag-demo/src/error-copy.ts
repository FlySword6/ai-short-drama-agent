/* ============================================================
   error-copy.ts — R96 全局判据：用户可见错误文案=业务语言

   判据：前端不许直接显示后端英文错误串（厂商名/HTTP 码/英文原话/内部
   状态机名）。实例：`Ark submission outcome is unknown` 曾原样上屏。

   两层兜底：
   1. 映射表 BACKEND_ERROR_COPY——已知后端错误串翻成业务语言，
      每条都核对过后端源码出处（见各行注释）；
   2. 未知错误——含中文视为后端已人话化，透传；纯英文/技术串给通用
      业务话术，原文进 console.warn 留排障 detail（不上屏）。

   后端中文字段交付前这层就是兜底；交付后仍可留（双保险）。
   ============================================================ */

/** 已知后端错误串 → 业务话术（按序匹配，先中先返）。 */
export const BACKEND_ERROR_COPY: readonly [pattern: RegExp, copy: string][] = [
  // Ark / openspeech 提交结果未知（网络层断，任务真实状态不可知）
  // 出处：src/modules/generation/provider/arkGenerationProvider.ts、openspeechTtsProvider.ts
  [/submission outcome is unknown/i, "提交结果暂时未知，请稍后到任务列表看状态"],
  // 结果落库重试耗尽 出处：src/modules/generation/repository.ts recordPersistenceFailure
  [/persistence recovery retry limit.*exhausted/i, "生成结果保存失败，请稍后到任务列表看状态"],
  // 报价过期/被消费 出处：生成报价链错误码（confirmPendingQuote 同款判定）
  [/GENERATION_QUOTE_EXPIRED|quote_stale|quote.{0,20}expired/i, "这次报价已过期，请重新生成"],
  [/GENERATION_QUOTE_CONFLICT/i, "这次报价已被使用，请重新生成"],
  // 余额不足（厂商/计费侧原话可能是英文；issue #26 口径：只能找管理员调账，没有充值/再核码出路）
  [/insufficient|余额不足/i, "积分不够，请联系管理员调账后再试"],
  // 内容审核（厂商审核拒绝原话可能是英文）
  [/content.{0,24}(moderation|filter|policy|review|reject)|审核未通过/i, "内容未通过审核，请调整提示词或参考后重试"],
  // 超时/限流/断网（网络层技术串）
  [/timed?\s?out|timeout|ETIMEDOUT/i, "服务响应超时，请稍后重试"],
  [/rate\s?limit|too many requests|429/i, "请求太频繁，请稍等片刻再试"],
  [/fetch failed|failed to fetch|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network/i, "网络连接异常，请检查网络后重试"],
];

/** 含中文=后端已人话化，可以透传给用户。 */
function hasChinese(text: string): boolean {
  return /[一-鿿]/.test(text);
}

/** 取错误首行：剥 Error 前缀与堆栈帧；humanErrorMessage 与生成链共用本出口。 */
function rawErrorLine(reason: unknown): string {
  const raw = reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
  const firstLine = raw.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  return firstLine
    .replace(/^(?:\w+)?error:\s*/i, "")
    .replace(/\s+at\s+[\w$.<>]+\s*\(.*$/, "")
    .trim();
}

/**
 * 用户可见错误文案唯一出口（生成链）：
 * 已知后端错误串 → 映射表业务话术；含中文 → 透传（截断 120）；
 * 未知英文/技术串 → 通用业务话术 fallback，原文 console.warn 留排障 detail。
 */
export function businessErrorMessage(reason: unknown, fallback = "操作失败，请重试"): string {
  const raw = rawErrorLine(reason);
  if (!raw) return fallback;
  for (const [pattern, copy] of BACKEND_ERROR_COPY) {
    if (pattern.test(raw)) return copy;
  }
  if (hasChinese(raw)) return raw.length > 120 ? `${raw.slice(0, 117)}…` : raw;
  console.warn("[error-copy] 未映射的后端错误原文（补映射表请到 error-copy.ts）:", raw);
  return fallback;
}

/**
 * 生成提交失败文案（GENDOMAIN 余额感知，issue #26 稳定错误码）：
 * 余额不足（account_credit_insufficient）=说真话带数——这单要多少、余额多少、还差多少;
 * 去向只有「联系管理员调账」（已注册账号不能重复核销邀请码补余额，也没有充值入口）;
 * 有数带数,无数落口径;禁指错方向的兜底话术(「请检查标出的填写内容」场景根因=余额不够)。
 * 当日额度用完与账户未就绪同码表直说。其余错误走 businessErrorMessage 统一出口。
 */
export function generationFailureCopy(reason: unknown, credit?: { costPoints: number | null; balancePoints: number | null }): string {
  const code = reason instanceof Error && "code" in reason ? String((reason as { code?: unknown }).code ?? "") : "";
  if (code === "account_credit_insufficient") {
    const cost = credit?.costPoints ?? null;
    const balance = credit?.balancePoints ?? null;
    if (cost != null && balance != null && cost > balance) {
      return `积分不够：这单需要 ${cost} 积分，余额 ${balance} 积分，还差 ${cost - balance} 积分；请联系管理员调账后再试`;
    }
    return "积分不够：请联系管理员调账后再试";
  }
  if (code === "account_credit_daily_limit_exceeded") {
    return "今天可用的积分已用完，明天再来，或联系管理员调整额度";
  }
  if (code === "account_credit_unavailable") {
    return "积分账户暂未就绪，请稍后重试；反复出现请联系管理员";
  }
  return businessErrorMessage(reason);
}
