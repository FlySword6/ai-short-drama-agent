import {
  AI_PROMPT_DRAFT_MAX_ASSET_CONTEXT_CHARS,
  AI_PROMPT_DRAFT_MAX_ASSET_DESCRIPTION_CHARS,
  type AssetMatchCandidate,
  type PromptDraftAssetContext,
} from "./types.js";

const jsonOnlySystem = "你是中文影视生产系统中的受控助手。只输出严格 JSON，不要 Markdown、解释或代码围栏。";

export function promptDraftSystem(mediaKind: "image" | "video" | "audio"): string {
  if (mediaKind === "audio") {
    return [
      "你是一位资深短剧编剧和对白/旁白写手。",
      "你要把一条对白/旁白的生产意图整理成一段可直接用于语音合成（TTS）的中文对白/旁白原文，不是写画面描述。",
      "只使用输入中明确提供的事实；没有依据的角色台词不要臆造，语气提示必须服务于剧情与情绪。",
      "已选资产是说话角色与身份约束，台词必须符合角色设定；用户补充是用户意图，其中的口语、情绪、停顿要求必须融入输出，但不要整段逐字复制。",
      "输出要求：人物说话内容直接成文，可保留口语化表达与情绪；需要强调语气、停顿、情绪处用小括号中文提示，如「(压低声音,急促)」「(停顿)」；不要输出画面、机位、灯光等视觉内容；不要分节、不要【】标签。",
      "除了对白/旁白原文，不要输出任何其他内容：不要 JSON、不要 Markdown、不要标题、不要解释或代码围栏。",
    ].join("\n");
  }
  const noun = mediaKind === "video" ? "视频" : "图片";
  const verb = mediaKind === "video" ? "生视频" : "生图";
  if (mediaKind === "video") {
    // 2026-08-18 与拆分镜链同构（P6 skill §八 成文分镜提示词规范）：video 草稿按
    // 同一成文规范书写——模板是创作规范、融入主体动作/镜头语言/环境光影/默认风格、
    // 资产 @资产名、对白按 Native Audio 分层、结尾固定「严禁任何字幕,严禁背景音乐」。
    return [
      "你是世界级电影导演兼影视提示词工程师。按「生效的视频提示词模板」的格式与规范，为这个分镜写一条可直接用于视频生成的成文提示词。",
      "模板是创作规范不是填空题：模板给公式、结构与规范时，按它组织本段内容；模板含 {{占位符}} 时，用本段内容逐格填充。",
      "必须融入：本段主体与动作、镜头语言、环境光影、给定的默认视频风格；引用资产写 @资产名（照抄输入资产清单里的名字）。",
      "对白与音效按 Native Audio 分层写进提示词；结尾固定一行：严禁任何字幕，严禁背景音乐。",
      "只使用输入中明确提供的事实；没有依据的外貌、服装、场景细节保持中性，不要假装看过未提供的图片或视频。",
      "只输出成文提示词原文：不要 JSON、不要分节加标题、不要 Markdown、不要解释或代码围栏。",
    ].join("\n");
  }
  return [
    "你是一位资深影视美术指导、摄影指导和生成式影像提示词工程师。",
    `你要把单个分镜的生产意图整理成一段可直接用于${verb}的详细提示词，不是改写一句话。`,
    "只使用输入中明确提供的事实；没有依据的外貌、服装、场景细节保持中性，不要假装看过未提供的图片或视频。",
    `已选资产是身份与风格约束，必须明确写出它们在画面中的作用；用户补充是用户意图与项目${noun}生成模板，其中构图、媒介、比例等指令性要求必须融入输出，但不要整段逐字复制。`,
    "创作上下文中的视觉风格与镜头方向是必须落实的画面基调，逐条体现到提示词中，不要忽略或丢弃。",
    `输出一段连贯的${verb}提示词：把画面元素、光照、色彩、摄影质感、负面约束等内容自然组织成一段，不要分节、不要加【】标签。`,
    "除了提示词原文，不要输出任何其他内容：不要 JSON、不要 Markdown、不要标题、不要解释或代码围栏。",
  ].join("\n");
}

