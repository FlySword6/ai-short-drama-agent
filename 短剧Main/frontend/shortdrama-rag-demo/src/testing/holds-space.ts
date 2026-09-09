/* ============================================================
   holds-space.ts — 「读取中的占位真的占住这一格了吗」的唯一判据（测试专用）

   为什么要判据而不是量像素：测试环境没有排版引擎（happy-dom 不跑布局，Tailwind 的类
   也没有对应样式表），量不到真实高度。只能从元素自己声明了什么，反推它在真浏览器里
   占不占地方。

   为什么收成一份：这段判据原先在 capabilities-three-state 与 lite-shots-reference
   各抄了一遍，两份都只用 /(h-|min-h-|py-|aspect-)/ 判高度。于是 h-0、hidden 这类
   「写了等于没占」的写法一律判过——而零高恰恰是断言里写着要防的那一种。
   判据比它自己的失败消息弱，比没有判据更糟：它给人「已经测过了」的错觉。

   为什么不再列字符串表：上一版收紧是**白名单式**的，靠枚举两张表（哪些类名等于没占、
   哪些值跟着内容走）实现，表里没有的零高拼法照样放过。审计实测三种当场绕过去：
     · `h-8 max-h-0` —— twMerge 不消解（max-h 与 h 不同属性组，两个都留），
       border-box 下 max-height:0 把整个边框盒压回零；
     · `h-[0rem]` / `h-[0vh]` —— twMerge 把 h-8 丢掉只留这一个，渲染出零高的按钮。
   往表里补这三条只是把下一个绕法推迟一轮，而且会多出一份守卫在为这张表背书。

   所以这一版换了问法：不问「这个类名在不在我的表里」，改问
   **「这一格解析出来的有效高度是不是 0」**——
     ① 先用组件自己用的那套 twMerge（components/ui/cn）把冲突类消解成最终生效的那组；
     ② 再把高度类里的**数值解析出来**（h-0 / h-[0rem] / h-[0vh] / h-[0px] / size-0
        数值都是 0，h-8 / min-h-[120px] 是正值）；
     ③ 把 max-h 这类**会把高度压回零的属性**一并算进去。
   新拼法不用一个个往表里加：只要写得出数值，判据就读得懂。

   ---- 这份判据做不到的（别当它无所不能）----
   1. **带变体前缀的类一律不看**（`md:h-0`、`hover:h-8`、`[&_svg]:size-4`）：
      要么条件才生效、要么根本指向别的元素，没有布局引擎和媒体查询判不出。
      于是「只在某个断点塌成零高」这种写法，本判据抓不到。
   2. **要看父元素才知道的值**（`h-full`、`h-1/2`、`h-[50%]`）与**算不出的值**
      （`calc()`、`var()`、`h-(--x)`）一律记「判不出」，而**判不出按不占算**：
      宁可假红，不许假绿。真要用这类写法，把解析补进 parseLength，别绕过判据。
   3. 只回答「占不占地方」，不回答「够不够高」：`h-px` 也算占住，可它跟 32px 的真按钮
      之间照样跳。占位与真按钮等高得另外钉（PR #232 已备案 sm/md 差 4px 那条）。
   4. 只看这一个元素自己：父元素 `overflow-hidden h-0` 把它裁没了，这里看不出来。
   5. 同一组里 twMerge 消解不掉的并存声明（如 `size-0 h-8`，谁生效取决于 Tailwind
      生成样式表的顺序，不是 class 属性里的先后），一律**按最小的那个算**——
      判不清就当零高，这个方向才是收紧。
   ============================================================ */
import { cn } from "../components/ui/cn";

/** 一个长度值解析出来的四种结果。 */
type Length =
  /** 明确等于 0（含负值：浏览器把负高度当 0）。 */
  | { kind: "zero" }
  /** 明确大于 0。 */
  | { kind: "positive" }
  /** 跟着内容走（auto / fit / min / max）：有内容才有高度。 */
  | { kind: "content" }
  /** 判不出：要看父元素，或是算不出的表达式。判不出按不占算。 */
  | { kind: "unknown"; value: string };

const ZERO: Length = { kind: "zero" };
const POSITIVE: Length = { kind: "positive" };
const CONTENT: Length = { kind: "content" };

/** 不含数字、含义固定的值。 */
const KEYWORD_LENGTHS = new Map<string, Length>([
  ["px", POSITIVE],      /* 1px */
  ["screen", POSITIVE],  /* 100vh */
  ["dvh", POSITIVE], ["svh", POSITIVE], ["lvh", POSITIVE],
  ["auto", CONTENT], ["fit", CONTENT], ["min", CONTENT], ["max", CONTENT],
]);

/** 一段 CSS 长度（任意值方括号里的东西，或行内 style 上的值）。 */
function parseCssLength(raw: string): Length {
  const css = raw.trim().toLowerCase();
  if (css === "auto" || css === "fit-content" || css === "min-content" || css === "max-content") return CONTENT;
  const measured = /^(-?\d*\.?\d+)(%|[a-z]*)$/.exec(css);
  if (!measured) return { kind: "unknown", value: raw.trim() };
  if (!(Number(measured[1]) > 0)) return ZERO;                       /* 0 与负值都撑不起高度 */
  return measured[2] === "%" ? { kind: "unknown", value: raw.trim() } : POSITIVE;
}

