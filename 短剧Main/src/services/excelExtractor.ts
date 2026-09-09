import { ArkChatClient } from "../integrations/arkClient.js";
import type { AssetEntityData, JsonObject } from "../domain/assets/types.js";
import type { ExcelAssetRow } from "./excelParser.js";
import { jsonObject, parseJsonValue } from "../shared/json.js";
import { booleanValue, numberValue, optionalText, textValue } from "../shared/values.js";
import { withAssetContractMetadata } from "./assetContract.js";

const allowedKinds = new Set([
  "character",
  "animal",
  "scene",
  "prop",
  "costume",
  "clothing",
  "lighting",
  "camera",
  "video",
  "sound",
  "music",
  "voice",
  "reference",
  "keyword",
  "model_3d",
  "other",
]);

const legacyKindMap = new Map<string, string>([
  ["lighting_ref", "lighting"],
  ["cinematography_ref", "camera"],
  ["video_ref", "video"],
  ["sound_ref", "sound"],
  ["music_ref", "music"],
  ["clothing", "costume"],
]);

export class ExcelAssetExtractor {
  constructor(private readonly llm = new ArkChatClient()) {}

  async extractMany(
    rows: ExcelAssetRow[],
    sourceProjectId: string | null,
    sourceProjectName: string,
    visibility: "personal" | "common" = "personal",
  ): Promise<AssetEntityData[]> {
    if (!rows.length) return [];
    const prompt = this.buildBatchPrompt(rows);
    const content = await this.llm.completeText(prompt);
    let parsed: unknown;
    try {
      parsed = parseJsonValue(content);
    } catch {
      const repaired = await this.llm.completeText(`请修复下面内容为严格 JSON 数组，不新增字段：\n${content}`);
      parsed = parseJsonValue(repaired);
    }

    const values = Array.isArray(parsed)
      ? parsed.filter(isObject)
      : isObject(parsed) && Array.isArray(parsed.assets)
        ? parsed.assets.filter(isObject)
        : [];
    const byKey = new Map(values.map((value) => [textValue(value.row_key), value]));
    const result: AssetEntityData[] = [];
    for (const row of rows) {
      const value = byKey.get(this.rowKey(row));
      result.push(value
        ? this.normalize(value, row, sourceProjectId, sourceProjectName, visibility)
        : await this.extractOne(row, sourceProjectId, sourceProjectName, visibility));
    }
    return result;
  }

  async extractOne(
    row: ExcelAssetRow,
    sourceProjectId: string | null,
    sourceProjectName: string,
    visibility: "personal" | "common" = "personal",
  ): Promise<AssetEntityData> {
    const content = await this.llm.completeText(this.buildSinglePrompt(row));
    let parsed: JsonObject;
    try {
      parsed = jsonObject(parseJsonValue(content));
    } catch {
      parsed = await this.llm.completeJson(`请修复下面内容为严格 JSON 对象：\n${content}`);
    }
    return this.normalize(parsed, row, sourceProjectId, sourceProjectName, visibility);
  }

  private normalize(
    value: Record<string, unknown>,
    row: ExcelAssetRow,
    sourceProjectId: string | null,
    sourceProjectName: string,
    visibility: "personal" | "common" = "personal",
  ): AssetEntityData {
    const kind = textValue(value.asset_kind);
    const mappedKind = legacyKindMap.get(kind) ?? kind;
    const assetKind = allowedKinds.has(mappedKind) ? mappedKind : "other";
    const name = optionalText(value.name) ?? this.fallbackName(row) ?? `${row.sheetName}-${row.rowNumber}`;
    const status = visibility === "common" ? "pending_review" : "approved";
    const legacyPersonType = optionalText(value.person_type);
    const legacyAssetType = numberValue(value.asset_type);
    const extractionConfidence = confidenceValue(value.extraction_confidence);
    const missingFields = stringArray(value.missing_fields);
    const metadata: JsonObject = {
      row_key: this.rowKey(row),
      source_sheet_name: row.sheetName,
      source_row_number: row.rowNumber,
      images: row.images.map((image) => ({
        file_name: image.fileName,
        sheet_name: image.sheetName ?? null,
        row: image.row ?? null,
        col: image.col ?? null,
        column_header: image.columnHeader ?? null,
        image_index: image.imageIndex ?? null,
      })),
      extractor: "llm_excel_asset_extractor",
      ...(legacyPersonType ? { legacy_person_type: legacyPersonType } : {}),
      ...(legacyAssetType !== null ? { legacy_asset_type: legacyAssetType } : {}),
      ...(extractionConfidence !== null ? { extraction_confidence: extractionConfidence } : {}),
      ...(missingFields.length ? { missing_fields: missingFields } : {}),
    };
    return withAssetContractMetadata({
      sourceProjectId,
      sourceProjectName,
      assetKind,
      name,
      displayName: optionalText(value.display_name) ?? name,
      intro: optionalText(value.intro),
      appearance: optionalText(value.appearance),
      ageValue: numberValue(value.age_value),
      gender: optionalText(value.gender),
      heightCm: numberValue(value.height_cm),
      hairDescription: optionalText(value.hair_description),
      outfitDescription: optionalText(value.outfit_description),
      category: optionalText(value.category),
      styleTags: Array.isArray(value.style_tags) ? value.style_tags.map(textValue).filter(Boolean) : [],
      approved: visibility === "common" ? booleanValue(value.approved) : true,
      reuseScope: "all_projects",
      status,
      sourceFileUrl: null,
      metadata,
    }, {
      sourceKind: "excel_workbook",
      sourceFileStub: row.sourceFileName,
      sourceSheetName: row.sheetName,
      sourceRowNo: row.rowNumber,
      sourceCellRef: `row:${row.rowNumber}`,
      confidenceScore: extractionConfidence ?? 0,
      reviewState: status,
      publicStorageState: "quarantined",
      extractionMethod: "llm_excel_asset_extractor",
    });
  }