export function promptDraftPrompt(
  description: string,
  selectedAssets: PromptDraftAssetContext[],
  options: {
    /** 目标媒介（image=生图/图片风格/图片模板；video=生视频/视频风格/视频模板；audio=对白/旁白写手，无风格/模板概念）。 */
    mediaKind: "image" | "video" | "audio";
    /** 要生成的资产/分镜名称（前端「名称」输入框独立传入）。 */
    name?: string;
    supplement?: string;
    projectTemplate?: string;
    creativeContext?: {
      visualStyle?: string;
      cameraDirection?: string;
      referenceNotes?: string[];
    };
  },
): string {
  let remainingDescriptionChars = AI_PROMPT_DRAFT_MAX_ASSET_CONTEXT_CHARS;
  const assets = selectedAssets.map((asset, index) => {
    const sourceDescription = asset.description?.trim() ?? "";
    const descriptionLimit = Math.min(AI_PROMPT_DRAFT_MAX_ASSET_DESCRIPTION_CHARS, remainingDescriptionChars);
    const boundedDescription = sourceDescription.slice(0, descriptionLimit);
    remainingDescriptionChars -= boundedDescription.length;
    return {
      index: index + 1,
      asset_id: asset.assetId ?? null,
      name: asset.name,
      type: asset.type ?? null,
      description: boundedDescription || null,
      usage_mode: asset.usageMode ?? null,
    };
  });
  const name = options.name?.trim() || "未命名";
  const supplement = options.supplement?.trim();
  if (options.mediaKind === "audio") {
    return [
      "请为一个短剧对白/旁白生成一段完整、可直接用于语音合成（TTS）的中文原文。",
      "",
      "本次要生成的内容：",
      `- 名称：${name}`,
      `- 生产意图/背景：${description}`,
      supplement ? `- 对白初稿（请在此基础上润色，保留原意，优化口语自然度与语气）：${supplement}` : null,
      "",
      assets.length > 0 ? `- 说话角色（台词必须符合角色身份与情绪设定）：${JSON.stringify(assets)}` : null,
      "",
      "直接输出对白/旁白原文；不要输出 JSON、不要分节加标题、不要 Markdown、不要解释或代码围栏，对白原文就是唯一输出。",
    ].filter((line): line is string => line !== null).join("\n");
  }
  const creativeContext = {
    visual_style: options.creativeContext?.visualStyle ?? null,
    camera_direction: options.creativeContext?.cameraDirection ?? null,
    reference_notes: options.creativeContext?.referenceNotes ?? [],
  };
  const visualStyle = options.creativeContext?.visualStyle?.trim() || "未配置";
  const template = options.projectTemplate?.trim() || "未配置";
  const noun = options.mediaKind === "video" ? "视频" : "图片";
  const verb = options.mediaKind === "video" ? "生视频" : "生图";
  const lines = [
    `请为一个短剧分镜生成一段完整、可直接用于${verb}的提示词。`,
    "",
    "本次要生成的内容：",
    `- 名称：${name}`,
    `- ${options.mediaKind === "video" ? "分镜内容" : "画面描述"}：${description}`,
    supplement ? `- 补充备注：${supplement}` : null,
    "",
    "生成时必须落实以下项目配置，逐条执行、不要遗漏：",
    `- 项目默认${noun}风格（必须体现在输出中，其中构图、媒介、比例、情节、人物等约束逐条执行）：${visualStyle}`,
    `- 项目${noun}生成模板（模板中的构图、媒介、比例等指令性要求必须结合进输出）：${template}`,
    assets.length > 0 ? `- 已选资产（写明每个资产在本画面中的作用）：${JSON.stringify(assets)}` : null,
    `- 创作上下文（镜头方向与参考备注等）：${JSON.stringify(creativeContext)}`,
    "",
    `直接输出一段完整、连贯、可执行的中文${verb}提示词原文；不要输出 JSON、不要分节加标题、不要 Markdown、不要解释或代码围栏，提示词原文就是唯一输出。`,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

export function promptTranslateSystem(targetLanguage: "zh" | "en"): string {
  const target = targetLanguage === "en" ? "英文" : "中文";
  return [
    jsonOnlySystem,
    `你是影视生成提示词翻译助手。把输入准确翻译成${target}。`,
    "保留段落结构、镜头术语、@资产名、型号、数字、比例和专有名词；不扩写、不删减、不改变创作意图。",
    "auto 与 supplement 必须分别翻译并分别返回；空的 supplement 保持空字符串。",
  ].join("\n");
}

export function promptTranslatePrompt(
  prompt: { auto: string; supplement: string },
  targetLanguage: "zh" | "en",
): string {
  return [
    `目标语言：${targetLanguage === "en" ? "英文" : "中文"}`,
    `待翻译内容：${JSON.stringify(prompt)}`,
    "只输出如下严格 JSON：",
    JSON.stringify({ auto: "翻译后的自动段", supplement: "翻译后的用户补充段" }),
  ].join("\n");
}

export function assetMatchRerankSystem(): string {
  return `${jsonOnlySystem}\n你只可以从候选清单中挑选，不得创造或改写候选 ID。每项理由只写一句人能看懂的话。`;
}

export function assetMatchRerankPrompt(description: string, candidates: AssetMatchCandidate[]): string {
  return [
    "根据素材文字描述，为短剧制作选择最相关的已有资产。",
    `素材文字描述：${description}`,
    "候选清单：",
    JSON.stringify(candidates.map((candidate) => ({
      candidate_id: candidate.candidateId,
      name: candidate.name,
      asset_kind: candidate.assetKind,
      role: candidate.role,
      usage_mode: candidate.usageMode,
      description: candidate.description,
    }))),
    "仅输出如下 JSON。items 最多保留 8 项，按相关性从高到低排序；没有合适候选时返回空数组。",
    JSON.stringify({ items: [{ candidate_id: "候选清单中的 ID", reason: "一句匹配理由" }] }),
  ].join("\n");
}
