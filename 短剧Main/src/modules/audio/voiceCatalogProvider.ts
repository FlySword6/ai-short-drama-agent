import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { voiceVocabulary } from "../../db/schema.js";
import type { VoiceCatalogProvider, VoiceCatalogVoice } from "./types.js";

/**
 * S44: 音色词表(迁移 033)的 DB 读取层。词表是唯一事实来源——豆包 TTS 没有公开
 * 音色列表 API,这里绝不发起供应商请求。规范词是 voice_type 非空且自指的行;
 * 别名(voice_type 为空)在读取层一跳解析成规范词,与 031 同一口径,不做多级链。
 * 构造不碰数据库:getDatabase 只在真正读取时调用,路由注册保持零连接。
 */
export class DbVoiceCatalogProvider implements VoiceCatalogProvider {
  constructor(private readonly getDatabase: () => Database) {}

  async listVoices(): Promise<readonly VoiceCatalogVoice[]> {
    const rows = await this.getDatabase().select()
      .from(voiceVocabulary)
      .where(and(
        eq(voiceVocabulary.active, true),
        eq(voiceVocabulary.id, voiceVocabulary.canonicalId),
        isNotNull(voiceVocabulary.voiceType),
      ))
      .orderBy(asc(voiceVocabulary.sort), asc(voiceVocabulary.id));
    return rows.map((row) => toVoice(row));
  }

  /** 别名或规范词 → 供应商 voice_type;未登记、已停用或目标缺 voice_type 返回 undefined。 */
  async resolveVoiceType(idOrAlias: string): Promise<string | undefined> {
    const needle = idOrAlias.trim();
    if (!needle) return undefined;
    const db = this.getDatabase();
    const [row] = await db.select().from(voiceVocabulary)
      .where(eq(voiceVocabulary.id, needle)).limit(1);
    if (!row || !row.active) return undefined;
    if (row.voiceType) return row.voiceType;
    const [target] = await db.select().from(voiceVocabulary)
      .where(eq(voiceVocabulary.id, row.canonicalId)).limit(1);
    return target?.active ? target.voiceType ?? undefined : undefined;
  }
}

function toVoice(row: typeof voiceVocabulary.$inferSelect): VoiceCatalogVoice {
  if (!row.voiceType) throw new Error("canonical voice row without voice_type");
  return {
    id: row.voiceType,
    displayName: row.displayName,
    ...(row.language ? { language: row.language } : {}),
    ...(row.category ? { category: row.category } : {}),
    ...(row.gender ? { gender: row.gender } : {}),
    ...(row.auditionUrl ? { auditionUrl: row.auditionUrl } : {}),
  };
}
