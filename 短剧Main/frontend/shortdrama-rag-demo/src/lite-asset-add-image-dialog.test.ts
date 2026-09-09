/* ============================================================
   lite-asset-add-image-dialog.test.ts — Phase 2 弹窗 B(给变体加图)纯逻辑测试

   口径锁定(第三版,按用户反馈重构):
   - 两个 tab:[📷 本地上传] [🤖 AI 生成]
   - 纯上传类型(light_ref/photo_ref/video_ref):只显示上传 tab
   - 上传调 api.uploadAssetMedia(isPrimary=false)
   - AI 生成:参考图(多图上传区,非槽位制) + 提示词(可 AI 优化) + 模型/比例选择器
     - 生成流程:上传参考图 → estimate → confirm → submit
   - mode = add_image(预填) / new_variant(空白)
   - 不展示已有版本列表(详情页底轨已有)

   不导入 .tsx(无 jsdom 会触发 React 组件评估挂起),
   常量与组装逻辑复制同口径,结构断言用源码扫描。
   ============================================================ */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./pages/lite/lite-asset-add-image-dialog.tsx", import.meta.url), "utf8");

// ---- 常量(复制自 lite-asset-add-image-dialog.tsx 同口径) ----

const UPLOAD_ONLY_KINDS: ReadonlySet<string> = new Set(["light_ref", "photo_ref", "video_ref"]);

/** 组装提示词 = [项目模板, 资产信息(名称+描述)] 过滤空值后 join 换行。 */
function assemblePrompt(opts: { template?: string; name?: string; intro?: string }): string {
  const assetInfo = [opts.name, opts.intro].filter(Boolean).join("，");
  return [opts.template, assetInfo].filter(Boolean).join("\n");
}

/** 判断 assetKind 是否纯上传(只显示上传 tab)。 */
function isUploadOnly(assetKind: string | null | undefined): boolean {
  return assetKind != null && UPLOAD_ONLY_KINDS.has(assetKind);
}

/** syncAssetInfo 补丁构建:只收集与原值不同的字段。 */
function buildInfoPatch(original: { name: string; intro: string | null; note: string | null }, current: { name: string; intro: string; note: string }): { name?: string; intro?: string | null; note?: string | null } {
  const patch: { name?: string; intro?: string | null; note?: string | null } = {};
  if (current.name.trim() !== original.name) patch.name = current.name.trim();
  if (current.intro.trim() !== (original.intro ?? "")) patch.intro = current.intro.trim() || null;
  const originalNote = typeof original.note === "string" ? original.note : "";
  if (current.note.trim() !== originalNote) patch.note = current.note.trim() || null;
  return patch;
}

/* ---------- 纯上传类型(T3.6) ---------- */

test("T3.6 isUploadOnly:light_ref/photo_ref/video_ref 为 true", () => {
  assert.equal(isUploadOnly("light_ref"), true);
  assert.equal(isUploadOnly("photo_ref"), true);
  assert.equal(isUploadOnly("video_ref"), true);
});

test("T3.6 isUploadOnly:character/scene/prop/costume 为 false", () => {
  assert.equal(isUploadOnly("character"), false);
  assert.equal(isUploadOnly("scene"), false);
  assert.equal(isUploadOnly("prop"), false);
  assert.equal(isUploadOnly("costume"), false);
});

test("T3.6 isUploadOnly:null/undefined 为 false", () => {
  assert.equal(isUploadOnly(null), false);
  assert.equal(isUploadOnly(undefined), false);
});

test("T3.6 源码:纯上传类型不显示 AI 生成 tab 条(isUploadOnly 条件)", () => {
  assert.ok(source.includes("isUploadOnly"), "应有 isUploadOnly 判断");
  assert.ok(source.includes("!isUploadOnly"), "AI tab 应在 !isUploadOnly 时显示");
});

/* ---------- 提示词组装 ---------- */

test("T3.3 assemblePrompt:项目模板 + 资产信息两段拼合", () => {
  const result = assemblePrompt({ template: "项目风格", name: "林雪", intro: "目击者" });
  assert.ok(result.includes("项目风格"));
  assert.ok(result.includes("林雪"));
  assert.ok(result.includes("目击者"));
});