  private buildBatchPrompt(rows: ExcelAssetRow[]): string {
    return this.buildStructuredPrompt(rows.map((row) => this.promptRow(row)), "array");
  }

  private buildSinglePrompt(row: ExcelAssetRow): string {
    return this.buildStructuredPrompt(this.promptRow(row), "object");
  }

  private buildStructuredPrompt(payload: unknown, mode: "array" | "object"): string {
    const isArrayMode = mode === "array";
    const outputType = isArrayMode ? "严格 JSON 数组" : "严格 JSON 对象";
    const outputInstruction = isArrayMode
      ? "必须逐行输出，与输入 rows 一一对应；每个元素必须保留对应 row_key。"
      : "必须输出一个对象，并保留输入 row_key。";
    const example = isArrayMode ? [promptExample()] : promptExample();
    return [
      "你是短剧多模态资产入库助手，负责把 Excel 资产数据转换为 app.asset_entities 可入库的结构化 JSON。",
      "你只能根据 fields、sheet_name、row_number、image_hints 推理；image_hints 只表示图片锚点，不代表你看到了图片内容。",
      `${outputInstruction} 只输出${outputType}，不输出 Markdown，不输出解释。`,

      "【数据库字段合同】",
      "输出字段必须包含：row_key, asset_kind, name, display_name, intro, appearance, age_value, gender, height_cm, hair_description, outfit_description, category, style_tags, person_type, asset_type, extraction_confidence, missing_fields。",
      "app.asset_entities 主表直接使用：asset_kind, name, display_name, intro, appearance, age_value, gender, height_cm, hair_description, outfit_description, category, style_tags。",
      "person_type 和 asset_type 是兼容旧项目的字段，后端会写入 metadata，不要把它们当成主表字段。",
      "extraction_confidence 必须是 0 到 1 的数字，表示你对该行结构化结果的置信度。",
      "missing_fields 必须是字符串数组，列出无法可靠判断的字段；如果没有缺失则输出空数组。",

      "【数据库长度与类型限制】",
      "asset_kind 不超过 20 字符；name、display_name 不超过 128 字符；gender 不超过 16 字符；category 不超过 64 字符；hair_description 不超过 512 字符。",
      "age_value 和 height_cm 必须是整数或 null，不要输出字符串。",
      "style_tags 建议 3-12 个短标签，不要输出长句或空字符串。",
      "intro、appearance、outfit_description 可以稍长，但要避免复制整段无关原文。",

      "【asset_kind 分类】",
      "asset_kind 只能是 character / animal / scene / prop / costume / lighting / camera / video / sound / music / voice / reference / keyword / model_3d / other。",
      "character=角色/人物/人设/主角/配角；animal=动物/宠物/兽类角色；scene=场景/地点/空间；prop=道具/武器/物件；costume=服装/造型/妆造；lighting=光线/光影参考；camera=摄影/运镜/镜头参考；video=视频/关键帧参考；sound=声音/音效；music=配乐；voice=配音/音色；reference=其他参考素材；keyword=关键词/标签资产；model_3d=3D 模型资产。",
      "兼容旧字段：如果原始数据写 lighting_ref 输出 lighting；cinematography_ref 输出 camera；video_ref 输出 video；sound_ref 输出 sound；music_ref 输出 music；clothing 输出 costume。",

      "【业务识别规则】",
      "优先根据 sheet_name 判断资产类型，再结合字段名和字段内容修正。",
      "sheet_name 或字段名包含 角色、人设、人物、主角、配角 时，优先归为 character。",
      "sheet_name 或字段名包含 场景、地点、空间、环境 时，优先归为 scene。",
      "sheet_name 或字段名包含 道具、武器、物件、法宝 时，优先归为 prop。",
      "sheet_name 或字段名包含 服装、造型、妆造、定妆 时，优先归为 costume。",
      "sheet_name 或字段名包含 光线、光影、灯光 时，优先归为 lighting。",
      "sheet_name 或字段名包含 运镜、摄影、镜头、机位 时，优先归为 camera。",
      "如果名称包含天尊版、心魔版、战损版、少年版、老年版、白衣版、黑衣版、古装版、现代版等角色形态，仍归为 character，并在 name 中保留完整形态名称，不要简化。",

      "【字段抽取规则】",
      "name 用中文短名；display_name 用完整展示名。",
      "intro 写一句素材用途或核心设定；appearance 写完整视觉外观、空间外观或素材画面特征。",
      "hair_description 只写头发/毛发；outfit_description 只写服装、配饰、妆造。",
      "category 写业务分类，例如：人物角色、古风角色、室内场景、地下休闲场景、道具武器、光影参考、运镜参考。",
      "style_tags 必须提取题材、风格、年代、色彩、氛围、职业、身份、场景用途、镜头、光影、声音用途等标签；不要输出空字符串。",
      "character/animal 类型要尽量推断 age_value、gender、height_cm；完全无法判断才填 null。",
      "不要因为字段分散就留空。原始字段中的描述、简介、性格、身份、外貌、服装、发型、场景氛围、用途、备注都要尽量合并到对应字段。",

      "【person_type 规则】",
      "person_type 仅用于 character/animal，只能是：亚洲人种 / 欧美人种 / 外星生物 / 机器人 / 动物拟人 / 怪物异形 / 神魔灵体 / 其他。",
      "非角色或无法判断填 null。不要把画风、国别、职业、服装风格写入 person_type。",

      "【asset_type 规则】",
      "asset_type 表示资产归属：1=个人资产/私有资产，2=通用资产/公共资产；原始字段无明确归属时填 1。",

      "【图片锚点规则】",
      "image_hints 只说明图片所在列、行、表头、图片序号。",
      "如果表头包含人设图、定稿、三视图、多视图、参考图、场景图、道具图，可体现在 intro、category 或 style_tags 中。",
      "不得描述图片里具体长什么样，除非 fields 文字里已经写明。",

      "【输出示例】",
      JSON.stringify(example),

      isArrayMode ? "【待处理 rows】" : "【待处理 row】",
      JSON.stringify(payload),
    ].join("\n");
  }

