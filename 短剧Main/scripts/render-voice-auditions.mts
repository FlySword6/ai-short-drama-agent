#!/usr/bin/env tsx
/**
 * S44 音色试听批量预渲染(裁决 3 + 裁决 4)。
 *
 * 做什么:对音色词表(voice_vocabulary,迁移 033)里还没有 audition_url 的
 * 规范词,逐个调用豆包 openspeech TTS 渲染统一试听词
 * (src/modules/audio/audition.ts 的 VOICE_AUDITION_PHRASE),产物经现有
 * GenerationStorage 口径上传 TOS(voice-auditions/<voice_type>.mp3),
 * 再把静态 URL 写回词表行的 audition_url。
 *
 * 为什么 fail-closed:每个待渲染音色 = 一次付费 TTS 调用。N 个音色 = N 次
 * 付费调用。本脚本只能在拿到明确的批量预渲染授权后由人执行;S44 交付时
 * 从未以 --apply 运行过。
 *
 * 用法:
 *   tsx scripts/render-voice-auditions.mts --dry-run [--limit N]
 *     只列计划:待渲染音色清单与预计付费调用次数。不构造供应商客户端,
 *     不发任何供应商/存储请求,不写库。可以随时安全执行。
 *   tsx scripts/render-voice-auditions.mts --apply --confirm RENDER_VOICE_AUDITIONS --schema <POSTGRES_SCHEMA> [--limit N]
 *     真实渲染。三者缺一不可;--schema 必须与运行配置的 POSTGRES_SCHEMA
 *     逐字一致(防止写错库)。建议先 --limit 1 小量验证,再放量。
 */
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { settings } from "../src/config/env.js";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import { voiceVocabulary } from "../src/db/schema.js";
import { VOICE_AUDITION_PHRASE, voiceAuditionStoragePath } from "../src/modules/audio/audition.js";

const confirmation = "RENDER_VOICE_AUDITIONS";
/** 合同要求 1..120 的计费估算秒数(不进供应商请求体);试听词约 6 秒,取保守上界。 */
const auditionEstimatedSeconds = 10;

interface Input {
  dryRun: boolean;
  apply: boolean;
  confirm?: string;
  schema?: string;
  limit?: number;
  help: boolean;
}

interface PendingVoice {
  id: string;
  voiceType: string;
  displayName: string;
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2));
  if (input.help) return printHelp();
  if (input.dryRun === input.apply) {
    throw new Error("必须且只能二选一:--dry-run(只列计划)或 --apply(真实渲染,需 --confirm 与 --schema)");
  }

  const handle = createDatabase();
  try {
    const pending = await listPendingVoices(handle, input.limit);
    const stats = await catalogStats(handle);

    process.stdout.write(`试听词(全站统一,写死):「${VOICE_AUDITION_PHRASE}」\n`);
    process.stdout.write(
      `词表现状:规范词 ${stats.canonical} 条,已渲染 ${stats.rendered} 条,待渲染 ${stats.pending} 条\n`,
    );
    for (const [index, voice] of pending.entries()) {
      process.stdout.write(
        `  ${String(index + 1).padStart(4)}. ${voice.displayName} (${voice.voiceType}) -> ${voiceAuditionStoragePath(voice.voiceType)}\n`,
      );
    }
    process.stdout.write(`本次计划渲染 ${pending.length} 个音色 = 预计 ${pending.length} 次付费 TTS 调用\n`);

    if (input.dryRun) {
      process.stdout.write("dry-run:未构造供应商客户端,未发送任何供应商/存储请求,未写库\n");
      return;
    }

    await apply(input, handle, pending);
  } finally {
    await handle.pool.end();
  }
}