test("T3.3 assemblePrompt:无项目模板时只用资产信息", () => {
  const result = assemblePrompt({ name: "仓库", intro: "" });
  assert.ok(!result.includes("undefined"));
  assert.ok(result.includes("仓库"));
  assert.ok(!result.includes("目击者"));
});

test("T3.3 assemblePrompt:全部为空时返回空串(不产生 undefined/null)", () => {
  assert.equal(assemblePrompt({}), "");
  assert.equal(assemblePrompt({ name: "", intro: "" }), "");
});

/* ---------- syncAssetInfo 补丁构建 ---------- */

test("T3.1 buildInfoPatch:无变更返回空对象", () => {
  const patch = buildInfoPatch(
    { name: "林雪", intro: "目击者", note: "备注" },
    { name: "林雪", intro: "目击者", note: "备注" },
  );
  assert.deepEqual(patch, {});
});

test("T3.1 buildInfoPatch:name 变更 → patch.name = trim 后", () => {
  const patch = buildInfoPatch(
    { name: "林雪", intro: null, note: null },
    { name: "  林雪儿  ", intro: "", note: "" },
  );
  assert.equal(patch.name, "林雪儿");
  assert.ok(!("intro" in patch), "intro 未变不进 patch");
});

test("T3.1 buildInfoPatch:intro 从 null 改为有值 → patch.intro = 值", () => {
  const patch = buildInfoPatch(
    { name: "x", intro: null, note: null },
    { name: "x", intro: "新描述", note: "" },
  );
  assert.equal(patch.intro, "新描述");
});

test("T3.1 buildInfoPatch:intro 改为空白 → patch.intro = null(清空)", () => {
  const patch = buildInfoPatch(
    { name: "x", intro: "旧描述", note: null },
    { name: "x", intro: "   ", note: "" },
  );
  assert.equal(patch.intro, null);
});

test("T3.1 buildInfoPatch:note 变更 → patch.note = trim 或 null", () => {
  const patch = buildInfoPatch(
    { name: "x", intro: null, note: "旧备注" },
    { name: "x", intro: "", note: "新备注" },
  );
  assert.equal(patch.note, "新备注");
});

test("T3.1 buildInfoPatch:note 清空 → patch.note = null", () => {
  const patch = buildInfoPatch(
    { name: "x", intro: null, note: "有备注" },
    { name: "x", intro: "", note: "  " },
  );
  assert.equal(patch.note, null);
});

/* ---------- 不展示已有版本列表(T3.5) ---------- */

test("T3.5 源码:弹窗 B 不含版本列表 / version-track 引用", () => {
  assert.ok(!source.includes("versionTrack"), "不应渲染版本图轨");
  assert.ok(!source.includes("version-track"), "不应引用版本图轨 API");
});

/* ---------- 上传路径(T3.2) ---------- */

test("T3.2 源码:上传调 uploadAssetMedia,无主图时自动设主图", () => {
  assert.ok(source.includes("uploadAssetMedia"), "应调 uploadAssetMedia");
  assert.ok(source.includes("willBePrimary"), "应根据 has_primary 决定是否设主图");
  assert.ok(source.includes("has_primary"), "应检查资产是否已有主图");
});

test("T3.2 源码:未选文件时提示「请先选择一张图片」", () => {
  assert.ok(source.includes("请先选择"), "未选文件应有提示");
});

/* ---------- AI 生成路径(T3.3) ---------- */

test("T3.3/v1.9 源码:生成走 estimate → submit(auto_confirm 并入,十.7),弹窗留驻轮询终态(十.3a)", () => {
  assert.ok(source.includes("quoteGeneration"), "第一步:estimate");
  assert.ok(source.includes("createGeneration(input as TieredGenerationSubmissionInput, quote.generation_quote_id, true)"), "第二步:submit 带 auto_confirm(十.7)");
  assert.ok(!source.includes("confirmGenerationQuote"), "v1.9 十.7:弹窗不再单独调 confirm");
  assert.ok(source.includes("genPhase"), "弹窗应持有生成阶段状态(留驻不关)");
  assert.ok(source.includes("api.generation(genTaskId)"), "提交后应轮询任务终态");
  assert.ok(source.includes("重试"), "失败应留弹窗给重试入口");
});

