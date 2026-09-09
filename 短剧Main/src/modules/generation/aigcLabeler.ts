import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

export const AIGC_CONTENT_PRODUCER = "001191110000802044347C00000";
export const TC260_XMP_NAMESPACE = "http://www.tc260.org.cn/ns/AIGC/1.0/";

export type AigcLabelMediaKind = "image" | "video" | "audio";

export interface AigcImplicitLabel {
  Label: "1";
  ContentProducer: typeof AIGC_CONTENT_PRODUCER;
  ProduceID: string;
  ReservedCode1: "";
  ContentPropagator: typeof AIGC_CONTENT_PRODUCER;
  PropagateID: string;
  ReservedCode2: "";
}

export interface AigcLabelInput {
  content: Buffer;
  mediaKind: AigcLabelMediaKind;
  /** An attempt-scoped, reversible content identifier supplied by the caller. */
  produceId: string;
  extension?: string;
  contentType?: string;
  exiftoolPath?: string;
  exiftoolConfigPath?: string;
}

export interface AigcLabelResult {
  content: Buffer;
  label: AigcImplicitLabel;
  complianceMetadata: {
    aigcMetadataEnabled: true;
    aigcMetadataEvidence: "platform_applied";
    providerOriginEvidence?: ProviderOriginEvidence;
  };
}

export interface ProviderOriginEvidence {
  observationMethod: "exiftool_c2pa_jumbf";
  c2paPresentBefore: true;
  c2paPresentAfter: true;
  manifestFingerprint: string;
  signatureVerification: "not_performed";
  softwareAgentName?: string;
  modelName?: string;
}

export interface AigcMetadataLabelerInput {
  content: Buffer;
  contentType: string;
  extension: string;
  mediaKind: AigcLabelMediaKind;
  contentId: string;
}

export interface AigcMetadataLabelerResult {
  content: Buffer;
  complianceMetadata: {
    aigcMetadataEnabled: true;
    aigcMetadataEvidence: "platform_applied";
    contentId: string;
    contentProducer: typeof AIGC_CONTENT_PRODUCER;
    schemaVersion: "GB45438-2025-Appendix-E";
    providerOriginEvidence?: ProviderOriginEvidence;
  };
}

export class AigcLabelingError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AigcLabelingError";
    this.code = code;
  }
}

const ID3_HEADER_LENGTH = 10;
const ID3_FRAME_HEADER_LENGTH = 10;
const XMP_OWNER = "XMP";

function fail(code: string, message: string, cause?: unknown): never {
  throw new AigcLabelingError(code, message, cause === undefined ? undefined : { cause });
}

function syncSafeToNumber(buffer: Buffer, offset: number): number {
  const bytes = buffer.subarray(offset, offset + 4);
  if (bytes.length !== 4 || bytes.some((byte) => (byte & 0x80) !== 0)) {
    return fail("AIGC_METADATA_ID3_INVALID", "Invalid ID3 sync-safe size.");
  }
  return (bytes[0]! << 21) | (bytes[1]! << 14) | (bytes[2]! << 7) | bytes[3]!;
}

function numberToSyncSafe(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0x0fffffff) {
    return fail("AIGC_METADATA_ID3_INVALID", "ID3 tag is too large.");
  }
  return Buffer.from([(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f]);
}

function isFrameId(value: string): boolean {
  return /^[A-Z0-9]{4}$/.test(value);
}

interface Id3Frame {
  id: string;
  raw: Buffer;
  payload: Buffer;
}

interface ParsedId3 {
  version: 3 | 4;
  audio: Buffer;
  frames: Id3Frame[];
}

