import { RELEASE_CARD_KEY_PATTERN_SOURCE, RELEASE_STATUSES } from "./types.js";

/**
 * 版本计划文档(docs/design/version-plan.md)解析器 —— S31 真源合一机制。
 *
 * 机制约定(人读着不碍事、机器能解析):
 *   - 受管理的段:`## ` 标题行尾带 <!-- section:ENTRY_KEY --> 锚点;
 *   - 段内第一张表是该档期的计划表,其后的表(如「没做的三张卡」)不解析;
 *   - 计划表的数据行行尾(末格内)带 <!-- card:CARD_KEY --> 锚点才是计划卡;
 *   - 划掉的行(首格 ~~...~~)不是计划卡,不许带锚点;
 *   - 对齐只靠锚点 key,不靠标题文本——两边命名故意不同(工程名 vs 人话),
 *     标题对齐正是 2026-07-26 分叉查不出来的根因。
 *
 * 验收标准(S37):段内、计划表之外的独立锚点块——锚点独占一行
 * `<!-- acceptance:CARD_KEY -->`,其后的非空行都是验收内容(三段式多行文本),
 * 到空行/表格行/标题行/下一个验收锚点为止。靠 card_key 与计划卡关联;
 * 锚点找不到对应的卡、锚点下没内容、同卡两个锚点、超长(>2000)都进 issues。
 * 可空:没有锚点块的卡就是没写验收,不报错。锚点不许写进表格行。
 *
 * 列映射(机械,无判断):第 2 列是卡片内容;第 3 列按表头名映射——
 * 「起因」→ reason、「依据」/「备注」→ basis,没有第 3 列则都没有。
 *
 * 解析结果是【结构 + issues 清单】:结构问题(没锚点的行、重复 key、
 * 认不出的状态词等)一律进 issues,调用方决定——测试断言 issues 为空,
 * 同步工具遇 issues 拒绝动手。解析器本身从不抛异常、从不猜内容。
 */

export const RELEASE_PLAN_DOC_PATH = "docs/design/version-plan.md";

export type ReleasePlanStatus = (typeof RELEASE_STATUSES)[number];

/** 段标题里的中文状态词 → 状态五态;按出现位置取最先命中的那个。 */
export const RELEASE_PLAN_STATUS_WORDS: ReadonlyArray<[string, ReleasePlanStatus]> = [
  ["已发布", "live"],
  ["进行中", "filming"],
  ["下一档", "scheduled"],
  ["规划中", "concept"],
  ["候选", "vision"],
];

const SECTION_ANCHOR = /<!--\s*section:([A-Za-z0-9][A-Za-z0-9.+_-]*)\s*-->/;
const CARD_ANCHOR = new RegExp(`<!--\\s*card:(${RELEASE_CARD_KEY_PATTERN_SOURCE})\\s*-->`, "g");
/** 去掉单元格里的锚点注释(锚点常落在末格,不是内容)。 */
const ANY_ANCHOR = /<!--\s*(?:card|section):[A-Za-z0-9][A-Za-z0-9.+_-]*\s*-->/g;
/** 验收锚点:独占一行才是块起始。 */
const ACCEPTANCE_BLOCK_ANCHOR = new RegExp(`^\\s*<!--\\s*acceptance:(${RELEASE_CARD_KEY_PATTERN_SOURCE})\\s*-->\\s*$`);
/** 验收锚点出现在任何其他位置(如表格行内)是结构错误。 */
const ACCEPTANCE_ANCHOR_ANYWHERE = new RegExp(`<!--\\s*acceptance:${RELEASE_CARD_KEY_PATTERN_SOURCE}\\s*-->`);
/** 与 zod 合同(releaseCardPayloadSchema.acceptance)一致的上限,超出进 issues。 */
const ACCEPTANCE_MAX_LENGTH = 2000;

export interface ReleasePlanDocCard {
  cardKey: string;
  /** 首格文本,已去 ** / ~~ 标记。 */
  title: string;
  /** 第 2 列(内容),已去标记。 */
  body: string;
  /** 第 3 列,表头为「起因」时填入。 */
  reason?: string;
  /** 第 3 列,表头为「依据」或「备注」时填入。 */
  basis?: string;
  /** 验收标准(S37):段内 <!-- acceptance:CARD_KEY --> 锚点块的多行文本;可空。 */
  acceptance?: string;
  /** 1 起始行号,供报错定位。 */
  line: number;
}

export interface ReleasePlanDocSection {
  entryKey: string;
  /** 标题文字(—— 之前部分),只在新建缺失段时用作 payload.title。 */
  title: string;
  status: ReleasePlanStatus;
  cards: ReleasePlanDocCard[];
  /** 1 起始行号,供报错定位。 */
  line: number;
}

export interface ReleasePlanDoc {
  sections: ReleasePlanDocSection[];
  /** 结构问题清单;为空才算健康。 */
  issues: string[];
}

