import type { ScriptLine } from "./types.js";

/** 单集剧本文本上限:超出即拒绝,防止超大输入冲垮提示词与成本预算。 */
export const SCRIPT_MAX_CHARS = 60_000;
/** 切分后的文案行上限。 */
export const SCRIPT_MAX_LINES = 2_000;

/**
 * 把剧本文本确定性切成连续编号的文案行:按非空段落切分、trim、从 0 连续
 * 编号。这一步旧实现交给模型重打原文,既花钱又引入编号漂移;行切分没有
 * 创作成分,服务端做更稳、可复现,也让断点续跑有稳定锚点。
 */
export function chunkScriptLines(scriptText: string): ScriptLine[] {
  return scriptText
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter((text) => text.length > 0)
    .map((text, lineIndex) => ({ lineIndex, text }));
}

export function assertScriptBounds(scriptText: string, lines: ScriptLine[]): void {
  if (scriptText.length > SCRIPT_MAX_CHARS) {
    throw new ScriptInputError(`剧本太长,一次最多拆解 ${SCRIPT_MAX_CHARS} 个字符`);
  }
  if (lines.length === 0) {
    throw new ScriptInputError("剧本内容不能为空");
  }
  if (lines.length > SCRIPT_MAX_LINES) {
    throw new ScriptInputError(`剧本行数超过上限 ${SCRIPT_MAX_LINES},请先拆分集数`);
  }
}

export class ScriptInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptInputError";
  }
}

/** 行的稳定文本引用:shots 阶段的提示词与校验都按这个编号对齐。 */
export function formatLinesForPrompt(lines: ScriptLine[]): string {
  return lines.map((line) => `L${line.lineIndex}\t${line.text}`).join("\n");
}
