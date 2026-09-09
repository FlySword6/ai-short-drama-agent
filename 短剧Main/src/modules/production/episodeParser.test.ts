import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../shared/errors.js";
import { parseEpisodes } from "./episodeParser.js";

// The first two cases are adapted from origin/dev's
// backend/test/episode-parser.service.spec.ts (field names updated to this
// module's output shape: scriptText -> content, preambleText -> preamble).

test("常规『第N集』标题按顺序拆分为多集，并提取集前导言", () => {
  const result = parseEpisodes(
    [
      "重生之都市仙帝归来",
      "人物介绍",
      "林凡：青玄仙帝重生。",
      "第1集",
      "1-1 虚空道台 日 内",
      "林凡渡劫。",
      "1-2 林家老宅 日 内",
      "林凡醒来。",
      "1-3 公园 日 外",
      "林凡修炼。",
      "第2集",
      "2-1 医院病房 日 内",
      "林凡探望母亲。",
      "第3集",
      "3-1 秦家别墅 日 内",
      "林凡治病。",
      "第4集",
      "4-1 苏家宴会厅 夜 内",
      "宴会冲突。",
    ].join("\n"),
  );

  assert.ok(result.preamble.includes("人物介绍"));
  assert.deepEqual(result.episodes.map((episode) => episode.episodeNo), [1, 2, 3, 4]);
  assert.equal(result.episodes[0]?.title, "第1集");
  assert.ok(result.episodes[0]?.content.startsWith("1-1 虚空道台 日 内\n"));
  assert.ok(result.episodes[0]?.content.includes("1-1 虚空道台 日 内"));
  assert.deepEqual(result.warnings, []);
});

test("支持中文数字集号，并对不匹配的场次编号只告警不阻断", () => {
  const result = parseEpisodes(
    "第一集\n2-1 错误场次 日 内\n剧情\n第十二集\n12-1 正确场次 夜 外\n剧情",
  );

  assert.deepEqual(result.episodes.map((episode) => episode.episodeNo), [1, 12]);
  assert.deepEqual(result.warnings, ["第1集里出现了场次编号不一致的场次标题：2-1"]);
});

test("『话』是『集』的等价变体", () => {
  const result = parseEpisodes(
    ["第3话", "3-1 片场 日 内", "第一句台词。", "第4话", "4-1 片场 夜 外", "第二句台词。"].join("\n"),
  );

  assert.deepEqual(result.episodes.map((episode) => episode.episodeNo), [3, 4]);
  assert.equal(result.episodes[0]?.title, "第3话");
  assert.equal(result.episodes[1]?.content, "4-1 片场 夜 外\n第二句台词。");
});

test("支持英文 Episode/Ep 标题和英文数字集号", () => {
  const result = parseEpisodes(
    [
      "Episode 1: Arrival",
      "INT. HOUSE - NIGHT",
      "Mia enters the room.",
      "Ep. Two - The Call",
      "EXT. STREET - DAY",
      "Mia answers the phone.",
    ].join("\n"),
  );

  assert.deepEqual(result.episodes.map((episode) => episode.episodeNo), [1, 2]);
  assert.equal(result.episodes[0]?.title, "EPISODE 1", "英文标题归一只留 EPISODE N，副标题丢弃");
  assert.ok(result.episodes[0]?.content.startsWith("INT. HOUSE - NIGHT\n"));
  assert.ok(result.episodes[0]?.content.includes("Mia enters the room."));
  assert.ok(result.episodes[1]?.content.includes("Mia answers the phone."));
});

test("英文集标题归一为 EPISODE N：大小写/Ep.变体与集号词都写成同一形式，副标题丢弃（R2-15）", () => {
  const result = parseEpisodes(
    ["episode one", "内容一", "EP. 2", "内容二", "Episode THREE: Night", "内容三"].join("\n"),
  );

  assert.deepEqual(result.episodes.map((episode) => episode.title), ["EPISODE 1", "EPISODE 2", "EPISODE 3"]);
});

test("支持中文集标题带副标题", () => {
  const result = parseEpisodes(
    ["第1集：重逢", "1-1 客厅 日 内", "林晚推门。", "第二集 - 夜访", "2-1 街角 夜 外", "林晚回头。"].join("\n"),
  );

  assert.deepEqual(result.episodes.map((episode) => episode.episodeNo), [1, 2]);
  assert.equal(result.episodes[0]?.title, "第1集：重逢");
  assert.ok(result.episodes[0]?.content.startsWith("1-1 客厅 日 内\n"));
  assert.ok(result.episodes[0]?.content.includes("林晚推门。"));
  assert.ok(result.episodes[1]?.content.includes("林晚回头。"));
});

test("完全没有集数标题时拒绝解析", () => {
  assert.throws(
    () => parseEpisodes("没有集标题的正文"),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 400
      && error.code === "unrecognized_episode_format"
      && error.message === "拆分剧本没成：没有找到集数标题，请使用“第1集”这类标题。",
  );
});

test("重复集号拒绝解析", () => {
  assert.throws(
    () => parseEpisodes("第1集\n剧情\n第1集\n重复剧情"),
    (error: unknown) => error instanceof AppError
      && error.code === "duplicate_episode_number"
      && error.message === "拆分剧本没成：第1集重复出现，请合并或改号后再试。",
  );
});

test("集标题之间没有正文内容时拒绝解析", () => {
  assert.throws(
    () => parseEpisodes("第1集\n第2集\n第二集剧情"),
    (error: unknown) => error instanceof AppError
      && error.code === "empty_episode_content"
      && error.message === "拆分剧本没成：第1集没有正文，请补充后再试。",
  );
});

test("中文数字解析结果为零时拒绝解析", () => {
  assert.throws(
    () => parseEpisodes("第零集\n剧情"),
    (error: unknown) => error instanceof AppError
      && error.code === "invalid_episode_number"
      && error.message === "拆分剧本没成：集数格式不正确，请使用“第1集”或“Episode 1”这类标题。",
  );
});

test("没有集前导言时 preamble 为空字符串", () => {
  const result = parseEpisodes("第1集\n开场剧情");
  assert.equal(result.preamble, "");
});
