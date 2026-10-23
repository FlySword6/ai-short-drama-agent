import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ProductionMediaError, TIMELINE_MANIFEST_SCHEMA_VERSION, parseMediaId,
  type ComposeTimelineRequest, type OwnedLocalVideo, type TimelineManifest,
} from './contracts';
import type { ProcessRunner } from './probe';
import type { ProductionMediaStore } from './store';

export interface TimelineComposerOptions {
  ffmpegExecutable?: string;
  maxClips?: number;
  maxTimelineDurationSeconds?: number;
  timeoutMs?: number;
  now?: () => Date;
}

export class TimelineComposer {
  private readonly ffmpegExecutable: string;
  private readonly maxClips: number;
  private readonly maxTimelineDurationSeconds: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly active = new Map<string, Promise<TimelineManifest>>();

  constructor(private readonly store: ProductionMediaStore, private readonly runner: ProcessRunner,
    options: TimelineComposerOptions = {}) {
    this.ffmpegExecutable = options.ffmpegExecutable ?? 'ffmpeg';
    this.maxClips = options.maxClips ?? 200;
    this.maxTimelineDurationSeconds = options.maxTimelineDurationSeconds ?? Math.min(15 * 60, store.limits.maxDurationSeconds);
    this.timeoutMs = options.timeoutMs ?? 15 * 60_000;
    this.now = options.now ?? (() => new Date());
  }

  async compose(value: ComposeTimelineRequest): Promise<TimelineManifest> {
    const request = this.parse(value);
    const inputDigest = createHash('sha256').update(JSON.stringify({ version: 1, videoIds: request.videoIds,
      title: request.title })).digest('hex');
    const id = `timeline_${inputDigest}`;
    const saved = await this.store.readManifest<TimelineManifest>(id);
    if (saved) return this.validateSaved(saved, id, inputDigest, request);
    const running = this.active.get(id);
    if (running) return running;
    const operation = this.composeOnce(id, inputDigest, request);
    this.active.set(id, operation);
    try { return await operation; }
    finally { this.active.delete(id); }
  }

  private async composeOnce(id: string, inputDigest: string, request: Required<ComposeTimelineRequest>): Promise<TimelineManifest> {
    const inputs: OwnedLocalVideo[] = [];
    for (const mediaId of request.videoIds) inputs.push(await this.store.getVideo(mediaId));
    const expectedDuration = inputs.reduce((sum, video) => sum + video.object.probe.durationSeconds, 0);
    if (!Number.isFinite(expectedDuration) || expectedDuration <= 0 || expectedDuration > this.maxTimelineDurationSeconds) {
      throw new ProductionMediaError(413, 'TIMELINE_DURATION_INVALID', '时间线总时长为空或超过本地合成限制。');
    }
    const withAudio = inputs.filter(input => input.object.probe.hasAudio).length;
    if (withAudio !== 0 && withAudio !== inputs.length) {
      throw new ProductionMediaError(409, 'TIMELINE_AUDIO_INCOMPATIBLE', '时间线不能混合有声和无声镜头；请先完成统一声音处理。');
    }
    const first = inputs[0]!;
    const width = even(first.object.probe.width);
    const height = even(first.object.probe.height);
    if (width > this.store.limits.maxWidth || height > this.store.limits.maxHeight
      || width * height > this.store.limits.maxPixels) {
      throw new ProductionMediaError(413, 'TIMELINE_RESOLUTION_INVALID', '时间线目标分辨率超过本地媒体限制。');
    }
    const work = await this.store.createWorkDirectory('compose');
    const outputPath = join(work, 'output.mp4');
    try {
      const args = this.ffmpegArgs(inputs, outputPath, width, height, withAudio === inputs.length);
      await this.runner.run(this.ffmpegExecutable, args, { cwd: work, timeoutMs: this.timeoutMs,
        maxOutputBytes: 4 * 1024 * 1024 });
      const output = await this.store.importOwnedVideo(outputPath, 'composition');
      const tolerance = Math.max(2, expectedDuration * 0.05);
      if (output.probe.width !== width || output.probe.height !== height
        || Math.abs(output.probe.durationSeconds - expectedDuration) > tolerance
        || output.probe.hasAudio !== (withAudio === inputs.length)) {
        throw new ProductionMediaError(422, 'TIMELINE_OUTPUT_MISMATCH', '合成结果的时长、分辨率或音轨与时间线不一致，未登记交付。');
      }
      const manifest: TimelineManifest = {
        schemaVersion: TIMELINE_MANIFEST_SCHEMA_VERSION, id, inputDigest, title: request.title,
        createdAt: this.timestamp(),
        inputs: inputs.map((input, index) => ({ order: index + 1, mediaId: input.object.id,
          sha256: input.object.sha256, durationSeconds: input.object.probe.durationSeconds,
          width: input.object.probe.width, height: input.object.probe.height,
          hasAudio: input.object.probe.hasAudio })),
        output,
        composition: { strategy: 'ffmpeg-concat-filter', videoCodec: 'libx264',
          audioCodec: withAudio === inputs.length ? 'aac' : null, width, height,
          expectedDurationSeconds: expectedDuration },
      };
      await this.store.writeManifest(id, manifest);
      return (await this.store.readManifest<TimelineManifest>(id)) ?? manifest;
    } finally {
      await unlink(outputPath).catch(() => undefined);
      // Only remove the service-created empty work directory. A surprising file
      // makes cleanup fail closed and leaves evidence for manual inspection.
      const { rmdir } = await import('node:fs/promises');
      await rmdir(work).catch(() => undefined);
    }
  }