function parseId3(content: Buffer): ParsedId3 {
  if (content.length < ID3_HEADER_LENGTH || !content.subarray(0, 3).equals(Buffer.from("ID3"))) {
    // Adobe XMP Part 3's MP3 example creates a v2.3 tag when none exists.
    // Existing v2.4 tags are retained as v2.4 below.
    return { version: 3, audio: content, frames: [] };
  }

  const version = content[3];
  const revision = content[4];
  const flags = content[5];
  if ((version !== 3 && version !== 4) || revision !== 0 || flags === undefined) {
    return fail("AIGC_METADATA_ID3_UNSUPPORTED", "Only ID3v2.3 and ID3v2.4 tags are supported.");
  }
  // Unsynchronisation, extended headers, experimental tags and footers all require
  // transformations that could corrupt unrelated frames. Refuse instead of guessing.
  const unsupportedFlags = version === 3 ? 0xe0 : 0xf0;
  if ((flags & unsupportedFlags) !== 0) {
    return fail("AIGC_METADATA_ID3_UNSUPPORTED", "ID3 tag uses unsupported transformations.");
  }

  const tagSize = syncSafeToNumber(content, 6);
  const tagEnd = ID3_HEADER_LENGTH + tagSize;
  if (tagEnd > content.length) {
    return fail("AIGC_METADATA_ID3_INVALID", "ID3 tag extends beyond the MP3 bytes.");
  }

  const frames: Id3Frame[] = [];
  let offset = ID3_HEADER_LENGTH;
  while (offset + ID3_FRAME_HEADER_LENGTH <= tagEnd) {
    const header = content.subarray(offset, offset + ID3_FRAME_HEADER_LENGTH);
    if (header.every((byte) => byte === 0)) break;
    const id = header.subarray(0, 4).toString("latin1");
    if (!isFrameId(id)) return fail("AIGC_METADATA_ID3_INVALID", "ID3 frame identifier is invalid.");
    const size = version === 3 ? header.readUInt32BE(4) : syncSafeToNumber(header, 4);
    const frameEnd = offset + ID3_FRAME_HEADER_LENGTH + size;
    if (frameEnd > tagEnd) return fail("AIGC_METADATA_ID3_INVALID", "ID3 frame extends beyond its tag.");
    const frameFlags = header.subarray(8, 10);
    if (frameFlags[0] !== 0 || frameFlags[1] !== 0) {
      return fail("AIGC_METADATA_ID3_UNSUPPORTED", "ID3 frame uses unsupported flags.");
    }
    frames.push({ id, raw: content.subarray(offset, frameEnd), payload: content.subarray(offset + ID3_FRAME_HEADER_LENGTH, frameEnd) });
    offset = frameEnd;
  }
  return { version, frames, audio: content.subarray(tagEnd) };
}

function assertMpegAudioFrame(audio: Buffer): void {
  if (audio.length < 4) return fail("AIGC_METADATA_MP3_INVALID", "MP3 has no MPEG audio frame.");
  const first = audio[0]!;
  const second = audio[1]!;
  const third = audio[2]!;
  const sync = first === 0xff && (second & 0xe0) === 0xe0;
  const version = (second >> 3) & 0x03;
  const layer = (second >> 1) & 0x03;
  const bitrate = (third >> 4) & 0x0f;
  const sampleRate = (third >> 2) & 0x03;
  if (!sync || version === 1 || layer === 0 || bitrate === 0 || bitrate === 0x0f || sampleRate === 0x03) {
    return fail("AIGC_METADATA_MP3_INVALID", "MP3 has no valid MPEG audio frame header.");
  }
}

function findUtf16Terminator(payload: Buffer, start: number): number {
  for (let offset = start; offset + 1 < payload.length; offset += 2) {
    if (payload[offset] === 0 && payload[offset + 1] === 0) return offset;
  }
  return -1;
}

function decodeUtf16(payload: Buffer, encoding: 1 | 2): string | undefined {
  if (payload.length < 2) return undefined;
  const littleEndian = encoding === 1
    ? payload[0] === 0xff && payload[1] === 0xfe
    : false;
  const bigEndian = encoding === 2 || (encoding === 1 && payload[0] === 0xfe && payload[1] === 0xff);
  if (!littleEndian && !bigEndian) return undefined;
  const bytes = encoding === 1 ? payload.subarray(2) : payload;
  if (!bigEndian) return bytes.toString("utf16le");
  const swapped = Buffer.alloc(bytes.length - (bytes.length % 2));
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    swapped[index] = bytes[index + 1]!;
    swapped[index + 1] = bytes[index]!;
  }
  return swapped.toString("utf16le");
}