/** 高度类跟在前缀后面的那一截：`8` / `[0rem]` / `auto` / `1/2` / `(--x)`。 */
function parseLength(raw: string): Length {
  const value = raw.trim();
  const keyword = KEYWORD_LENGTHS.get(value);
  if (keyword) return keyword;
  if (/^\d+\/\d+$/.test(value)) {                                    /* 分数 = 父元素百分比 */
    return value.startsWith("0/") ? ZERO : { kind: "unknown", value };
  }
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) > 0 ? POSITIVE : ZERO;  /* 间距刻度 */
  const arbitrary = /^\[(.+)\]$/.exec(value)?.[1];
  if (arbitrary !== undefined) return parseCssLength(arbitrary);
  return { kind: "unknown", value };                                 /* full、(--x)、没见过的 */
}

/** 宽高比：只有拿得出正比例，才谈得上「宽度撑出高度」。 */
function parseAspect(raw: string): Length {
  const value = raw.trim().replace(/^\[|\]$/g, "");
  if (value === "auto") return CONTENT;
  if (value === "square" || value === "video") return POSITIVE;
  const ratio = /^(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?$/.exec(value);
  if (!ratio) return { kind: "unknown", value };
  return Number(ratio[1]) > 0 && Number(ratio[2] ?? 1) > 0 ? POSITIVE : ZERO;
}

/** 变体前缀（`md:` `hover:` `[&_svg]:`）：方括号/圆括号之外的冒号。 */
function hasVariant(utility: string): boolean {
  let depth = 0;
  for (const char of utility) {
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === ":" && depth === 0) return true;
  }
  return false;
}

/** 高度相关的类前缀；`max-h`/`min-h` 排在 `h` 前面，`py|pt|pb` 排在 `p` 前面。 */
const HEIGHT_UTILITY = /^(max-h|min-h|h|size|aspect|py|pt|pb|p)-(.+)$/;

interface Declared {
  /** 直接决定高度的：h-* 与 size-*。 */
  height: Length[];
  /** 上限：解析成 0 就把这一格压回零高。 */
  maxHeight: Length[];
  /** 下限与纵向内边距：只提供「撑得起」的正面证据。 */
  floor: Length[];
  aspect: Length[];
}

function declaredLengths(element: Element): Declared {
  const found: Declared = { height: [], maxHeight: [], floor: [], aspect: [] };
  /* 用组件自己那套 twMerge 消解冲突类：谁最终生效由它说了算，判据不另立一套。 */
  const resolved = cn(element.getAttribute("class") ?? "");
  for (const utility of resolved.split(/\s+/).filter(Boolean)) {
    if (hasVariant(utility)) continue;
    const match = HEIGHT_UTILITY.exec(utility.replace(/^!/, "").replace(/!$/, ""));
    if (!match) continue;
    const prefix = match[1] as string;
    const rawValue = match[2] as string;
    if (prefix === "aspect") found.aspect.push(parseAspect(rawValue));
    else if (prefix === "max-h") found.maxHeight.push(parseLength(rawValue));
    else if (prefix === "h" || prefix === "size") found.height.push(parseLength(rawValue));
    else found.floor.push(parseLength(rawValue));                    /* min-h / p / py / pt / pb */
  }
  const style = element.getAttribute("style") ?? "";
  for (const [property, bucket] of [["height", found.height], ["max-height", found.maxHeight]] as const) {
    const declaration = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "i").exec(style)?.[1];
    if (declaration !== undefined) bucket.push(parseCssLength(declaration));
  }
  return found;
}

function noBox(element: Element): boolean {
  if (element.hasAttribute("hidden")) return true;
  if (/(?:^|;)\s*display\s*:\s*none/i.test(element.getAttribute("style") ?? "")) return true;
  const resolved = cn(element.getAttribute("class") ?? "").split(/\s+/);
  /* sr-only 不是 display:none，但它被裁到 1px 且抽出常规流——版面上一样不存在。 */
  return resolved.includes("hidden") || resolved.includes("sr-only");
}

/** 判据的结论 + 它凭什么这么判（贴进失败消息，省得下一个人猜）。 */
export interface SpaceVerdict {
  holds: boolean;
  reason: string;
}

export function spaceVerdict(element: Element): SpaceVerdict {
  if (noBox(element)) return { holds: false, reason: "这一格根本不生成盒子（hidden / display:none / sr-only）" };

  const declared = declaredLengths(element);
  if (declared.maxHeight.some((length) => length.kind === "zero")) {
    return { holds: false, reason: "高度上限解析出来是 0：max-height 把整个边框盒压回零，前面写多少 h- 都没用" };
  }
  if (declared.height.some((length) => length.kind === "zero")) {
    return { holds: false, reason: "高度解析出来是 0：文字会溢出到版面外，这一格本身仍是零高" };
  }
  if ([...declared.height, ...declared.floor, ...declared.aspect].some((length) => length.kind === "positive")) {
    return { holds: true, reason: "声明了正值高度" };
  }
  const undecidable = declared.height.find((length): length is { kind: "unknown"; value: string } => length.kind === "unknown");
  if (undecidable) {
    return {
      holds: false,
      reason: `高度写成「${undecidable.value}」，要看父元素或要算表达式，本判据判不出；判不出一律按不占算（真要用就把解析补进 holds-space.ts 的 parseLength，别绕过判据）`,
    };
  }
  if ((element.textContent ?? "").trim().length > 0) {
    return { holds: true, reason: "没声明高度，但自带可见文字，撑得起一行" };
  }
  return { holds: false, reason: "既无可见文字又没声明正值高度：零高空壳" };
}

/** 这一格在真浏览器里占不占地方。判不出一律算不占（宁可假红，不许假绿）。 */
export function holdsSpace(element: Element): boolean {
  return spaceVerdict(element).holds;
}
