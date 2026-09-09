import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

/**
 * 护栏:活文档的禁用词。
 *
 * 起因(2026-07-28):DC 定了用词口径(`~/.claude/skills/fable-orchestration/SKILL.md`
 * 「真源」节末尾的「用词」小节)。人工清理做过两轮、两轮都扫干净过 —— 然后在第二轮
 * 还没收工的时候,另一条 session 的提交 b7a5407 又新写进来 9 个「落点」+ 1 个「落地」。
 *
 * **清理和写入是并发的,人只能追着补,补不干净。**口径不变成机器判据就守不住。
 * 这个文件把它变成判据:写进活文档就当场红,点名到文件和行号。
 *
 * 只读文件系统,不连数据库,CI 上能真跑,不会 skip。
 */

const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * 活文档 = 还在被人读、被人改、被当依据用的那些。
 *
 * 历史归档(`docs/research/`、`docs/goals/`、`docs/deploy/`、`docs/proposals/` 等)
 * 故意不纳入:它们记录的是**当时怎么说的**,回头改措辞反而失真。
 * 新增活文档目录时往这里加一行。
 */
const scanRoots = [
  "docs/design",
  "docs/planning",
  "docs/contracts",
  "docs/adr",
  // 本仓根 CONTEXT.md 已于 2026-08-10 归档到 docs/archive/(词汇合一,权威改为 context 仓那份)
];

/** 禁用词 → 该写什么。第二列会原样出现在报错里,让踩线的人不用去翻 skill 文件。 */
const bannedTerms: ReadonlyArray<readonly [string, string]> = [
  ["金路径", "写「全流程」;那份剧本就叫《一集戏的一天》"],
  ["北极星", "写「总目标」;文件是 docs/design/product-goal.md"],
  // 「断点」而非「断头」:2026-07-28 晚 O03 裁决把 Fable 自造的「断头」退役了。
  ["闭环", "写「走得通 / 走通」,断掉的地方叫「断点」;系统里的反馈循环叫「回路」"],
  ["落地", "写「做出来 / 做完 / 上线」"],
  ["链路", "写「流程」"],
  ["全链", "写「全流程」"],
  ["落点", "写「放在哪 / 谁做」"],
  ["死枝", "写「死代码」"],
  ["抓手", "办公室黑话;直接说要做的那件事"],
  ["赋能", "办公室黑话;直接说帮谁做成了什么"],
  ["颗粒度", "写「粗细 / 拆到多细」"],
  ["心智", "写「认知 / 用户怎么理解」"],
  ["打通", "写「接上 / 跑通」"],
  ["拉齐", "写「商量 / 定下来」"],
];

/**
 * 「对齐」不纳入门禁 —— 这是明知故犯,理由写在这里免得下次有人再试一遍。
 *
 * 口径是「只禁沟通义,技术义保留」。但活文档里 50 来处「对齐」几乎全是技术义,
 * 而且前缀花样太多,举不完:`_key` 对齐、ALTER 对齐、与 #22 对齐、按集对齐、
 * 逐卡对齐、三元组对齐、验收公式对齐、行为对齐、写法对齐、口径对齐、右对齐、
 * 形态对齐、音画对齐、缩略图时间戳对齐、与交付单位对齐、平台任务超时对齐……
 * 白名单再长也会漏,而漏了就是**误报**。
 *
 * 更要命的是:沟通义的「授权对齐」和技术义的「口径对齐」在字面上长得一模一样,
 * 光靠正则分不开。门禁一旦开始误报,大家就会条件反射地加豁免标记,
 * 那这道门就废了 —— **宁可漏判,不可误报。**
 *
 * 「对齐」继续靠人看(和 skill 里那条判据:正常中文技术人开会会不会这么说)。
 */