test("T3.3 源码:提交体含 target_asset_entity_id(目标是资产,不是分镜)", () => {
  assert.ok(source.includes("target_asset_entity_id"), "提交体应含 target_asset_entity_id");
  assert.ok(source.includes("supplement_prompt"), "应使用 supplement_prompt(不是 prompt)");
});

test("T3.3 源码:提示词为空时提示「提示词不能为空」", () => {
  assert.ok(source.includes("提示词不能为空"), "空提示词应有校验");
});

/* ---------- 参考图多图上传区(替代槽位制) ---------- */

test("T3.4 源码:参考图为多图上传区(非槽位制),含缩略图展示 + 删除", () => {
  assert.ok(source.includes("handleAddReferenceFiles"), "应有多文件上传函数");
  assert.ok(source.includes("handleRemoveReference"), "应有删除参考图函数");
  assert.ok(source.includes("referenceImages"), "应有参考图列表状态");
  assert.ok(source.includes("multiple"), "文件选择应支持 multiple(多选)");
  assert.ok(source.includes("previewUrl"), "应展示预览缩略图");
});

test("T3.4 源码:生成时上传参考图并收集 media_ids 做 reference_media_ids", () => {
  assert.ok(source.includes("reference_media_ids"), "生成提交体应含 reference_media_ids");
  assert.ok(source.includes("refIds"), "应收集上传后的 media id 列表");
});

test("T3.4 源码:不再使用槽位制(DEFAULT_REF_SLOTS 已移除)", () => {
  assert.ok(!source.includes("DEFAULT_REF_SLOTS"), "不应再有 DEFAULT_REF_SLOTS");
  assert.ok(!source.includes("handleAddSlot"), "不应再有 handleAddSlot");
  assert.ok(!source.includes("handleRemoveSlot"), "不应再有 handleRemoveSlot");
});

/* ---------- AI 提示词优化(T3.8) ---------- */

test("T3.8 源码:AI 优化提示词按钮调 draftPrompt(空提示词也可调用)", () => {
  assert.ok(source.includes("draftPrompt"), "应调 api.draftPrompt 优化提示词");
  assert.ok(source.includes("handleOptimizePrompt"), "应有 handleOptimizePrompt 函数");
  assert.ok(source.includes("optimizingPrompt"), "应有优化中 loading 状态");
  assert.ok(!source.includes("请先输入提示词再优化"), "不应有空提示词拦截(空时也能生成)");
});