function decodeUtf16Value(payload: Buffer, littleEndian: boolean): string {
  if (littleEndian) return payload.toString("utf16le");
  const swapped = Buffer.alloc(payload.length - (payload.length % 2));
  for (let index = 0; index + 1 < payload.length; index += 2) {
    swapped[index] = payload[index + 1]!;
    swapped[index + 1] = payload[index]!;
  }
  return swapped.toString("utf16le");
}

function decodeTxxx(payload: Buffer): { description: string; value: string } | undefined {
  if (payload.length < 2) return undefined;
  const encoding = payload[0];
  if (encoding === 0 || encoding === 3) {
    const terminator = payload.indexOf(0, 1);
    if (terminator < 0) return undefined;
    return {
      description: payload.subarray(1, terminator).toString(encoding === 0 ? "latin1" : "utf8"),
      value: payload.subarray(terminator + 1).toString(encoding === 0 ? "latin1" : "utf8"),
    };
  }
  if (encoding !== 1 && encoding !== 2) return undefined;
  const terminator = findUtf16Terminator(payload, 1);
  if (terminator < 0) return undefined;
  const descriptionPayload = payload.subarray(1, terminator);
  const description = decodeUtf16(descriptionPayload, encoding);
  if (description === undefined) return undefined;
  const littleEndian = encoding === 1 && descriptionPayload[0] === 0xff && descriptionPayload[1] === 0xfe;
  return { description, value: decodeUtf16Value(payload.subarray(terminator + 2), littleEndian) };
}

function decodeTxxxDescription(payload: Buffer): string | undefined {
  return decodeTxxx(payload)?.description;
}

function decodePrivOwner(payload: Buffer): string | undefined {
  const terminator = payload.indexOf(0);
  return terminator < 0 ? undefined : payload.subarray(0, terminator).toString("latin1");
}

function frame(version: 3 | 4, id: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(ID3_FRAME_HEADER_LENGTH);
  header.write(id, 0, "latin1");
  if (version === 3) header.writeUInt32BE(payload.length, 4);
  else numberToSyncSafe(payload.length).copy(header, 4);
  return Buffer.concat([header, payload]);
}

function txxxPayload(version: 3 | 4, description: string, value: string): Buffer {
  if (version === 4) return Buffer.concat([Buffer.from([3]), Buffer.from(`${description}\0`, "utf8"), Buffer.from(value, "utf8")]);
  // v2.3 does not define UTF-8 text encoding. Preserve its version and use BOM-marked UTF-16.
  return Buffer.concat([
    Buffer.from([1, 0xff, 0xfe]),
    Buffer.from(description, "utf16le"),
    Buffer.from([0, 0]),
    Buffer.from(value, "utf16le"),
  ]);
}

function xmpPacket(value: string): string {
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:tc260="${TC260_XMP_NAMESPACE}"><tc260:AIGC>${escaped}</tc260:AIGC></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

function encodeMp3(content: Buffer, value: string): Buffer {
  const parsed = parseId3(content);
  assertMpegAudioFrame(parsed.audio);
  const retained = parsed.frames.filter((candidate) => {
    if (candidate.id === "TXXX" && decodeTxxxDescription(candidate.payload) === "AIGC") return false;
    if (candidate.id === "PRIV" && decodePrivOwner(candidate.payload) === XMP_OWNER) return false;
    return true;
  }).map((candidate) => candidate.raw);

  const txxx = frame(parsed.version, "TXXX", txxxPayload(parsed.version, "AIGC", value));
  const priv = frame(parsed.version, "PRIV", Buffer.concat([Buffer.from(`${XMP_OWNER}\0`, "latin1"), Buffer.from(xmpPacket(value), "utf8")]));
  // Keep one all-zero frame header as ID3 padding. ExifTool treats a tag that
  // ends immediately after the final frame as missing its terminating frame.
  const payload = Buffer.concat([...retained, txxx, priv, Buffer.alloc(ID3_FRAME_HEADER_LENGTH)]);
  const header = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, parsed.version, 0, 0]), numberToSyncSafe(payload.length)]);
  return Buffer.concat([header, payload, parsed.audio]);
}