/**
 * 豁免标记。四类合法命中靠它放行,不写死行号 —— 行号会漂。
 *   ① 说明用词规则本身的句子(「闭环→走通/断点」)
 *   ② DC 原话引用(原话不改写,这是收件箱的纪律)
 *   ③ 记录「库里现在存的是旧词」这类事实的行
 *   ④ 引用外部术语的原名(ChatCut 四层模型的「审美闭环」)——
 *      2026-07-28 晚 O03 裁决:引用外部术语保留原名,否则读者对不上原文
 *
 * 写法:在同一行任意位置加 `<!-- lint:allow-term -->`,建议带上理由,
 * 例如 `<!-- lint:allow-term 规则说明本身 -->`。
 * 已知限制:命中如果落在代码围栏里,标记只能加在 ``` 那行,会显示成代码。
 * 现在一处都没有,真遇到了再补块级写法。
 */
const allowMarker = /<!--\s*lint:allow-term\b[\s\S]*?-->/;

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly terms: readonly string[];
  readonly text: string;
}

interface ScanResult {
  readonly hits: readonly Hit[];
  /** 标了豁免却没有禁用词的行 —— 说明那行已经改干净了,标记该删。 */
  readonly staleMarkers: readonly string[];
  readonly fileCount: number;
}

async function collectDocs(): Promise<string[]> {
  const files: string[] = [];
  for (const root of scanRoots) {
    const abs = path.join(repoRoot, root);
    if (abs.endsWith(".md")) {
      files.push(abs);
      continue;
    }
    const entries = await readdir(abs, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(path.join(entry.parentPath, entry.name));
      }
    }
  }
  return files.sort();
}

async function scanDocs(): Promise<ScanResult> {
  const files = await collectDocs();
  const hits: Hit[] = [];
  const staleMarkers: string[] = [];

  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((text, index) => {
      // 「落地页」是产品名词(landing page),不是黑话「落地」;先摘掉合法复合词再匹配。
      const scannable = text.replaceAll("落地页", "");
      const terms = bannedTerms.map(([term]) => term).filter((term) => scannable.includes(term));
      const exempt = allowMarker.test(text);
      if (terms.length > 0 && !exempt) {
        hits.push({ file: rel, line: index + 1, terms, text });
      }
      if (terms.length === 0 && exempt) {
        staleMarkers.push(`${rel}:${index + 1}`);
      }
    });
  }
  return { hits, staleMarkers, fileCount: files.length };
}

/** 报错里只放定位信息和一小段原文,整行可能几百字,贴全了没人看。 */
function format(hit: Hit): string {
  const at = hit.text.indexOf(hit.terms[0]!);
  const excerpt = hit.text.slice(Math.max(0, at - 20), at + 40).trim();
  return `${hit.file}:${hit.line}  【${hit.terms.join("、")}】  …${excerpt}…`;
}

test("活文档里不能出现 DC 禁掉的词", async () => {
  const { hits, fileCount } = await scanDocs();
  assert.ok(fileCount > 0, `扫描目录一个 md 都没找到,门禁是空转的:${scanRoots.join(", ")}`);

  const suggestions = new Map(bannedTerms);
  const offendingTerms = [...new Set(hits.flatMap((hit) => hit.terms))];
  assert.deepEqual(
    hits.map(format),
    [],
    `活文档里发现 DC 禁掉的词(共 ${hits.length} 行):\n${hits.map(format).join("\n")}\n\n` +
      `改法:\n${offendingTerms.map((term) => `  ${term} → ${suggestions.get(term)}`).join("\n")}\n\n` +
      "口径出处:~/.claude/skills/fable-orchestration/SKILL.md「真源」节末尾的「用词」小节。\n" +
      "确属规则说明 / DC 原话引用 / 旧词事实记录这三类,在该行加 `<!-- lint:allow-term 理由 -->` 放行。",
  );
});

test("豁免标记不能空挂在没有禁用词的行上", async () => {
  const { staleMarkers } = await scanDocs();
  assert.deepEqual(
    staleMarkers,
    [],
    `这些行标了 lint:allow-term,但行里已经没有禁用词了:${staleMarkers.join(", ")}。\n` +
      "留着会变成默认静音开关,下次真写进禁用词也不报。删掉标记。",
  );
});