test("T3.8b 源码:音频「AI 优化对白」调 draftPrompt mediaKind=audio(起草/润色语义对齐图片)", () => {
  assert.ok(source.includes("handleOptimizeDialogue"), "应有音频对白优化函数 handleOptimizeDialogue");
  assert.ok(source.includes("AI 优化对白"), "音频 tab 应显示「✨ AI 优化对白」按钮");
  assert.ok(
    /draftPrompt\(\{ mediaKind: "audio"/.test(source),
    "音频优化应走 draftPrompt mediaKind=audio(后端对白写手分支)",
  );
  assert.ok(
    source.includes("description: intro.trim() || name.trim(), supplement: prompt"),
    "生产意图=名称/描述,当前文本作为对白初稿(supplement)传入",
  );
  assert.ok(
    source.includes("setPrompt(optimized.autoPrompt);"),
    "音频无项目模板概念,结果应整体覆盖对白文本(setPrompt(autoPrompt) 仅音频处理函数使用)",
  );
  assert.ok(source.includes("对白已优化"), "优化成功应有提示");
  assert.ok(source.includes("AI 优化对白失败,可能 AI 网关未开启"), "失败应有音频专属错误提示");
});

/* ---------- 模型/比例选择器(T3.9) ---------- */

test("T3.9 源码:模型与比例分离为两个独立下拉(modelOptions + ratioOptions)", () => {
  assert.ok(source.includes("availableTiers"), "应有全部可用档位列表");
  assert.ok(source.includes("selectedTier"), "应有当前选中档位");
  assert.ok(source.includes("modelOptions"), "应有模型选项列表(从档位去重)");
  assert.ok(source.includes("ratioOptions"), "应有比例选项列表(按选中模型过滤)");
  assert.ok(source.includes("handleModelChange"), "应有切模型处理函数");
  assert.ok(source.includes("handleRatioChange"), "应有切比例处理函数");
  assert.ok(source.includes("tierModelLabel"), "应用 tierModelLabel 提取模型名");
  // 两个 select 分别绑定模型和比例
  const selectCount = (source.match(/<select/g) || []).length;
  assert.ok(selectCount >= 2, `应至少有两个 select(模型 + 比例),实际 ${selectCount}`);
  assert.ok(source.includes('label="模型"'), '应有一个 label="模型" 的 Field');
  assert.ok(source.includes('label="比例"'), '应有一个 label="比例" 的 Field');
});

test("T3.9 源码:档位接口不可达时回落 DEMO_IMAGE_TIERS(不空)", () => {
  assert.ok(source.includes("DEMO_IMAGE_TIERS"), "catch 块应回落 DEMO_IMAGE_TIERS");
});

test("T3.9 源码:回落档位在非演示模式下阻止提交(cannotGenerate)", () => {
  assert.ok(source.includes("tiersFromFallback"), "应有 tiersFromFallback 状态标记回落");
  assert.ok(source.includes("setTiersFromFallback(false)"), "成功加载真档位时应清除回落标记");
  assert.ok(source.includes("setTiersFromFallback(true)"), "catch 回落时应设回落标记");
  assert.ok(source.includes("cannotGenerate"), "应有 cannotGenerate 派生标记");
  assert.ok(source.includes("!demoMode && tiersFromFallback"), "cannotGenerate 应为 非演示 + 回落");
  assert.ok(source.includes("当前环境未配置图片生成模型"), "应有提示文案告诉用户原因");
});

/* ---------- 新建变体模式(T3.10) ---------- */

test("T3.10 源码:支持 mode = add_image / new_variant", () => {
  assert.ok(source.includes('"add_image" | "new_variant"'), "应有 mode 类型定义");
  assert.ok(source.includes("isNewVariant"), "应有 isNewVariant 判断");
  assert.ok(source.includes("shouldPrefill"), "应根据 mode 决定是否预填");
  assert.ok(source.includes("新建变体"), "new_variant 模式标题应为「新建变体」");
});

test("T3.10/v2.4 源码:new_variant 仅首变体(资产无任何变体)预填资产信息", () => {
  // v2.4 裁定(2026-08-18 走查):new_variant 只有创建第一个变体时预填资产名称/描述/备注;
  // 资产已有变体时表单空白(用户自填),add_image 恒预填。
  assert.ok(
    source.includes("!isNewVariant || noExistingVariant === true"),
    "add_image 恒预填;new_variant 仅 noExistingVariant(资产无变体)时预填",
  );
  assert.ok(source.includes("noExistingVariant"), "应有 noExistingVariant 属性(详情页按 variants.length === 0 传入)");
});

/* ---------- 新建变体:实际创建变体(T3.11) ---------- */

test("T3.11 源码:new_variant 模式调 createAssetVariant 创建变体", () => {
  assert.ok(source.includes("createAssetVariant"), "new_variant 模式应调 createAssetVariant");
  assert.ok(source.includes("variantId"), "应保存变体 id 用于后续操作");
});

test("T3.11 源码:new_variant 上传时把 assetVariantId 传给 uploadAssetMedia", () => {
  // 上传挂在解析后的目标变体上:new_variant 用新建变体 id,add_image 用传入的 variantId
  assert.ok(source.includes("assetVariantId: targetVariantId"), "上传时应传 assetVariantId");
});

test("T3.11 源码:new_variant 模式名称为空时阻止提交", () => {
  assert.ok(source.includes("请输入变体名称"), "名称为空时应有提示");
});

test("T3.11 源码:new_variant 分支用 createAssetVariant 替代 syncAssetInfo", () => {
  // handleUpload 和 handleGenerate 里 isNewVariant 时走 createAssetVariant,else 走 syncAssetInfo
  assert.ok(source.includes("if (isNewVariant)"), "new_variant 应有独立分支判断");
  assert.ok(source.includes("await api.createAssetVariant"), "new_variant 分支应调 createAssetVariant");
  // syncAssetInfo 只在 else(add_image)分支出现,不在 new_variant 分支
  assert.ok(source.match(/else\s*\{[\s\S]*?syncAssetInfo/), "syncAssetInfo 应在 else 分支(add_image 模式)");
});

test("T3.11/v2.4 源码:syncNewVariantNote 对比弹窗初始备注,非首变体不覆盖资产已有备注", () => {
  // 非首变体弹窗初始备注为空白:若按「note != 资产当前 note」判定会把资产已有备注写成 null;
  // 改为对比 initialNoteRef(弹窗初始值),仅用户改动时才回写。
  assert.ok(source.includes("initialNoteRef"), "应有 initialNoteRef 记录弹窗初始备注");
  assert.ok(source.includes("note.trim() !== initialNoteRef.current.trim()"), "仅用户改动时回写,避免清空资产已有备注");
});

/* ---------- 无个人/通用资产库(T3.7) ---------- */

test("T3.7 源码:不引用个人资产库 / 通用资产库", () => {
  assert.ok(!source.includes("personalAsset") && !source.includes("PersonalAsset"), "不应引用个人资产库");
  assert.ok(!source.includes("globalAsset") && !source.includes("GlobalAsset"), "不应引用通用资产库");
});

/* ---------- 契约 v1.3.1(问题二)无变体资产首图落第一个变体(T3.12) ---------- */

test("T3.12 源码:无变体资产首次上传自动创建第一个变体(契约 v1.3.1 六.3)", () => {
  assert.ok(source.includes("ensureFirstVariantId"), "应有 ensureFirstVariantId 辅助函数");
  assert.ok(source.includes("variantId ?? (await ensureFirstVariantId())"), "add_image 无选中变体时应先创建第一个变体");
  assert.ok(source.includes('variant_kind: "look"'), "第一个变体应使用 look 类型");
  assert.ok(source.includes("is_primary: true"), "第一个变体应设 is_primary=true(与后端 ensureFirstVariant 同口径)");
});

test("T3.12/v1.9 源码:生成路径按发起变体归属(十.9),无变体时先建第一个", () => {
  assert.ok(source.includes("targetVariantId = variantId ?? (await ensureFirstVariantId());"), "add_image 无选中变体时应先创建第一个变体");
  assert.ok(source.includes("target_asset_variant_id: targetVariantId"), "v1.9 十.9:提交体带发起变体,产物按变体归属");
});

/* ---------- 音频资产模式(2026-08-18,弹窗 B 音频生成) ---------- */

test("音频:asset_kind=audio 判定 isAudio 且媒体类型为 audio", () => {
  assert.ok(source.includes('const isAudio = asset?.asset_kind === "audio"'), "应有 isAudio 判定(资产类型=audio)");
  assert.ok(source.includes('const kind: GenerationMediaKind = isAudio ? "audio" : "image"'), "音频媒体类型应为 audio");
});

test("音频:显示本地上传 tab(2026-08-18 用户裁定:音频资产支持本地上传)", () => {
  assert.ok(source.includes("const hasUploadTab = true"), "音频与图片一样开放本地上传 tab");
  assert.ok(source.includes("hasUploadTab && ("), "上传 tab 渲染应以 hasUploadTab 为门");
  assert.ok(source.includes('const initialTab: TabSource = hasUploadTab ? (isUploadOnly ? "upload" : defaultSource) : "ai"'), "初始 tab 由 hasUploadTab + defaultSource 决定");
});

test("音频:提交体带 media_kind=audio、不含 speaker_id(音色栏已删)、reference_media_ids 空数组", () => {
  assert.ok(source.includes("media_kind: kind"), "提交体应带 media_kind(音频=audio)");
  assert.ok(!source.includes("speaker_id:"), "音频提交参数不应再带 speaker_id 属性(音色栏已删,由后端默认音色兜底)");
  assert.ok(!source.includes("selectedVoice"), "提交体不应引用已删的音色状态");
  assert.ok(source.includes("reference_media_ids: isAudio ? [] : refIds"), "音频全用途参考集合只收图片/视频,应传空数组");
  assert.ok(source.includes("if (!isAudio)"), "参考图上传循环应以 !isAudio 为门");
});

test("音频:本地上传按扩展名/类型白名单过滤(audio/* 或 mp3/wav/ogg/aac/flac)", () => {
  assert.ok(source.includes("AUDIO_UPLOAD_EXTENSIONS"), "应有音频扩展名白名单常量");
  assert.ok(source.includes('\\.(mp3|wav|ogg|aac|flac)$'), "白名单应含 mp3/wav/ogg/aac/flac");
  assert.ok(source.includes('f.type.startsWith("audio/")'), "音频上传应按 audio/ MIME 前缀过滤");
  assert.ok(source.includes('isAudio ? "audio/*" : "image/jpeg,image/png,image/webp"'), "文件选择 accept 应区分音频/图片");
});

test("音频:上传调 uploadAssetMedia 带 mediaKind=audio", () => {
  assert.ok(source.includes('mediaKind: isAudio ? "audio" : "image"'), "上传时应把 mediaKind(=audio) 传给 uploadAssetMedia");
  assert.ok(source.includes("media_kind"), "前端 api 层应把 media_kind 字段加入 FormData");
});

test("音频:上传区预览用 <audio> 控件而非 <img>", () => {
  assert.ok(source.includes("isAudio ? (\n                          <audio controls"), "音频上传卡片应渲染 <audio controls> 预览");
  assert.ok(source.includes("item.previewUrl"), "音频预览应复用上传文件的 object URL");
  assert.ok(source.includes('isAudio ? "支持 mp3 / wav / ogg / aac / flac,最大 20MB,可多选"'), "音频上传提示应写明白名单与 20MB 上限");
  assert.ok(source.includes("aria-label={isAudio ? \"移除音频\" : \"移除图片\"}"), "删除按钮文案应区分音频/图片");
});

test("音频:AI 模式加音质/格式/时长三级级联(全落真实原子档)", () => {
  assert.ok(source.includes("sampleRateOptions"), "应有音质(sample_rate)选项列表");
  assert.ok(source.includes("audioFormatOptions"), "应有格式(format)选项列表");
  assert.ok(source.includes("durationOptions"), "应有时长(duration_seconds)选项列表");
  assert.ok(source.includes("handleSampleRateChange"), "应有切音质处理函数");
  assert.ok(source.includes("handleAudioFormatChange"), "应有切格式处理函数");
  assert.ok(source.includes("handleDurationChange"), "应有切时长处理函数");
  assert.ok(source.includes("tierModelLabel(t) === selectedModel"), "级联应限制在选中模型内");
  assert.ok(source.includes('label="音质"'), '应有一个 label="音质" 的 Field');
  assert.ok(source.includes('label="格式"'), '应有一个 label="格式" 的 Field');
  assert.ok(source.includes('label="时长"'), '应有一个 label="时长" 的 Field');
  assert.ok(source.includes("selectedDurationSeconds"), "时长读值应做 duration_seconds/original_duration_seconds 回落");
  assert.ok(source.includes("{sr / 1000}kHz"), "音质选项应显示为 kHz");
  assert.ok(source.includes("{fmt.toUpperCase()}"), "格式选项应显示为大写");
});

test("音频:语速/音调/响度滑块为自由参数,非 0 才并入提交参数(不进档)", () => {
  assert.ok(source.includes("const [speechRate, setSpeechRate] = useState(0)"), "应有语速状态");
  assert.ok(source.includes("const [pitchRate, setPitchRate] = useState(0)"), "应有音调状态");
  assert.ok(source.includes("const [loudnessRate, setLoudnessRate] = useState(0)"), "应有响度状态");
  assert.ok(source.includes("type=\"range\""), "应有滑块控件");
  assert.ok(source.includes('label="语速"'), '应有一个 label="语速" 的 Field');
  assert.ok(source.includes('label="音调"'), '应有一个 label="音调" 的 Field');
  assert.ok(source.includes('label="响度"'), '应有一个 label="响度" 的 Field');
  assert.ok(source.includes("speech_rate: speechRate"), "提交参数应带 speech_rate(wire snake)");
  assert.ok(source.includes("loudness_rate: loudnessRate"), "提交参数应带 loudness_rate(wire snake)");
  assert.ok(source.includes("pitch_rate: pitchRate"), "提交参数应带 pitch_rate(wire snake)");
  assert.ok(source.includes("speechRate !== 0"), "语速为 0(中性)时不提交");
  assert.ok(source.includes("loudnessRate !== 0"), "响度为 0(中性)时不提交");
  assert.ok(source.includes("pitchRate !== 0"), "音调为 0(中性)时不提交");
  // 范围与 v01Contract 同口径:语速/响度 -50..100(两个滑块),音调 -12..12(一个滑块)
  assert.equal((source.match(/min=\{?-50/gi) || []).length, 2, "语速+响度两个滑块 min 应为 -50");
  assert.equal((source.match(/max=\{?100/gi) || []).length, 2, "语速+响度两个滑块 max 应为 100");
  assert.equal((source.match(/min=\{?-12/gi) || []).length, 1, "音调滑块 min 应为 -12");
  assert.equal((source.match(/max=\{?12/gi) || []).length, 1, "音调滑块 max 应为 12");
});

test("音频:音色栏已删——无未选音色校验,无音色也可直接提交", () => {
  assert.ok(!source.includes("isAudio && !selectedVoice"), "不应再有未选音色校验条件");
  assert.ok(!source.includes("请选择音色"), "不应再有请选择音色提示");
});

test("音频:提示词校验文案为「音频文本不能为空」", () => {
  assert.ok(source.includes('notify(isAudio ? "音频文本不能为空" : "提示词不能为空", "error")'), "空音频文本应有音频专属校验");
});

test("音频:档位加载走 listCapabilityTiers(audio),回落 FALLBACK_AUDIO_TIER", () => {
  assert.ok(source.includes("listCapabilityTiers(kind, demoMode)"), "档位加载应按 kind 参数化(audio 走音频档)");
  assert.ok(source.includes("FALLBACK_AUDIO_TIER"), "应有音频回落档");
  assert.ok(source.includes("FALLBACK_TIERS.audio"), "demo 档回落应含 audio 键");
  assert.ok(source.includes("isAudio ? (active[0] ?? FALLBACK_AUDIO_TIER) : FALLBACK_IMAGE_TIER"), "音频默认档不应落到图片档");
});

test("音频:音色选择器与试听已删(不引 voice-catalog,无预填/试听/错误态)", () => {
  assert.ok(!source.includes("fetchVoiceCatalog"), "不应再调音色目录接口");
  assert.ok(!source.includes("toggleVoicePreview"), "不应再有试听切换函数");
  assert.ok(!source.includes("playingVoiceId"), "不应再有试听中音色状态");
  assert.ok(!source.includes("voiceError"), "不应再有音色目录错误态");
  assert.ok(!source.includes("auditionUrl"), "不应再引用音色试听素材");
  assert.ok(!source.includes("textParam(strategyRef.current.parameters.speaker_id)"), "不应再按已存 speaker_id 预填音色");
});

test("音频:音频文本输入无模板预填概念,图片才预填提示词", () => {
  assert.ok(source.includes("if (shouldPrefill && !isAudio)"), "音频文本不应按图片模板/资产信息预填");
  assert.ok(source.includes("isAudio ? \"音频文本\" : \"提示词\""), "提示词 Field 标签音频应为「音频文本」");
});
