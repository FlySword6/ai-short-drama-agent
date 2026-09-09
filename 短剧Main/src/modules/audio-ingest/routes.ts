import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/client.js";
import { requireCurrentUser } from "../../http/authenticate.js";
import { parseRequest, success } from "../../http/response.js";
import { BadRequestError, PayloadTooLargeError } from "../../shared/errors.js";
import { buildAudioAssetMetadata } from "./metadata.js";
import { AudioIngestService } from "./service.js";

const AUDIO_UPLOAD_MAX_FILE_BYTES = 100 * 1024 * 1024;

const audioTraitSchema = z.string().trim().min(1).max(64);
const audioTraitListSchema = z.array(audioTraitSchema).max(20).optional().default([]);
const optionalAudioTextSchema = z.string().trim().max(128).nullable().optional();

const tosAudioSchema = z.object({
  storage_bucket: z.string().trim().min(1).max(128).optional(),
  storage_path: z.string().trim().min(1).max(512),
  storage_url: z.string().url().max(1024).nullable().optional(),
  original_file_name: z.string().trim().min(1).max(255),
  content_type: z.string().trim().min(1).max(128),
}).strict();

const submitBaseSchema = z.object({
  source_project_name: z.string().trim().min(1).max(128).nullable().optional(),
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(2_000).nullable().optional(),
  audio: tosAudioSchema,
});

const submitSchema = z.discriminatedUnion("category", [
  submitBaseSchema.extend({
    category: z.literal("音色"),
    voice_traits: audioTraitListSchema,
    speaking_style: optionalAudioTextSchema,
  }).strict(),
  submitBaseSchema.extend({
    category: z.literal("背景音乐"),
    music_traits: audioTraitListSchema,
    tempo: optionalAudioTextSchema,
    usage_scene: optionalAudioTextSchema,
  }).strict(),
]);

const uploadFieldsBaseSchema = z.object({
  source_project_name: z.string().trim().min(1).max(128).nullable().optional(),
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(2_000).nullable().optional(),
});

const uploadFieldsSchema = z.discriminatedUnion("category", [
  uploadFieldsBaseSchema.extend({
    category: z.literal("音色"),
    voice_traits: z.string().trim().max(1_024).optional(),
    speaking_style: optionalAudioTextSchema,
  }).strict(),
  uploadFieldsBaseSchema.extend({
    category: z.literal("背景音乐"),
    music_traits: z.string().trim().max(1_024).optional(),
    tempo: optionalAudioTextSchema,
    usage_scene: optionalAudioTextSchema,
  }).strict(),
]);

export interface AudioIngestRouteDependencies {
  createService?: (db: Database) => Pick<AudioIngestService, "submit" | "submitUploadedFile">;
}

export async function registerAudioIngestRoutes(
  app: FastifyInstance,
  getDatabase: () => Database,
  dependencies: AudioIngestRouteDependencies = {},
): Promise<void> {
  const service = () => dependencies.createService?.(getDatabase()) ?? new AudioIngestService(getDatabase());

  app.post("/api/v1/asset-ingest/audio", async (request, reply) => {
    const actor = requireCurrentUser(request);
    const input = parseRequest(submitSchema, request.body);
    const result = await service().submit({
      actorId: actor.id,
      sourceProjectName: input.source_project_name,
      name: input.name,
      description: input.description,
      category: input.category,
      audioMetadata: metadataFromJson(input),
      audio: {
        storageBucket: input.audio.storage_bucket,
        storagePath: input.audio.storage_path,
        storageUrl: input.audio.storage_url,
        originalFileName: input.audio.original_file_name,
        contentType: input.audio.content_type,
      },
    });
    return reply.code(201).send(success({
      asset_id: result.assetId,
      media_id: result.mediaId,
      storage_bucket: result.storageBucket,
      storage_path: result.storagePath,
      storage_url: result.storageUrl,
    }));
  });

  app.post("/api/v1/asset-ingest/audio/upload", async (request, reply) => {
    const actor = requireCurrentUser(request);
    const upload = await readAudioUploadMultipart(request);
    const result = await service().submitUploadedFile({
      actorId: actor.id,
      sourceProjectName: upload.fields.source_project_name,
      name: upload.fields.name,
      description: upload.fields.description,
      category: upload.fields.category,
      audioMetadata: metadataFromUploadFields(upload.fields),
      file: upload.file,
    });
    return reply.code(201).send(success({
      asset_id: result.assetId,
      media_id: result.mediaId,
      storage_bucket: result.storageBucket,
      storage_path: result.storagePath,
      storage_url: result.storageUrl,
    }));
  });
}

interface AudioUploadMultipartBody {
  fields: z.infer<typeof uploadFieldsSchema>;
  file: {
    fileName: string;
    contentType: string;
    content: Buffer;
  };
}

async function readAudioUploadMultipart(request: FastifyRequest): Promise<AudioUploadMultipartBody> {
  const fields: Record<string, string> = {};
  let file: AudioUploadMultipartBody["file"] | undefined;
  try {
    for await (const part of request.parts({
      limits: {
        fileSize: AUDIO_UPLOAD_MAX_FILE_BYTES,
        files: 1,
        fields: 7,
        parts: 8,
      },
    })) {
      if (part.type === "field") {
        if (typeof part.value === "string" && part.value.trim()) fields[part.fieldname] = part.value.trim();
        continue;
      }
      if (file) throw new BadRequestError("一次只能上传一个音频文件");
      if (!part.filename) {
        await part.toBuffer().catch(() => undefined);
        continue;
      }
      file = {
        fileName: part.filename,
        contentType: part.mimetype,
        content: await part.toBuffer(),
      };
    }
  } catch (error) {
    if (isMultipartFileTooLarge(error)) throw new PayloadTooLargeError("上传音频不能超过 100MB");
    if (isMultipartCountLimitExceeded(error)) throw new PayloadTooLargeError("一次只能上传一个音频文件");
    throw error;
  }
  if (!file) throw new BadRequestError("缺少上传音频文件");
  return {
    fields: parseRequest(uploadFieldsSchema, fields),
    file,
  };
}

function metadataFromJson(input: z.infer<typeof submitSchema>) {
  if (input.category === "音色") {
    return buildAudioAssetMetadata({
      category: input.category,
      voiceTraits: input.voice_traits,
      speakingStyle: input.speaking_style,
    });
  }
  return buildAudioAssetMetadata({
    category: input.category,
    musicTraits: input.music_traits,
    tempo: input.tempo,
    usageScene: input.usage_scene,
  });
}

function metadataFromUploadFields(input: z.infer<typeof uploadFieldsSchema>) {
  if (input.category === "音色") {
    return buildAudioAssetMetadata({
      category: input.category,
      voiceTraits: splitMultipartList(input.voice_traits),
      speakingStyle: input.speaking_style,
    });
  }
  return buildAudioAssetMetadata({
    category: input.category,
    musicTraits: splitMultipartList(input.music_traits),
    tempo: input.tempo,
    usageScene: input.usage_scene,
  });
}

function splitMultipartList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,，、\n]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isMultipartFileTooLarge(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE";
}

function isMultipartCountLimitExceeded(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "FST_FILES_LIMIT" || code === "FST_PARTS_LIMIT";
}
