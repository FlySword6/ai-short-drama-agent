import { AppError } from "../../shared/errors.js";

/**
 * Rule-based Chinese script episode splitter — zero LLM dependency. Ported
 * from origin/dev's `EpisodeParserService` (a NestJS service) as a plain
 * function so it has no framework dependency.
 *
 * Splits a full script on Chinese "第N集/话" headings and English
 * "Episode N" / "Ep. N" headings, supporting Arabic digits plus Chinese or
 * English numerals. Scene headings whose stated episode number
 * doesn't match their enclosing episode only produce a warning; they never
 * block the split.
 *
 * 集标题归一（2026-08-17 用户反馈 R2-12）：英文标题统一规范成
 * `EPISODE N`（有副标题则 `EPISODE N: 副标题`）——`Ep. Two` / `episode 2`
 * 等变体不再原样落库；中文标题保持原文（第N集/话及其副标题）。
 */

export interface ParsedEpisode {
  episodeNo: number;
  title: string;
  content: string;
}

export interface EpisodeParseResult {
  preamble: string;
  episodes: ParsedEpisode[];
  warnings: string[];
}

interface EpisodeHeading {
  episodeNo: number;
  index: number;
  contentStart: number;
  headingText: string;
  kind: "chinese" | "english";
}

const SCENE_HEADING_PATTERN = /^[ \t]*(\d+)[ \t]*[-—–.．][ \t]*(\d+)[ \t]+(.+)$/gmu;

/** 英文集号词表（阿拉伯数字 + 英文数词序列），集标题检测与归一共用。 */
const ENGLISH_NUMBER_PATTERN = "(?:\\d+|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred))(?:[ \\t-]+(?:and|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred))*";

/** 英文集标题：`Episode/Ep. N` + 可选副标题；组 1=集号词，组 2=分隔符后的副标题段。 */
const ENGLISH_HEADING_PATTERN = new RegExp(
  `^(?:episode|ep\\.?)[ \\t]*(${ENGLISH_NUMBER_PATTERN})(?=$|[ \\t:：\\-—–.．])(.*)$`,
  "iu",
);

// Copied verbatim from the source implementation's digit map — do not extend
// or "improve" this boundary; downstream behavior depends on matching it exactly.
const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const ENGLISH_UNITS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const ENGLISH_TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/**
 * Parses one full script into ordered episode documents, the text before the
 * first episode heading, and any scene-numbering warnings.
 *
 * @param scriptText the full raw script text
 * @throws AppError(400) when no episode heading is found, an episode number is
 *   invalid or duplicated, or an episode's body is empty
 */
export function parseEpisodes(scriptText: string): EpisodeParseResult {
  const headings = findHeadings(scriptText);
  if (headings.length === 0) {
    throw new AppError(
      400,
      "unrecognized_episode_format",
      "拆分剧本没成：没有找到集数标题，请使用“第1集”这类标题。",
    );
  }
  assertUniqueEpisodeNumbers(headings);

  const warnings: string[] = [];
  const episodes = headings.map((heading, index): ParsedEpisode => {
    const nextIndex = headings[index + 1]?.index ?? scriptText.length;
    const contentAfterHeading = scriptText.slice(heading.contentStart, nextIndex).trim();
    if (!contentAfterHeading) {
      throw new AppError(
        400,
        "empty_episode_content",
        `拆分剧本没成：第${heading.episodeNo}集没有正文，请补充后再试。`,
      );
    }
    inspectScenes(contentAfterHeading, heading.episodeNo, warnings);
    return {
      episodeNo: heading.episodeNo,
      title: canonicalHeadingTitle(heading),
      content: contentAfterHeading,
    };
  });

  const firstHeading = headings[0];
  return {
    preamble: firstHeading ? scriptText.slice(0, firstHeading.index).trim() : "",
    episodes,
    warnings,
  };
}

/**
 * 集标题归一：中文标题保持原文（「第1集」「第1集：重逢」）；英文标题统一成
 * `EPISODE N`——`Ep.`/大小写变体不原样落库，副标题一律丢弃（R2-15：用户只要
 * `EPISODE 1`，不要后面的描述）。
 */
function canonicalHeadingTitle(heading: EpisodeHeading): string {
  if (heading.kind === "chinese") return heading.headingText;
  return `EPISODE ${heading.episodeNo}`;
}