  private ffmpegArgs(inputs: OwnedLocalVideo[], outputPath: string, width: number, height: number, audio: boolean): string[] {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n'];
    for (const input of inputs) args.push('-i', input.absolutePath);
    const filters: string[] = [];
    for (let index = 0; index < inputs.length; index++) {
      filters.push(`[${index}:v:0]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,`+
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${index}]`);
      if (audio) filters.push(`[${index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,`+
        `asetpts=PTS-STARTPTS[a${index}]`);
    }
    const inputsList = inputs.map((_, index) => audio ? `[v${index}][a${index}]` : `[v${index}]`).join('');
    filters.push(`${inputsList}concat=n=${inputs.length}:v=1:a=${audio ? 1 : 0}[vout]${audio ? '[aout]' : ''}`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]');
    if (audio) args.push('-map', '[aout]');
    args.push('-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn', '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
    if (audio) args.push('-c:a', 'aac');
    else args.push('-an');
    args.push('-movflags', '+faststart', '-f', 'mp4', outputPath);
    return args;
  }

  private parse(value: ComposeTimelineRequest): Required<ComposeTimelineRequest> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['videoIds', 'title'].includes(key)) || !Array.isArray(value.videoIds)) {
      throw new ProductionMediaError(400, 'TIMELINE_REQUEST_INVALID', '时间线合成请求格式无效。');
    }
    if (value.videoIds.length === 0) {
      throw new ProductionMediaError(409, 'LOCAL_VIDEO_REQUIRED', '没有已入库并通过校验的本地视频，不能合成或标记出片。');
    }
    if (value.videoIds.length > this.maxClips) {
      throw new ProductionMediaError(413, 'TIMELINE_CLIP_LIMIT', '镜头数量超过本地时间线限制。');
    }
    const videoIds = value.videoIds.map(parseMediaId);
    const title = value.title === undefined ? '' : cleanTitle(value.title);
    return { videoIds, title };
  }

  private async validateSaved(value: TimelineManifest, id: string, digest: string,
    request: Required<ComposeTimelineRequest>): Promise<TimelineManifest> {
    if (!value || value.schemaVersion !== TIMELINE_MANIFEST_SCHEMA_VERSION || value.id !== id
      || value.inputDigest !== digest || !Array.isArray(value.inputs) || !value.output
      || value.inputs.length !== request.videoIds.length || value.title !== request.title
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
      || new Date(value.createdAt).toISOString() !== value.createdAt
      || value.composition?.strategy !== 'ffmpeg-concat-filter') {
      throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '已保存的时间线清单与本次输入不一致。');
    }
    const inputs: OwnedLocalVideo[] = [];
    for (let index = 0; index < request.videoIds.length; index++) {
      const claimed = value.inputs[index];
      const expectedId = request.videoIds[index]!;
      if (!claimed || claimed.order !== index + 1 || claimed.mediaId !== expectedId) {
        throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '时间线输入顺序与本次请求不一致。');
      }
      const actual = await this.store.getVideo(expectedId);
      if (claimed.sha256 !== actual.object.sha256 || claimed.durationSeconds !== actual.object.probe.durationSeconds
        || claimed.width !== actual.object.probe.width || claimed.height !== actual.object.probe.height
        || claimed.hasAudio !== actual.object.probe.hasAudio) {
        throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '时间线清单引用的镜头与本地内容不一致。');
      }
      inputs.push(actual);
    }
    const expectedDuration = inputs.reduce((sum, input) => sum + input.object.probe.durationSeconds, 0);
    const withAudio = inputs.filter(input => input.object.probe.hasAudio).length;
    const width = even(inputs[0]!.object.probe.width);
    const height = even(inputs[0]!.object.probe.height);
    const expectedAudio = withAudio === inputs.length;
    if ((withAudio !== 0 && !expectedAudio) || value.composition.videoCodec !== 'libx264'
      || value.composition.audioCodec !== (expectedAudio ? 'aac' : null)
      || value.composition.width !== width || value.composition.height !== height
      || value.composition.expectedDurationSeconds !== expectedDuration) {
      throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '时间线合成参数与本地镜头不一致。');
    }
    const output = await this.store.getVideo(value.output.id);
    if (!sameLocalVideo(output.object, value.output)) {
      throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '时间线清单引用的本地成片与实际内容不一致。');
    }
    const tolerance = Math.max(2, expectedDuration * 0.05);
    if (output.object.probe.width !== width || output.object.probe.height !== height
      || output.object.probe.hasAudio !== expectedAudio
      || Math.abs(output.object.probe.durationSeconds - expectedDuration) > tolerance) {
      throw new ProductionMediaError(409, 'TIMELINE_MANIFEST_INVALID', '时间线成片与已保存的合成参数不一致。');
    }
    return structuredClone(value);
  }

  private timestamp(): string {
    const date = this.now();
    if (!Number.isFinite(date.valueOf())) throw new ProductionMediaError(500, 'MEDIA_CLOCK_INVALID', '本地媒体时间源无效。');
    return date.toISOString();
  }
}

function even(value: number): number { return value % 2 === 0 ? value : value + 1; }
function sameLocalVideo(left: TimelineManifest['output'], right: TimelineManifest['output']): boolean {
  return left.schemaVersion === right.schemaVersion && left.id === right.id && left.sha256 === right.sha256
    && left.bytes === right.bytes && left.mimeType === right.mimeType && left.relativePath === right.relativePath
    && left.sourceKind === right.sourceKind && left.createdAt === right.createdAt
    && left.probe.container === right.probe.container && left.probe.durationSeconds === right.probe.durationSeconds
    && left.probe.width === right.probe.width && left.probe.height === right.probe.height
    && left.probe.videoCodec === right.probe.videoCodec && left.probe.hasAudio === right.probe.hasAudio
    && left.probe.audioCodec === right.probe.audioCodec;
}
function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') throw new ProductionMediaError(400, 'TIMELINE_REQUEST_INVALID', '时间线标题无效。');
  const title = value.trim();
  if (Array.from(title).length > 160 || title.includes('\0') || /[\uD800-\uDFFF]/u.test(title)) {
    throw new ProductionMediaError(400, 'TIMELINE_REQUEST_INVALID', '时间线标题无效。');
  }
  return title;
}
