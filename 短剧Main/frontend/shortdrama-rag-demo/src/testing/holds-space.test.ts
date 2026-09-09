/* ============================================================
   holds-space.test.ts — 判据自己的守卫

   holdsSpace 是别处「占位没塌」那些断言的唯一依据。判据松一格，上游所有断言
   一起变成摆设，而且是无声的：用例照样全绿，失败消息还写着「塌成零高等于没占」。
   所以这里把它当被测对象钉一遍——放松判据当场红在这个文件，不用等谁去改产品。

   这一版判据改成「解析有效高度」而不是「查字符串表」，守卫也跟着换了写法：
   不再只钉几个具体类名，而是按**解析规则**分组钉——零值的各种拼法、上限压制、
   跟着内容走的值、判不出的值。审计实测能绕过上一版白名单的三种拼法
   （`h-8 max-h-0` / `h-[0rem]` / `h-[0vh]`）单列一节，防止判据倒退回枚举。
   ============================================================ */
import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { holdsSpace, spaceVerdict } from "./holds-space";

const happyWindow = new Window({ url: "http://localhost/" });
const { document } = happyWindow;

/** 造一个待判元素：className/属性/文字按需给。 */
function element(className: string, options: { text?: string; style?: string; hidden?: boolean } = {}): Element {
  const node = document.createElement("span");
  if (className) node.setAttribute("class", className);
  if (options.style) node.setAttribute("style", options.style);
  if (options.hidden) node.setAttribute("hidden", "");
  if (options.text) node.textContent = options.text;
  return node as unknown as Element;
}

test("holdsSpace：正值高度类或可见文字才算占住", () => {
  assert.ok(holdsSpace(element("h-8")), "h-8 是实打实的 32px");
  assert.ok(holdsSpace(element("min-h-[120px]")), "min-h 有下限也撑得起");
  assert.ok(holdsSpace(element("absolute inset-x-0 bottom-0 h-8 bg-surface-2/60")), "混在一串类里也认得出");
  assert.ok(holdsSpace(element("aspect-[9/16] w-full")), "宽高比配着宽度能出高度");
  assert.ok(holdsSpace(element("px-2 py-1", { text: "权限信息没读到" })), "有可见文字就有行高");
  assert.ok(holdsSpace(element("h-px")), "1px 也是正值——判据只回答占不占地方，不回答够不够高");
  assert.ok(!holdsSpace(element("px-2")), "既无文字又不声明高度=零高空壳");
});

test("holdsSpace：size-* 同时设宽高，别把设了高度的当成没设", () => {
  /* 反方向的毛病：上一版只认 h-/min-h-/py-/aspect- 前缀，size-8 明明是 32×32 却判不过。
     判据假红一样是病——下一个人会去改产品迁就判据。 */
  assert.ok(holdsSpace(element("size-8")), "size-8 = w-8 h-8，高度是 32px");
  assert.ok(!holdsSpace(element("size-0", { text: "生成视频" })), "size-0 连宽带高一起清零");
});

test("holdsSpace：零高与不生成盒子的写法一律判不过——这三种正是最早那版判据放过去的", () => {
  /* 变异实测（16 定点变异那一轮）：这三种改法当时全前端一条都不红。 */
  assert.ok(!holdsSpace(element("h-0", { text: "生成视频" })), "h-0：文字溢出到版面外，这一格仍是零高");
  assert.ok(!holdsSpace(element("hidden h-8", { text: "生成视频" })), "hidden：display:none，盒子都不生成");
  assert.ok(!holdsSpace(element("h-8", { text: "生成视频", style: "display:none" })), "行内 display:none 同理");

  assert.ok(!holdsSpace(element("h-8", { text: "生成视频", hidden: true })), "hidden 属性等价于 display:none");
  assert.ok(!holdsSpace(element("sr-only", { text: "生成视频" })), "sr-only 被裁到 1px 且抽出常规流，版面上不存在");
});