  private promptRow(row: ExcelAssetRow): Record<string, unknown> {
    return {
      row_key: this.rowKey(row),
      sheet_name: row.sheetName,
      row_number: row.rowNumber,
      fields: row.fields,
      image_hints: row.images.map((image) => ({
        column_header: image.columnHeader ?? "",
        row: image.row ?? null,
        col: image.col ?? null,
        file_name: image.fileName,
        image_index: image.imageIndex ?? null,
      })),
    };
  }

  private fallbackName(row: ExcelAssetRow): string | null {
    for (const key of ["姓名", "角色名", "人物名", "场景名", "资产名称", "名称", "name"]) {
      if (row.fields[key]?.trim()) return row.fields[key].replace(/\n/g, "").trim();
    }
    return null;
  }

  private rowKey(row: ExcelAssetRow): string {
    return `${row.sheetName}:${row.rowNumber}`;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function promptExample(): Record<string, unknown> {
  return {
    row_key: "角色表:2",
    asset_kind: "character",
    name: "叶萧遥天尊版",
    display_name: "叶萧遥天尊版角色人设",
    intro: "用于短剧主角天尊形态的人设参考。",
    appearance: "古风神魔气质角色，整体偏强者、仙侠、威严设定。",
    age_value: null,
    gender: "男",
    height_cm: null,
    hair_description: null,
    outfit_description: "古风天尊形态服饰，适合作为角色造型参考。",
    category: "人物角色",
    style_tags: ["古风", "仙侠", "神魔", "主角", "天尊形态"],
    person_type: "神魔灵体",
    asset_type: 1,
    extraction_confidence: 0.82,
    missing_fields: ["age_value", "height_cm", "hair_description"],
  };
}

function confidenceValue(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed === null ? null : Math.max(0, Math.min(1, parsed));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(textValue).filter(Boolean)
    : [];
}