async function apply(input: Input, handle: DatabaseHandle, pending: PendingVoice[]): Promise<void> {
  if (input.confirm !== confirmation) {
    throw new Error(`拒绝执行:批量渲染是付费动作,需要 --confirm ${confirmation}`);
  }
  const declaredSchema = input.schema?.trim();
  if (!declaredSchema) throw new Error("拒绝执行:--apply 需要显式声明 --schema <POSTGRES_SCHEMA>");
  if (declaredSchema !== settings.postgresSchema) {
    throw new Error(`拒绝执行:--schema 声明为 ${declaredSchema},但 POSTGRES_SCHEMA 实为 ${settings.postgresSchema}`);
  }
  if (pending.length === 0) {
    process.stdout.write("没有待渲染音色,未发送任何请求\n");
    return;
  }

  // 供应商与存储依赖只在 --apply 分支才加载:dry-run 连这些模块都不 import。
  const [{ createGenerationProviderRegistry, requireAudioGenerationConfigured }, { TosStorage }] = await Promise.all([
    import("../src/modules/generation/factory.js"),
    import("../src/integrations/tosStorage.js"),
  ]);
  const model = requireAudioGenerationConfigured();
  const registry = createGenerationProviderRegistry();
  const tos = new TosStorage();

  const failures: Array<{ voice: PendingVoice; message: string }> = [];
  for (const [index, voice] of pending.entries()) {
    process.stdout.write(`[${index + 1}/${pending.length}] 渲染 ${voice.displayName} (${voice.voiceType}) …\n`);
    try {
      const submission = await registry.submit({
        mediaKind: "audio",
        model,
        prompt: VOICE_AUDITION_PHRASE,
        parameters: {
          originalDurationSeconds: auditionEstimatedSeconds,
          format: "mp3",
          speakerId: voice.voiceType,
        },
        references: [],
        quantity: 1,
      });
      if (submission.outcome !== "succeeded") {
        throw new Error(`供应商未同步返回音频(outcome=${submission.outcome})`);
      }
      const inline = submission.result.media[0]?.inlineContent;
      if (!inline?.contentBase64) throw new Error("供应商成功响应里没有音频数据");
      const stored = await tos.uploadBytes(
        Buffer.from(inline.contentBase64, "base64"),
        voiceAuditionStoragePath(voice.voiceType),
        inline.contentType || "audio/mpeg",
      );
      await handle.db.update(voiceVocabulary)
        .set({ auditionUrl: stored.storageUrl })
        .where(and(eq(voiceVocabulary.id, voice.id), isNotNull(voiceVocabulary.voiceType)));
      process.stdout.write(`    -> ${stored.storageUrl}\n`);
    } catch (error) {
      failures.push({ voice, message: error instanceof Error ? error.message : String(error) });
      process.stderr.write(`    失败:${failures[failures.length - 1]!.message}\n`);
    }
  }

  process.stdout.write(`完成:成功 ${pending.length - failures.length} / ${pending.length}\n`);
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`失败清单: ${failure.voice.voiceType} — ${failure.message}\n`);
    }
    throw new Error(`${failures.length} 个音色渲染失败(其余已写回 audition_url,重跑只会补未渲染的)`);
  }
}

/** 待渲染:active 规范词(voice_type 非空、自指)且 audition_url 为空,按词表 sort 顺序。 */
async function listPendingVoices(handle: DatabaseHandle, limit?: number): Promise<PendingVoice[]> {
  const rows = await handle.db.select({
    id: voiceVocabulary.id,
    voiceType: voiceVocabulary.voiceType,
    displayName: voiceVocabulary.displayName,
  }).from(voiceVocabulary)
    .where(and(
      eq(voiceVocabulary.active, true),
      eq(voiceVocabulary.id, voiceVocabulary.canonicalId),
      isNotNull(voiceVocabulary.voiceType),
      isNull(voiceVocabulary.auditionUrl),
    ))
    .orderBy(asc(voiceVocabulary.sort), asc(voiceVocabulary.id))
    .limit(limit ?? 1_000_000);
  return rows.map((row) => ({ ...row, voiceType: row.voiceType as string }));
}

async function catalogStats(handle: DatabaseHandle): Promise<{ canonical: number; rendered: number; pending: number }> {
  const rows = await handle.db.select({
    voiceType: voiceVocabulary.voiceType,
    auditionUrl: voiceVocabulary.auditionUrl,
  }).from(voiceVocabulary)
    .where(and(
      eq(voiceVocabulary.active, true),
      eq(voiceVocabulary.id, voiceVocabulary.canonicalId),
      isNotNull(voiceVocabulary.voiceType),
    ));
  const rendered = rows.filter((row) => row.auditionUrl).length;
  return { canonical: rows.length, rendered, pending: rows.length - rendered };
}

function parseArgs(args: string[]): Input {
  const input: Input = { dryRun: false, apply: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--help": case "-h": input.help = true; break;
      case "--dry-run": input.dryRun = true; break;
      case "--apply": input.apply = true; break;
      case "--confirm": input.confirm = args[++index]; break;
      case "--schema": input.schema = args[++index]; break;
      case "--limit": {
        const value = Number(args[++index]);
        if (!Number.isSafeInteger(value) || value < 1) throw new Error("--limit 需要正整数");
        input.limit = value;
        break;
      }
      default: throw new Error(`未知参数: ${arg}`);
    }
  }
  return input;
}

function printHelp(): void {
  process.stdout.write(`音色试听批量预渲染(付费动作,fail-closed)\n\n`);
  process.stdout.write(`  --dry-run [--limit N]                          只列计划,零供应商/存储请求\n`);
  process.stdout.write(`  --apply --confirm ${confirmation} --schema <schema> [--limit N]\n`);
  process.stdout.write(`                                                 真实渲染并写回 audition_url\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
