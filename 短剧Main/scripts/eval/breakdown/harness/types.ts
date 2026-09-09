/**
 * 拆解质量评测的共享类型。
 *
 * 一次「运行」= 一个模型把一集剧本拆一遍。评测把运行结果与独立标注的金标
 * 对照,算出稳定性 / 准确率 / 召回率 / 耗时成本四类指标。
 */
import type { ScriptBreakdownDraft } from "../../../../src/modules/script-breakdown/types.js";

export interface EvalModelSpec {
  /** 报告里用的短名,同时是产物文件名的一部分。 */
  id: string;
  /** 真实模型 ID,原样发给供应商。 */
  model: string;
  /** 走哪条通道:火山方舟 / 公司通道。 */
  channel: "ark" | "col";
  /** 元 / 百万 token。查不到公开单价就填 null——报告只报 token,不编钱。 */
  pricePerMillion: { input: number | null; output: number | null; source: string | null };
}

export interface EvalConfig {
  /** 剧本正文所在目录。正文是版权件,不进仓库,只在金标里留 sha256。 */
  dataRoot: string;
  episodes: string[];
  models: EvalModelSpec[];
  /** 同一集连跑几次。稳定性指标全靠它。 */
  repeats: number;
  maxToolCalls: number;
  /**
   * 模型往返次数上限。#240 给 agent 循环加硬上限后这一项成了必填,
   * 值取生产同款(service.ts 的 MAX_TURNS = 60):它是安全阀不是被测变量,
   * 评测与生产用同一个阀值,跑出来的失败才对得上线上的失败。
   */
  maxTurns: number;
  maxTokens: number;
  /** 「能不能上生产」的判定门槛。写在配置里,判定就不靠人拍脑袋。 */
  productionGate: {
    why: string;
    successRate: number;
    characterRecall: number;
    characterPrecision: number;
    sceneCountExactRate: number;
  };
}

export interface EvalRunRecord {
  episodeId: string;
  modelId: string;
  model: string;
  channel: string;
  attempt: number;
  ok: boolean;
  /** 失败分类:传输失败 / 模型停口 / 硬校验不过 / 评测脚手架自身出错。 */
  failureKind: "transport" | "stopped_early" | "validation" | "harness" | null;
  failureReason: string | null;
  /** 一次模型往返抛出来的异常。agent 循环会吞掉它们,这里留底。 */
  turnErrors: string[];
  /** 工具调用被工作台拒绝的次数。范式换对了的话这个数应该是 0。 */
  rejectedToolCalls: number;
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  draft: ScriptBreakdownDraft;
  startedAt: string;
}

export interface GoldAssetItem {
  id: string;
  name: string;
  aliases?: string[];
  onScreen?: boolean;
  confidence?: string;
  /** 行号 + 引文。既是标注可回查的凭据,也是跨语言认亲的依据。 */
  evidence?: Array<{ line: number; quote: string }>;
}

export interface GoldAssetEpisode {
  episodeId: string;
  assets: { character: GoldAssetItem[]; location: GoldAssetItem[]; prop: GoldAssetItem[] };
  /** 明确判定「不该当资产」的条目。拆出来就是误报。 */
  excluded: Array<{ name: string; kind: string }>;
  /** 两种读法都立得住的条目。不进分母,单独统计。 */
  disputed: Array<{ id: string; item: string; kind: string }>;
}

export interface GoldSceneEpisode {
  episodeId: string;
  counts: { scenes: number; shots: number };
  scenes: Array<{ order: number; headingLine: number; heading: string; shotCount: number }>;
}