function readMp3Value(content: Buffer): string[] {
  const parsed = parseId3(content);
  const txxx = parsed.frames.filter((candidate) => candidate.id === "TXXX" && decodeTxxxDescription(candidate.payload) === "AIGC")
    .map((candidate) => decodeTxxx(candidate.payload)?.value)
    .filter((value): value is string => value !== undefined);
  const priv = parsed.frames.filter((candidate) => candidate.id === "PRIV" && decodePrivOwner(candidate.payload) === XMP_OWNER)
    .map((candidate) => candidate.payload.subarray(candidate.payload.indexOf(0) + 1).toString("utf8"));
  if (txxx.length !== 1 || priv.length !== 1) return [];
  const xmlMatch = /<tc260:AIGC>([\s\S]*?)<\/tc260:AIGC>/.exec(priv[0]!);
  if (!xmlMatch) return [];
  const xmpValue = xmlMatch[1]!.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  return txxx[0] === xmpValue ? [txxx[0]!] : [];
}

function extensionFor(input: AigcLabelInput): string {
  const explicit = input.extension?.replace(/^\./, "").toLowerCase();
  if (explicit) return explicit;
  const contentType = input.contentType?.toLowerCase();
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  if (contentType === "video/mp4") return "mp4";
  if (contentType === "audio/mpeg" || contentType === "audio/mp3") return "mp3";
  return fail("AIGC_METADATA_MEDIA_UNSUPPORTED", "A file extension or recognised content type is required for implicit labeling.");
}

function makeLabel(produceId: string): AigcImplicitLabel {
  if (!produceId.trim()) return fail("AIGC_METADATA_PRODUCE_ID_INVALID", "ProduceID must be non-empty.");
  return {
    Label: "1",
    ContentProducer: AIGC_CONTENT_PRODUCER,
    ProduceID: produceId,
    ReservedCode1: "",
    ContentPropagator: AIGC_CONTENT_PRODUCER,
    PropagateID: produceId,
    ReservedCode2: "",
  };
}

function parseLabel(value: string): AigcImplicitLabel | undefined {
  try {
    const candidate: unknown = JSON.parse(value);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const record = candidate as Record<string, unknown>;
    const expected = ["Label", "ContentProducer", "ProduceID", "ReservedCode1", "ContentPropagator", "PropagateID", "ReservedCode2"] as const;
    if (Object.keys(record).length !== expected.length || !expected.every((key) => typeof record[key] === "string")) return undefined;
    return record as unknown as AigcImplicitLabel;
  } catch {
    return undefined;
  }
}

function assertSingleExpected(values: string[], expected: AigcImplicitLabel): void {
  if (values.length !== 1) fail("AIGC_METADATA_VERIFY_FAILED", "Expected exactly one TC260 AIGC metadata value.");
  const actual = parseLabel(values[0]!);
  if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("AIGC_METADATA_VERIFY_FAILED", "TC260 AIGC metadata does not match the required seven fields.");
  }
}

async function exiftoolJson(args: string[], exiftoolPath: string): Promise<Record<string, unknown>[]> {
  try {
    const { stdout } = await execFileAsync(exiftoolPath, args, { maxBuffer: 8 * 1024 * 1024 });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.some((entry) => !entry || typeof entry !== "object")) {
      return fail("AIGC_METADATA_VERIFY_FAILED", "ExifTool did not return JSON metadata.");
    }
    return parsed as Record<string, unknown>[];
  } catch (error) {
    return fail("AIGC_METADATA_EXIFTOOL_FAILED", "ExifTool implicit-label operation failed.", error);
  }
}

