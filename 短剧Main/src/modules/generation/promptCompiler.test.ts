import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_PROMPT_BUDGET_CHARS,
  LOCKED_PROMPT_VERSION,
  NEGATIVE_PROMPT_V1,
  PROMPT_TEMPLATE_VERSION,
  SEGMENT_NO_BGM_CONSTRAINT,
  SEGMENT_PROMPT_DEFAULTS_VERSION,
  applySegmentPromptDefaults,
  compileAutoPrompt,
  joinPromptSegments,
  stripPromptTimecodes,
  validateProjectPromptTemplate,
  type PromptCompilationContext,
} from "./promptCompiler.js";

const fullContext: PromptCompilationContext = {
  episodeBackground: "《九千岁》第一季",
  sceneDescription: "深夜的御书房,烛火摇曳",
  shotIntent: "中景推近,皇帝独坐沉思",
  scriptText: "朕绝不退让。",
  references: [
    { lane: "character", name: "皇帝", description: "玄色龙袍,眉目冷峻" },
    { lane: "character", name: "老太监" },
    { lane: "prop", name: "玉玺" },
    { lane: "exotic_lane", name: "某物" },
  ],
};

test("提示词编译:全栏按版本化栏序渲染,台词包双引号,参考按栏分组", () => {
  const compiled = compileAutoPrompt(fullContext);
  assert.equal(compiled.version, PROMPT_TEMPLATE_VERSION);
  assert.equal(
    compiled.autoPrompt,
    `剧集背景:《九千岁》第一季。场景:深夜的御书房,烛火摇曳。镜头意图:中景推近,皇帝独坐沉思。台词:“朕绝不退让。”。角色:皇帝(玄色龙袍,眉目冷峻)、老太监。道具:玉玺。exotic_lane:某物。${NEGATIVE_PROMPT_V1}`,
  );
});

test("提示词编译:同一份结构化真源两次编译 byte 级一致", () => {
  assert.deepEqual(compileAutoPrompt(fullContext), compileAutoPrompt(fullContext));
});
test("提示词编译:锁定分镜跳过自动段并保留人工视频提示词", () => {
  assert.deepEqual(
    compileAutoPrompt({
      mediaKind: "video",
      shotIntent: "自动编译内容",
      manualPrompt: "用户手写的视频提示词",
      promptLocked: true,
    }),
    {
      version: LOCKED_PROMPT_VERSION,
      autoPrompt: "",
      lockedPrompt: "用户手写的视频提示词",
    },
  );
  assert.match(
    compileAutoPrompt({
      mediaKind: "video",
      shotIntent: "自动编译内容",
      manualPrompt: "用户手写的视频提示词",
      promptLocked: false,
    }).autoPrompt,
    /自动编译内容/u,
  );
  assert.match(
    compileAutoPrompt({
      mediaKind: "video",
      shotIntent: "自动编译内容",
      manualPrompt: "用户手写的视频提示词",
    }).autoPrompt,
    /自动编译内容/u,
  );
  assert.match(
    compileAutoPrompt({
      mediaKind: "video",
      shotIntent: "空锁仍应自动编译",
      manualPrompt: "  ",
      promptLocked: true,
    }).autoPrompt,
    /空锁仍应自动编译/u,
  );
  assert.match(
    compileAutoPrompt({
      mediaKind: "image",
      shotIntent: "图片自动编译内容",
      manualPrompt: "视频人工提示词",
      promptLocked: true,
    }).autoPrompt,
    /图片自动编译内容/u,
  );
});

test("提示词编译:默认模板把项目风格加入最终自动段", () => {
  const compiled = compileAutoPrompt({
    shotIntent: "人物回头",
    styleDescription: "港风黑帮、霓虹夜景、胶片颗粒",
  });
  assert.match(compiled.autoPrompt, /镜头意图:人物回头。风格:港风黑帮、霓虹夜景、胶片颗粒。/);
  assert.match(compiled.autoPrompt, new RegExp(NEGATIVE_PROMPT_V1));
});

test("提示词编译:自定义模板填充四个核心占位符", () => {
  const compiled = compileAutoPrompt({
    ...fullContext,
    styleDescription: "低饱和胶片",
    promptTemplate: [
      "内容:{{segment_content}}",
      "角色:{{characters}}",
      "场景:{{scene}}",
      "风格:{{style_description}}",
    ].join("\n"),
  });
  assert.equal(
    compiled.autoPrompt,
    [
      "内容:中景推近,皇帝独坐沉思。朕绝不退让。",
      "角色:角色:皇帝(玄色龙袍,眉目冷峻)、老太监",
      "场景:深夜的御书房,烛火摇曳",
      "风格:低饱和胶片",
      NEGATIVE_PROMPT_V1,
    ].join("\n"),
  );
});

test("提示词编译:未知模板占位符被拒绝", () => {
  assert.throws(
    () => validateProjectPromptTemplate("{{unknown_placeholder}}"),
    /未知提示词模板占位符/,
  );
  assert.throws(() => compileAutoPrompt({ promptTemplate: "{{unknown_placeholder}}" }));
});

test("提示词编译:模板未使用风格占位符时仍追加项目风格", () => {
  const compiled = compileAutoPrompt({
    shotIntent: "人物回头",
    styleDescription: "港风黑帮",
    promptTemplate: "内容:{{segment_content}}",
  });
  assert.equal(compiled.autoPrompt, `内容:人物回头\n风格:港风黑帮\n${NEGATIVE_PROMPT_V1}`);
});