test("holdsSpace：白名单式收紧被绕过的三种拼法——判据不许再退回枚举字符串", () => {
  /* 这三种是独立审计在上一版（枚举两张表）上实测「改了照样全绿」的。
     它们的共同点是：类名都不在表里，但解析出来的有效高度就是 0。 */
  assert.ok(
    !holdsSpace(element("h-8 max-h-0", { text: "生成视频" })),
    "twMerge 不消解 max-h 与 h（不同属性组，两个都留），border-box 下 max-height:0 把边框盒压回零",
  );
  assert.ok(!holdsSpace(element("h-8 h-[0rem]", { text: "生成视频" })), "twMerge 把 h-8 丢掉只留 h-[0rem]，渲染出零高按钮");
  assert.ok(!holdsSpace(element("h-8 h-[0vh]", { text: "生成视频" })), "换个单位是同一件事，判据不该按单位一个个补");

  /* 同一条规则派生出来的、表里当然也没有的一批：不用补表就该一起判不过。 */
  for (const className of ["h-[0em]", "h-[0%]", "h-[0.0rem]", "h-[0pt]", "h-[0ch]", "h-8 max-h-[0px]", "h-0/1"]) {
    assert.ok(!holdsSpace(element(className, { text: "生成视频" })), `${className} 解析出来的有效高度是 0`);
  }
});

test("holdsSpace：值跟着内容走的高度类不算声明高度", () => {
  for (const className of ["h-auto", "h-fit", "h-min", "h-max", "py-0", "min-h-0", "h-[0px]", "aspect-auto"]) {
    assert.ok(!holdsSpace(element(className)), `${className} 没有内容时就是零高，不该当成「已占位」`);
  }
  assert.ok(holdsSpace(element("h-auto", { text: "权限信息没读到" })), "跟着内容走 + 真有内容 = 撑得起一行");
});

test("holdsSpace：判不出的高度按不占算，且失败消息要说明白它是判不出而不是判零", () => {
  /* 宁可假红不许假绿：h-full 要看父元素、calc/var 算不出，都不许冒充「已占位」。
     假绿是无声的，假红有人来修——而修的路子写在失败消息里。 */
  for (const className of ["h-full", "h-1/2", "h-[50%]", "h-[calc(100%-2px)]", "h-(--slot-height)"]) {
    const verdict = spaceVerdict(element(className, { text: "生成视频" }));
    assert.equal(verdict.holds, false, `${className} 判不出真实高度，不许当成已占位`);
    assert.match(verdict.reason, /判不出/, `${className} 的失败消息要说清是判不出，不是判成了零高`);
    assert.match(verdict.reason, /parseLength/, "还要指出补哪儿——否则下一个人只会绕过判据");
  }
});

test("holdsSpace：看不见但仍占地方的写法要判过——判据只防跳版，不防看不见", () => {
  assert.ok(holdsSpace(element("h-8 invisible")), "visibility:hidden 仍占地方");
  assert.ok(holdsSpace(element("h-8 opacity-0")), "透明度 0 仍占地方");
  assert.ok(holdsSpace(element("h-8", { text: "生成视频" })), "aria-hidden 那类只影响读屏，不影响版面");
  assert.ok(holdsSpace(element("h-8 max-h-none")), "只有解析成 0 的上限才算压制，max-h-none 不是");
  assert.ok(holdsSpace(element("h-8 max-h-8")), "正值上限不把这一格压没");
});

test("holdsSpace：行内 style 写的零高也算数——绕开 class 一样不许假绿", () => {
  assert.ok(!holdsSpace(element("", { text: "生成视频", style: "height:0" })), "行内 height:0");
  assert.ok(!holdsSpace(element("h-8", { text: "生成视频", style: "max-height:0px" })), "行内 max-height:0 压回零");
  assert.ok(holdsSpace(element("", { text: "生成视频", style: "height:2rem" })), "行内正值高度照样算占住");
});
