import sharp from "sharp";
import { settings } from "../config/env.js";
import { ArkChatClient } from "./arkClient.js";
import { ExternalServiceError } from "../shared/errors.js";
import { isRecord, parseJsonValue } from "../shared/json.js";

export interface VisionContext {
  fileName: string;
  sourceProjectName: string;
  assetKindHint?: string | null;
}

export class DoubaoVisionClient {
  constructor(
    private readonly chat = new ArkChatClient(settings.arkApiKey, settings.visionModel),
  ) {}

  async describeImage(
    content: Buffer,
    contentType: string | null,
    context: VisionContext,
    timing: Record<string, number>,
  ): Promise<Record<string, unknown>> {
    const imageStarted = performance.now();
    const prepared = await this.prepareImage(content, contentType);
    timing.vision_image_prepare = Math.round(performance.now() - imageStarted);

    const prompt = this.buildPrompt(context);

    const result = await this.chat.completeMessages([
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${prepared.mimeType};base64,${prepared.base64}` } },
        ],
      },
    ], {
      temperature: 0,
      timing,
      timingPrefix: "vision",
    });
    const parsed = parseJsonValue(result);
    if (!isRecord(parsed)) throw new ExternalServiceError("Doubao vision", "response is not a JSON object");
    return parsed;
  }

  private async prepareImage(content: Buffer, contentType: string | null): Promise<{ base64: string; mimeType: string }> {
    try {
      const buffer = await sharp(content)
        .resize({ width: 1536, height: 1536, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "white" })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      return { base64: buffer.toString("base64"), mimeType: "image/jpeg" };
    } catch {
      return { base64: content.toString("base64"), mimeType: contentType ?? "application/octet-stream" };
    }
  }

  private buildPrompt(context: VisionContext): string {
    return [
      "你是短剧多模态资产入库助手，负责把单张图片转换为 app.asset_entities 可入库的结构化 JSON。",
      "你只能根据图片可见内容、文件名、来源项目和类型提示推理；文件名只作辅助，不得编造图片中不存在的细节。",
      "必须只输出严格 JSON 对象，不输出 Markdown，不输出解释。",
      `文件名：${context.fileName}`,
      `来源项目：${context.sourceProjectName}`,
      context.assetKindHint ? `资产类型提示：${context.assetKindHint}` : "",

      "【数据库字段合同】",
      "输出字段必须包含：asset_kind, name, display_name, intro, appearance, age_value, gender, height_cm, hair_description, outfit_description, category, style_tags, person_type, asset_type, extraction_confidence, missing_fields。",
      "app.asset_entities 主表直接使用：asset_kind, name, display_name, intro, appearance, age_value, gender, height_cm, hair_description, outfit_description, category, style_tags。",
      "person_type 和 asset_type 是兼容旧项目的字段，后端会写入 metadata，不要把它们当成主表字段。",
      "extraction_confidence 必须是 0 到 1 的数字，表示你对图片结构化结果的置信度。",
      "missing_fields 必须是字符串数组，列出无法可靠判断的字段；如果没有缺失则输出空数组。",

      "【数据库长度与类型限制】",
      "asset_kind 不超过 20 字符；name、display_name 不超过 128 字符；gender 不超过 16 字符；category 不超过 64 字符；hair_description 不超过 512 字符。",
      "age_value 和 height_cm 必须是整数或 null，不要输出字符串。",
      "style_tags 建议 3-12 个短标签，不要输出长句或空字符串。",

      "【asset_kind 分类】",
      "asset_kind 只能是 character / animal / scene / prop / costume / lighting / camera / video / sound / music / voice / reference / keyword / model_3d / other。",
      "character=角色/人物/人设；animal=动物/宠物/兽类角色；scene=场景/地点/空间；prop=道具/武器/物件；costume=服装/造型/妆造；lighting=光线/光影参考；camera=摄影/运镜/镜头参考；video=视频/关键帧参考；sound=声音/音效；music=配乐；voice=配音/音色；reference=其他参考素材；keyword=关键词/标签资产；model_3d=3D 模型资产。",
      "兼容旧字段：不要输出 lighting_ref、cinematography_ref、video_ref、sound_ref、music_ref；分别输出 lighting、camera、video、sound、music；服装类输出 costume。",

      "【图片识别规则】",
      "优先根据图片主体判断资产类型，再结合文件名和类型提示修正。",
      "图片主体是人物、人设、角色形象时归为 character；主体是动物或兽类角色时归为 animal。",
      "主体是环境、建筑、房间、街道、自然空间、科幻空间时归为 scene。",
      "主体是武器、法宝、设备、物件、车辆等可被角色使用或引用的物体时归为 prop。",
      "主体强调服装、妆造、发型、配饰、定妆参考时归为 costume。",
      "主体强调光影、灯光、色调氛围时可归为 lighting；强调镜头、构图、运镜、机位参考时可归为 camera。",
      "如果文件名包含天尊版、心魔版、战损版、少年版、老年版、白衣版、黑衣版、古装版、现代版等角色形态，仍归为 character，并在 name 中保留完整形态名称。",

      "【字段抽取规则】",
      "name 用中文短名，优先描述图片主体；display_name 用完整展示名。",
      "intro 写一句素材用途或核心设定；appearance 写完整视觉外观、空间外观或画面特征。",
      "hair_description 只写头发/毛发；outfit_description 只写服装、配饰、妆造；非角色且无法判断时填 null。",
      "category 写业务分类，例如：人物角色、古风角色、科幻场景、室内场景、道具武器、光影参考、运镜参考。",
      "style_tags 提取题材、风格、年代、色彩、氛围、职业、身份、场景用途、镜头、光影等标签。",
      "character/animal 类型要尽量根据可见内容推断 age_value、gender、height_cm；完全无法判断才填 null。",

      "【person_type 规则】",
      "person_type 仅用于 character/animal，只能是：亚洲人种 / 欧美人种 / 外星生物 / 机器人 / 动物拟人 / 怪物异形 / 神魔灵体 / 其他。",
      "非角色或无法判断填 null。不要把画风、国别、职业、服装风格写入 person_type。",

      "【asset_type 规则】",
      "asset_type 表示资产归属：1=个人资产/私有资产，2=通用资产/公共资产；图片上传无明确归属时填 1。",

      "【输出示例】",
      JSON.stringify({
        asset_kind: "scene",
        name: "巨型太空环带场景",
        display_name: "巨型太空环带科幻场景参考图",
        intro: "用于短剧科幻宇宙场景的视觉参考。",
        appearance: "宏大的未来科幻空间场景，主体为巨型环形结构和宇宙环境，适合作为场景氛围参考。",
        age_value: null,
        gender: null,
        height_cm: null,
        hair_description: null,
        outfit_description: null,
        category: "科幻场景",
        style_tags: ["科幻", "宇宙", "宏大", "未来感", "场景参考"],
        person_type: null,
        asset_type: 1,
        extraction_confidence: 0.86,
        missing_fields: ["age_value", "gender", "height_cm", "hair_description", "outfit_description"],
      }),
    ].filter(Boolean).join("\n");
  }
}