test("提示词编译:模板中的空占位符整行省略，不留下孤立标签或空白行", () => {
  const compiled = compileAutoPrompt({
    shotIntent: "人物回头",
    promptTemplate: [
      "内容:{{segment_content}}",
      "角色:{{characters}}",
      "场景:{{scene}}",
    ].join("\n"),
  });
  assert.equal(compiled.autoPrompt, `内容:人物回头\n${NEGATIVE_PROMPT_V1}`);
});

test("提示词编译:模板路径确定且受 500 字预算限制", () => {
  const context: PromptCompilationContext = {
    promptTemplate: "{{segment_content}} {{characters}} {{scene}}",
    shotIntent: "意".repeat(600),
    sceneDescription: "场".repeat(100),
    references: [{ lane: "character", name: "角色", description: "描".repeat(100) }],
  };
  assert.deepEqual(compileAutoPrompt(context), compileAutoPrompt(context));
  assert.ok([...compileAutoPrompt(context).autoPrompt].length <= AUTO_PROMPT_BUDGET_CHARS);
});

test("提示词编译:无任何结构化真源时自动段为空,负面词表不单独成段", () => {
  assert.equal(compileAutoPrompt({}).autoPrompt, "");
  assert.equal(compileAutoPrompt({ references: [] }).autoPrompt, "");
  assert.equal(compileAutoPrompt({ references: [{ lane: "prop", name: "  " }] }).autoPrompt, "");
});

test("提示词编译:裁剪①参考登记描述截 30 字保资产名", () => {
  const compiled = compileAutoPrompt({
    shotIntent: "意".repeat(420),
    references: [{ lane: "character", name: "皇帝", description: "描".repeat(40) }],
  });
  assert.ok(![...compiled.autoPrompt].join("").includes("描".repeat(31)));
  assert.ok(compiled.autoPrompt.includes(`皇帝(${"描".repeat(30)})`));
  assert.ok([...compiled.autoPrompt].length <= AUTO_PROMPT_BUDGET_CHARS);
});

test("提示词编译:裁剪②删剧集背景", () => {
  const compiled = compileAutoPrompt({
    episodeBackground: "剧".repeat(100),
    shotIntent: "意".repeat(430),
  });
  assert.ok(!compiled.autoPrompt.includes("剧".repeat(100)));
  assert.ok(compiled.autoPrompt.includes("意".repeat(430)));
  assert.ok([...compiled.autoPrompt].length <= AUTO_PROMPT_BUDGET_CHARS);
});

test("提示词编译:裁剪③场景描述截 60 字", () => {
  const compiled = compileAutoPrompt({
    sceneDescription: "场".repeat(200),
    shotIntent: "意".repeat(380),
  });
  assert.ok(compiled.autoPrompt.includes(`场景:${"场".repeat(60)}`));
  assert.ok(!compiled.autoPrompt.includes("场".repeat(61)));
  assert.ok([...compiled.autoPrompt].length <= AUTO_PROMPT_BUDGET_CHARS);
});

test("提示词编译:裁剪④整体硬截 500 字,镜头意图与台词保到最后", () => {
  const compiled = compileAutoPrompt({ shotIntent: "意".repeat(600) });
  assert.equal([...compiled.autoPrompt].length, AUTO_PROMPT_BUDGET_CHARS);
});

test("提示词编译:台词栏无论是否生成音频都包双引号", () => {
  const compiled = compileAutoPrompt({ scriptText: "退下。" });
  assert.equal(compiled.autoPrompt, `台词:“退下。”。${NEGATIVE_PROMPT_V1}`);
});

test("两段式拼接:自动段+人工补充段换行相连,空段自动省略", () => {
  assert.equal(joinPromptSegments("自动段", "补充段"), "自动段\n补充段");
  assert.equal(joinPromptSegments("自动段"), "自动段");
  assert.equal(joinPromptSegments("自动段", "  "), "自动段");
  assert.equal(joinPromptSegments("", "补充段"), "补充段");
  assert.equal(joinPromptSegments("", ""), "");
});

test("R144:剥离括号、行首和镜号后的时间码，不误删自然语言时间", () => {
  assert.equal(
    stripPromptTimecodes([
      "镜头1 [00:00.000-00:03.500] 中景推近",
      "00:03.500 --> 00:05.000 台词结束",
      "镜头2 00:05-00:08 夜景",
      "人物约定晚上 20:30 集合",
    ].join("\n")),
    [
      "镜头1 中景推近",
      "台词结束",
      "镜头2 夜景",
      "人物约定晚上 20:30 集合",
    ].join("\n"),
  );
});

test("R144:段落生成默认只使用音效且不生成 BGM", () => {
  assert.deepEqual(applySegmentPromptDefaults("镜头1 [00:00-00:04] 人物转身"), {
    version: SEGMENT_PROMPT_DEFAULTS_VERSION,
    prompt: `${SEGMENT_NO_BGM_CONSTRAINT}\n镜头1 人物转身`,
    supplementPrompt: "镜头1 人物转身",
  });
});

test("R144:服务端自动段中的镜头意图和台词也不携带时间码", () => {
  const compiled = compileAutoPrompt({
    shotIntent: "镜头3 [00:08-00:12] 环绕人物",
    scriptText: "[00:09.500] 别回头。",
  });
  assert.doesNotMatch(compiled.autoPrompt, /\d{2}:\d{2}/);
  assert.match(compiled.autoPrompt, /镜头意图:镜头3 环绕人物/);
  assert.match(compiled.autoPrompt, /台词:“别回头。”/);
});
