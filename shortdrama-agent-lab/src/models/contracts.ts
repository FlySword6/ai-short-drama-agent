import { Type, type Static } from '@sinclair/typebox';
import Ajv from 'ajv';

const Text = Type.String({ minLength: 1, maxLength: 1000000, pattern: '\\S' });
const TextPart = Type.Object({ type: Type.Literal('text'), text: Text }, { additionalProperties: false });
const ImagePart = Type.Object({
  type: Type.Literal('image_url'),
  image_url: Type.Object({
    // Inline images only: never make the backend/proxy fetch caller-supplied URLs.
    url: Type.String({ maxLength: 7000000, pattern: '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$' }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
const Message = Type.Union([
  Type.Object({ role: Type.Union([Type.Literal('system'), Type.Literal('assistant')]), content: Text }, { additionalProperties: false }),
  Type.Object({ role: Type.Literal('user'), content: Type.Union([Text, Type.Array(Type.Union([TextPart, ImagePart]), { minItems: 1, maxItems: 12 })]) }, { additionalProperties: false }),
]);

export const CallSchema = Type.Object({
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  messages: Type.Array(Message, { minItems: 1, maxItems: 100 }),
  reasoningEffort: Type.Optional(Type.Union(['low', 'medium', 'high', 'xhigh', 'max'].map(value => Type.Literal(value)))),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 32768 })),
  allowPaid: Type.Literal(true),
}, { additionalProperties: false });

export type ModelCall = Static<typeof CallSchema>;
export const validateCall = new Ajv({ allErrors: false }).compile<ModelCall>(CallSchema);
export const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

export class ModelError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string,
    public readonly details: Record<string, unknown> = {}) { super(message); }
}

export function parseCall(value: unknown): ModelCall {
  if (!validateCall(value)) throw new ModelError(400, 'INVALID_REQUEST',
    '请求不符合模型调用契约；必须 allowPaid:true，只支持文本和图片理解。');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_REQUEST_BYTES) {
    throw new ModelError(413, 'INPUT_TOO_LARGE', '请求超过本项目 10 MiB 限制。');
  }
  if (!value.messages.some(message => message.role === 'user')) {
    throw new ModelError(400, 'INVALID_REQUEST', '至少需要一条 user 消息。');
  }
  let imageCount = 0;
  for (const message of value.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'image_url') continue;
      imageCount++;
      const [meta, data = ''] = part.image_url.url.split(',');
      const bytes = Buffer.from(data, 'base64');
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      const matches = meta === 'data:image/png;base64' ? png : meta === 'data:image/jpeg;base64' ? jpeg : webp;
      if (!matches || bytes.toString('base64') !== data || bytes.length > 5 * 1024 * 1024) {
        throw new ModelError(400, 'INVALID_IMAGE', '图片须为有效 Base64 编码的 PNG/JPEG/WebP，单图最多 5 MiB。');
      }
    }
  }
  if (imageCount > 4) throw new ModelError(400, 'TOO_MANY_IMAGES', '每次最多 4 张图片。');
  return value;
}
