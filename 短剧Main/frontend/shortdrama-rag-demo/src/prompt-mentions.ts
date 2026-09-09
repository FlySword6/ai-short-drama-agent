/* ============================================================
   prompt-mentions.ts — 提示词框 @ 提及（纯逻辑，不引 CSS/DOM）

   口径（S2b-1）：
   - 输入 @ 弹出已匹配资产，选中后把 `@资产名` 插到光标处；
   - @ 序列化格式等 Fable 契约②——本模块只占位：人读层就是 `@名称`，
     提交时参考集仍以「选中的参考」为准（K4 裁决：所见非所提交的通道不开），
     槽位编号由 IR 编译器在产物层分配（K3 已就位）。
   ============================================================ */

/** @ 查询的触发上下文：光标前的 `@前缀`。 */
export interface MentionQuery {
  /** '@' 在全文中的下标。 */
  start: number;
  /** 查询串结束下标（= 光标位）。 */
  end: number;
  /** '@' 之后、光标之前的已输入内容。 */
  query: string;
}

export interface MentionCandidate {
  /** 稳定主键（项目资产引用 id 或资产 id）。 */
  key: string;
  /** 资产名（插入文本与匹配都用它）。 */
  name: string;
  /** 下拉副标题（职责/类型），仅展示。 */
  subtitle?: string;
}

/** '@' 前一位允许出现的字符（空白/句读/括号/引号），防止把邮箱等文本当触发。 */
const TRIGGER_PREFIX_PATTERN = /[\s，。、；：：（(\[【「『“"'‘]/;

/** 查询串允许字符：非空白非 @ 至多 24 字。 */
const MAX_QUERY_LENGTH = 24;

/** 探测光标前是否处于 @ 查询态；不处于返回 null。 */
export function detectMentionQuery(text: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > text.length) return null;
  const beforeCaret = text.slice(0, caret);
  const at = beforeCaret.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0) {
    const prev = text[at - 1]!;
    if (!TRIGGER_PREFIX_PATTERN.test(prev)) return null;
  }
  const query = beforeCaret.slice(at + 1);
  if (query.length > MAX_QUERY_LENGTH) return null;
  if (/\s/.test(query)) return null;
  return { start: at, end: caret, query };
}

/** 候选过滤：前缀命中优先，其余按包含命中，各自保持传入顺序。 */
export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
  limit = 8,
): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return candidates.slice(0, limit);
  const prefix: MentionCandidate[] = [];
  const contains: MentionCandidate[] = [];
  for (const candidate of candidates) {
    const name = candidate.name.toLowerCase();
    if (name.startsWith(needle)) prefix.push(candidate);
    else if (name.includes(needle)) contains.push(candidate);
  }
  return [...prefix, ...contains].slice(0, limit);
}

/** 把选中的资产名写入 @ 查询位（补一个尾随空格），返回新文本与新光标位。 */
export function insertMention(
  text: string,
  active: MentionQuery,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `;
  const next = `${text.slice(0, active.start)}${inserted}${text.slice(active.end)}`;
  return { text: next, caret: active.start + inserted.length };
}

/** 在任意光标位插入 `@名称 `（chips 点击写入；不依赖查询态）。 */
export function appendMentionAtCaret(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const safeCaret = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, safeCaret);
  const needLeadingSpace = before.length > 0 && !TRIGGER_PREFIX_PATTERN.test(before[before.length - 1]!);
  const inserted = `${needLeadingSpace ? " " : ""}@${name} `;
  return { text: `${before}${inserted}${text.slice(safeCaret)}`, caret: safeCaret + inserted.length };
}

export interface ExtractedMention {
  candidate: MentionCandidate;
  /** 首次出现下标（稳定排序用）。 */
  index: number;
}

/**
 * 从文本解析实际提及（按候选名首次出现排序、按 key 去重）。
 * 名称 <2 字不参与（与 script-structure 同口径，防单字误命中）。
 */
export function extractMentions(
  text: string,
  candidates: readonly MentionCandidate[],
): ExtractedMention[] {
  const found: ExtractedMention[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const name = candidate.name.trim();
    if (name.length < 2 || seen.has(candidate.key)) continue;
    const index = text.indexOf(`@${name}`);
    if (index < 0) continue;
    seen.add(candidate.key);
    found.push({ candidate, index });
  }
  return found.sort((a, b) => a.index - b.index);
}