/** 卡片的档期版本语:远景段写「未定档」,其余写段业务键(与 024 播种口径一致)。 */
export function expectedCardRelease(section: Pick<ReleasePlanDocSection, "entryKey" | "status">): string {
  return section.status === "vision" ? "未定档" : section.entryKey;
}

function stripMarkup(value: string): string {
  return value.replace(ANY_ANCHOR, "").replaceAll("**", "").replaceAll("~~", "").trim();
}

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const closed = body.endsWith("|") ? body.slice(0, -1) : body;
  return closed.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replaceAll(" ", "")));
}

/** 表头第 3 列名 → 卡片字段;返回 undefined 表示该表没有第 3 列。 */
function thirdColumnField(caption: string[]): "reason" | "basis" | null | undefined {
  const name = caption[2];
  if (name === undefined) return undefined;
  if (name === "起因") return "reason";
  if (name === "依据" || name === "备注") return "basis";
  return null;
}

export function parseReleasePlanDoc(markdown: string): ReleasePlanDoc {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const issues: string[] = [];
  const sections: ReleasePlanDocSection[] = [];
  const seenSectionKeys = new Set<string>();
  const seenCardKeys = new Map<string, string>();

  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const header = line.match(/^##\s+(.*)$/);
    const sectionAnchor = header ? header[1]!.match(SECTION_ANCHOR) : null;
    if (!header || !sectionAnchor) {
      index += 1;
      continue;
    }

    const entryKey = sectionAnchor[1]!;
    const headerLine = index + 1;
    const headerText = header[1]!.replace(SECTION_ANCHOR, "").trim();
    const title = stripMarkup(headerText.split("——")[0] ?? headerText);
    if (seenSectionKeys.has(entryKey)) {
      issues.push(`第 ${headerLine} 行:段锚点 ${entryKey} 与前文重复,本段被忽略`);
      index += 1;
      continue;
    }
    seenSectionKeys.add(entryKey);

    let status: ReleasePlanStatus | undefined;
    let statusAt = Number.POSITIVE_INFINITY;
    for (const [word, mapped] of RELEASE_PLAN_STATUS_WORDS) {
      const at = headerText.indexOf(word);
      if (at >= 0 && at < statusAt) {
        status = mapped;
        statusAt = at;
      }
    }
    index += 1;
    if (!status) {
      issues.push(`第 ${headerLine} 行:段 ${entryKey} 的标题里认不出状态词(已发布/进行中/下一档/规划中/候选),本段被忽略`);
      continue;
    }

    // 段内第一张表 = 计划表;其后的表不解析。
    let caption: string[] | null = null;
    let thirdField: "reason" | "basis" | null | undefined;
    let thirdFieldReported = false;
    let tableFound = false;
    const cards: ReleasePlanDocCard[] = [];
    const sectionCardKeys = new Set<string>();
    // 验收锚点块(S37):锚点独占一行,后续非空行是内容,到空行/表格行/标题行/
    // 下一个锚点为止。先收进 blocks,段解析完再按 card_key 挂到卡上。
    const acceptanceBlocks: Array<{ cardKey: string; text: string; line: number }> = [];
    let acceptanceDraft: { cardKey: string; line: number; lines: string[] } | null = null;
    const flushAcceptanceDraft = (): void => {
      if (!acceptanceDraft) return;
      const draft = acceptanceDraft;
      acceptanceDraft = null;
      const text = draft.lines.join("\n").trim();
      if (!text) {
        issues.push(`第 ${draft.line} 行:验收锚点 ${draft.cardKey} 下面没有内容——没写验收就是没写,空锚点请删掉`);
      } else if (text.length > ACCEPTANCE_MAX_LENGTH) {
        issues.push(`第 ${draft.line} 行:卡 ${draft.cardKey} 的验收标准 ${text.length} 字,超 ${ACCEPTANCE_MAX_LENGTH} 字上限(与 zod 合同对齐)`);
      } else {
        acceptanceBlocks.push({ cardKey: draft.cardKey, text, line: draft.line });
      }
    };

    while (index < lines.length && !lines[index]!.startsWith("## ")) {
      const row = lines[index]!;
      const rowLine = index + 1;
      index += 1;
      const blockAnchor = row.match(ACCEPTANCE_BLOCK_ANCHOR);
      if (blockAnchor) {
        flushAcceptanceDraft();
        acceptanceDraft = { cardKey: blockAnchor[1]!, line: rowLine, lines: [] };
        continue;
      }
      if (acceptanceDraft) {
        if (row.trim() === "") {
          flushAcceptanceDraft(); // 空行结束验收块;本行按普通行继续处理
        } else if (!row.trimStart().startsWith("|") && !row.trimStart().startsWith("#")) {
          acceptanceDraft.lines.push(row.trimEnd());
          continue;
        } else {
          flushAcceptanceDraft(); // 表格行/小节标题结束验收块;本行按普通行继续处理
        }
      }
      if (!row.trimStart().startsWith("|")) {
        if (ACCEPTANCE_ANCHOR_ANYWHERE.test(row)) {
          issues.push(`第 ${rowLine} 行:验收锚点必须独占一行——锚点前后都不能带别的字`);
        }
        if (tableFound && caption !== null) {
          // 计划表结束于首个非表行(含空行);之后的表不再解析。
          caption = null;
        }
        continue;
      }
      if (ACCEPTANCE_ANCHOR_ANYWHERE.test(row)) {
        issues.push(`第 ${rowLine} 行:验收锚点不许写在表格行里——它是计划表之外的独立块`);
      }
      if (!tableFound) {
        tableFound = true;
        caption = splitRow(row);
        thirdField = thirdColumnField(caption);
        continue;
      }
      if (caption === null) continue; // 计划表已结束,忽略后续表
      const cells = splitRow(row);
      if (isSeparatorRow(cells)) continue;

      const anchors = [...row.matchAll(CARD_ANCHOR)].map((match) => match[1]!);
      const firstCell = cells[0] ?? "";
      const struck = firstCell.replaceAll("**", "").trimStart().startsWith("~~");
      if (struck) {
        if (anchors.length > 0) {
          issues.push(`第 ${rowLine} 行:划掉的卡片行不许带锚点(${anchors.join(", ")})——划掉=移出计划,锚点请一并去掉`);
        }
        continue;
      }
      if (anchors.length === 0) {
        issues.push(`第 ${rowLine} 行:段 ${entryKey} 的计划表有没有锚点的卡片行「${stripMarkup(firstCell)}」——有锚点的行才是计划卡,请补 <!-- card:... -->`);
        continue;
      }
      if (anchors.length > 1) {
        issues.push(`第 ${rowLine} 行:一行带了多个卡片锚点(${anchors.join(", ")}),无法对齐`);
        continue;
      }
      const cardKey = anchors[0]!;
      if (sectionCardKeys.has(cardKey)) {
        issues.push(`第 ${rowLine} 行:card_key ${cardKey} 在段 ${entryKey} 内重复`);
        continue;
      }
      const seenIn = seenCardKeys.get(cardKey);
      if (seenIn) {
        issues.push(`第 ${rowLine} 行:card_key ${cardKey} 在段 ${entryKey} 与段 ${seenIn} 之间重复——同一键同时进两段会让对齐歧义`);
        continue;
      }
      const cardTitle = stripMarkup(firstCell);
      const body = stripMarkup(cells[1] ?? "");
      if (!cardTitle) {
        issues.push(`第 ${rowLine} 行:卡片 ${cardKey} 的首格(卡片名)为空`);
        continue;
      }
      if (!body) {
        issues.push(`第 ${rowLine} 行:卡片 ${cardKey} 的第 2 列(内容)为空——表格结构可能变了,解析器需要跟着改`);
        continue;
      }
      if (thirdField === null && !thirdFieldReported) {
        thirdFieldReported = true;
        issues.push(`第 ${rowLine} 行:段 ${entryKey} 计划表的第 3 列表头「${caption![2]}」认不出(起因/依据/备注),该列内容被忽略`);
      }
      const card: ReleasePlanDocCard = { cardKey, title: cardTitle, body, line: rowLine };
      const thirdRaw = stripMarkup(cells[2] ?? "");
      // 「—」占位=没写,不当成内容(否则 sync 会把占位破折号写进库)。
      const thirdValue = /^[—–-]+$/.test(thirdRaw) ? "" : thirdRaw;
      if (thirdField && thirdValue) card[thirdField] = thirdValue;
      sectionCardKeys.add(cardKey);
      seenCardKeys.set(cardKey, entryKey);
      cards.push(card);
    }

    if (!tableFound) {
      issues.push(`第 ${headerLine} 行:段 ${entryKey} 里找不到计划表`);
    } else if (cards.length === 0 && !issues.some((issue) => issue.includes(`段 ${entryKey}`))) {
      issues.push(`第 ${headerLine} 行:段 ${entryKey} 的计划表没有解析出任何卡片`);
    }
    // 验收块挂到卡上:同卡重复锚点、锚点找不到卡(孤儿验收)都是结构错误。
    flushAcceptanceDraft();
    const acceptanceBlockKeys = new Set<string>();
    for (const block of acceptanceBlocks) {
      if (acceptanceBlockKeys.has(block.cardKey)) {
        issues.push(`第 ${block.line} 行:验收锚点 ${block.cardKey} 在段 ${entryKey} 内重复——一张卡只能有一个验收块`);
        continue;
      }
      acceptanceBlockKeys.add(block.cardKey);
      const card = cards.find((item) => item.cardKey === block.cardKey);
      if (!card) {
        issues.push(`第 ${block.line} 行:段 ${entryKey} 里有验收锚点 ${block.cardKey},但计划表里没有这张卡——验收不能成孤儿,先立卡或删锚点`);
        continue;
      }
      card.acceptance = block.text;
    }
    sections.push({ entryKey, title, status, cards, line: headerLine });
  }

  return { sections, issues };
}