/** Finds episode headings while retaining source offsets for exact body slicing. */
function findHeadings(scriptText: string): EpisodeHeading[] {
  const headings: EpisodeHeading[] = [];
  let lineStart = 0;
  while (lineStart < scriptText.length) {
    const lineEnd = scriptText.indexOf("\n", lineStart);
    const nextLineStart = lineEnd >= 0 ? lineEnd + 1 : scriptText.length;
    const rawLine = scriptText.slice(lineStart, lineEnd >= 0 ? lineEnd : scriptText.length).replace(/\r$/u, "");
    const heading = parseHeadingLine(rawLine);
    if (heading !== null) {
      headings.push({
        episodeNo: heading.episodeNo,
        index: lineStart,
        contentStart: nextLineStart,
        headingText: rawLine.trim(),
        kind: heading.kind,
      });
    }
    if (lineEnd < 0) break;
    lineStart = nextLineStart;
  }
  return headings;
}

function parseHeadingLine(rawLine: string): { episodeNo: number; kind: "chinese" | "english" } | null {
  const line = rawLine.trim();
  const chinese = /^第[ \t]*([零〇一二两三四五六七八九十百\d]+)[ \t]*[集话](?:$|[ \t:：\-—–.．].*)/u.exec(line);
  if (chinese) return { episodeNo: parseEpisodeNumber(chinese[1] ?? ""), kind: "chinese" };

  const english = ENGLISH_HEADING_PATTERN.exec(line);
  if (!english) return null;
  return { episodeNo: parseEpisodeNumber(english[1] ?? ""), kind: "english" };
}


/** Converts supported Arabic or Chinese episode labels into positive integers. */
function parseEpisodeNumber(value: string): number {
  if (/^\d+$/.test(value)) {
    const result = Number(value);
    if (result > 0) return result;
    throw new AppError(
      400,
      "invalid_episode_number",
      "拆分剧本没成：集数必须是正整数，请修改后再试。",
    );
  }

  const english = parseEnglishNumber(value);
  if (english > 0) return english;

  if (!/^[零〇一二两三四五六七八九十百]+$/u.test(value)) {
    throw new AppError(
      400,
      "invalid_episode_number",
      "拆分剧本没成：集数格式不正确，请使用“第1集”或“Episode 1”这类标题。",
    );
  }

  let total = 0;
  let current = 0;
  for (const character of value) {
    const digit = CHINESE_DIGITS[character];
    if (digit !== undefined) {
      current = digit;
    } else if (character === "十") {
      total += (current || 1) * 10;
      current = 0;
    } else if (character === "百") {
      total += (current || 1) * 100;
      current = 0;
    }
  }
  const result = total + current;
  if (result > 0) return result;
  throw new AppError(
    400,
    "invalid_episode_number",
    "拆分剧本没成：集数格式不正确，请使用“第1集”或“Episode 1”这类标题。",
  );
}

function parseEnglishNumber(value: string): number {
  const tokens = value.toLowerCase().replace(/-/gu, " ").split(/\s+/u).filter((token) => token && token !== "and");
  if (tokens.length === 0) return 0;
  let total = 0;
  let current = 0;
  for (const token of tokens) {
    if (ENGLISH_UNITS[token] !== undefined) {
      current += ENGLISH_UNITS[token]!;
    } else if (ENGLISH_TENS[token] !== undefined) {
      current += ENGLISH_TENS[token]!;
    } else if (token === "hundred") {
      current = (current || 1) * 100;
    } else {
      return 0;
    }
  }
  total += current;
  return total;
}

/** Rejects duplicated episode numbers before any episode body is sliced out. */
function assertUniqueEpisodeNumbers(headings: EpisodeHeading[]): void {
  const seen = new Set<number>();
  for (const heading of headings) {
    if (seen.has(heading.episodeNo)) {
      throw new AppError(
        400,
        "duplicate_episode_number",
        `拆分剧本没成：第${heading.episodeNo}集重复出现，请合并或改号后再试。`,
      );
    }
    seen.add(heading.episodeNo);
  }
}

/** Records a warning for every scene heading whose episode prefix doesn't match. */
function inspectScenes(scriptText: string, episodeNo: number, warnings: string[]): void {
  for (const scene of scriptText.matchAll(SCENE_HEADING_PATTERN)) {
    const sceneEpisodeNo = scene[1] ?? "";
    const sceneIndex = scene[2] ?? "";
    if (Number(sceneEpisodeNo) !== episodeNo) {
      warnings.push(`第${episodeNo}集里出现了场次编号不一致的场次标题：${sceneEpisodeNo}-${sceneIndex}`);
    }
  }
}