async function runExiftool(args: string[], exiftoolPath: string): Promise<void> {
  try {
    await execFileAsync(exiftoolPath, args, { maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    return fail("AIGC_METADATA_EXIFTOOL_FAILED", "ExifTool implicit-label operation failed.", error);
  }
}

function exiftoolValues(metadata: Record<string, unknown>[]): string[] {
  const values: string[] = [];
  for (const item of metadata) {
    for (const [key, value] of Object.entries(item)) {
      if (key.endsWith(":AIGC") && typeof value === "string") values.push(value);
    }
  }
  return values;
}

interface C2paObservation {
  present: boolean;
  fingerprint: string;
  softwareAgentName?: string;
  modelName?: string;
}

async function readC2paObservation(source: string, executable: string): Promise<C2paObservation> {
  const metadata = await exiftoolJson(
    ["-j", "-a", "-G1", "-C2PA:all", "-JUMBF:all", source],
    executable,
  );
  const retainedEntries = metadata.flatMap((record) => Object.entries(record)
    .filter(([key]) => !key.endsWith(":SourceFile") && key !== "SourceFile"))
    .sort(([left], [right]) => left.localeCompare(right));
  const values = Object.fromEntries(retainedEntries);
  const present = Object.entries(values).some(([key, value]) => (
    (key.endsWith(":JUMDLabel") && value === "c2pa")
    || key.includes(":C2PA")
    || (key.endsWith(":ActionsAction") && value === "c2pa.created")
  ));
  return {
    present,
    fingerprint: present
      ? createHash("sha256").update(JSON.stringify(values)).digest("hex")
      : "",
    softwareAgentName: findMetadataString(values, ":ActionsSoftwareAgentName"),
    modelName: findMetadataString(values, ":ActionsParametersModel_Name"),
  };
}

function findMetadataString(values: Record<string, unknown>, suffix: string): string | undefined {
  for (const [key, value] of Object.entries(values)) {
    if (key.endsWith(suffix) && typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

interface ExiftoolLabeledResult {
  content: Buffer;
  providerOriginEvidence?: ProviderOriginEvidence;
}

async function labelWithExiftool(
  input: AigcLabelInput,
  extension: "jpg" | "jpeg" | "png" | "mp4",
  serialized: string,
  expected: AigcImplicitLabel,
): Promise<ExiftoolLabeledResult> {
  const directory = await mkdtemp(path.join(tmpdir(), "shortdrama-aigc-"));
  const source = path.join(directory, `source.${extension}`);
  const config = input.exiftoolConfigPath ?? path.resolve(process.cwd(), "assets/compliance/exiftool-tc260.config");
  const executable = input.exiftoolPath ?? "exiftool";
  try {
    await writeFile(source, input.content);
    const before = await readC2paObservation(source, executable);
    await runExiftool(["-config", config, "-overwrite_original", `-XMP-tc260:AIGC=${serialized}`, source], executable);
    const written = await readFile(source);
    // Deliberately start a separate ExifTool process for the acceptance readback.
    const metadata = await exiftoolJson(["-config", config, "-j", "-a", "-G1", "-XMP-tc260:AIGC", source], executable);
    assertSingleExpected(exiftoolValues(metadata), expected);
    const after = await readC2paObservation(source, executable);
    if (before.present && (!after.present || before.fingerprint !== after.fingerprint)) {
      return fail(
        "AIGC_METADATA_PROVIDER_ORIGIN_CHANGED",
        "Platform metadata write did not preserve the observed provider C2PA/JUMBF manifest.",
      );
    }
    return {
      content: written,
      ...(before.present && after.present ? {
        providerOriginEvidence: {
          observationMethod: "exiftool_c2pa_jumbf",
          c2paPresentBefore: true,
          c2paPresentAfter: true,
          manifestFingerprint: before.fingerprint,
          signatureVerification: "not_performed",
          ...(before.softwareAgentName ? { softwareAgentName: before.softwareAgentName } : {}),
          ...(before.modelName ? { modelName: before.modelName } : {}),
        },
      } : {}),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Writes the single GB 45438 Appendix E implicit label without weakening failures. */
export async function labelAigcMedia(input: AigcLabelInput): Promise<AigcLabelResult> {
  const label = makeLabel(input.produceId);
  const serialized = JSON.stringify(label);
  const extension = extensionFor(input);
  let content: Buffer;
  let providerOriginEvidence: ProviderOriginEvidence | undefined;

  if (input.mediaKind === "audio" && extension === "mp3") {
    content = encodeMp3(input.content, serialized);
    assertSingleExpected(readMp3Value(content), label);
  } else if ((input.mediaKind === "image" && (extension === "jpg" || extension === "jpeg" || extension === "png"))
    || (input.mediaKind === "video" && extension === "mp4")) {
    const labeled = await labelWithExiftool(
      input,
      extension as "jpg" | "jpeg" | "png" | "mp4",
      serialized,
      label,
    );
    content = labeled.content;
    providerOriginEvidence = labeled.providerOriginEvidence;
  } else {
    return fail("AIGC_METADATA_MEDIA_UNSUPPORTED", `Implicit labeling does not support ${input.mediaKind}/${extension}.`);
  }

  return {
    content,
    label,
    complianceMetadata: {
      aigcMetadataEnabled: true,
      aigcMetadataEvidence: "platform_applied",
      ...(providerOriginEvidence ? { providerOriginEvidence } : {}),
    },
  };
}

/** Production-facing adapter.  The service owns the attempt-scoped contentId. */
export class AigcMetadataLabeler {
  async apply(input: AigcMetadataLabelerInput): Promise<AigcMetadataLabelerResult> {
    const labeled = await labelAigcMedia({
      content: input.content,
      contentType: input.contentType,
      extension: input.extension,
      mediaKind: input.mediaKind,
      produceId: input.contentId,
    });
    return {
      content: labeled.content,
      complianceMetadata: {
        ...labeled.complianceMetadata,
        contentId: input.contentId,
        contentProducer: AIGC_CONTENT_PRODUCER,
        schemaVersion: "GB45438-2025-Appendix-E",
      },
    };
  }
}

/** Exported for an independent verifier and focused tests; no writes are performed. */
export function readAigcImplicitLabel(content: Buffer, mediaKind: AigcLabelMediaKind, extension: string, options?: Pick<AigcLabelInput, "exiftoolPath" | "exiftoolConfigPath">): Promise<AigcImplicitLabel> | AigcImplicitLabel {
  const normalised = extension.replace(/^\./, "").toLowerCase();
  if (mediaKind === "audio" && normalised === "mp3") {
    const values = readMp3Value(content);
    if (values.length !== 1) return fail("AIGC_METADATA_VERIFY_FAILED", "Expected exactly one MP3 AIGC ID3/XMP label.");
    const label = parseLabel(values[0]!);
    if (!label) return fail("AIGC_METADATA_VERIFY_FAILED", "MP3 AIGC label is malformed.");
    return label;
  }
  return (async () => {
    if (!((mediaKind === "image" && ["jpg", "jpeg", "png"].includes(normalised)) || (mediaKind === "video" && normalised === "mp4"))) {
      return fail("AIGC_METADATA_MEDIA_UNSUPPORTED", "Unsupported implicit-label readback format.");
    }
    const directory = await mkdtemp(path.join(tmpdir(), "shortdrama-aigc-read-"));
    const source = path.join(directory, `source.${normalised}`);
    try {
      await writeFile(source, content);
      const metadata = await exiftoolJson(["-config", options?.exiftoolConfigPath ?? path.resolve(process.cwd(), "assets/compliance/exiftool-tc260.config"), "-j", "-a", "-G1", "-XMP-tc260:AIGC", source], options?.exiftoolPath ?? "exiftool");
      const values = exiftoolValues(metadata);
      if (values.length !== 1) return fail("AIGC_METADATA_VERIFY_FAILED", "Expected exactly one XMP AIGC label.");
      const label = parseLabel(values[0]!);
      if (!label) return fail("AIGC_METADATA_VERIFY_FAILED", "XMP AIGC label is malformed.");
      return label;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
}
