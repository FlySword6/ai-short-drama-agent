import { deflateSync } from 'node:zlib';

// Programmatic fixture, not an AI-generated asset and not a user image.
function redPng() {
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, body) {
    const label = Buffer.from(type);
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([label, body])));
    return Buffer.concat([length, label, body, crc]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * (1 + 64 * 3));
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3] = 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

if (!process.argv.includes('--allow-paid')) throw new Error('此命令会发出两次付费/公司额度请求。请明确传入 --allow-paid。');
const base = `http://127.0.0.1:${process.env.PORT || 8788}`;
const probes = [
  { kind: 'text', content: 'Compute 17 + 25. Reply with the number only.', expected: /\b42\b/ },
  { kind: 'image', content: [{ type: 'text', text: 'Name the dominant color of this image in one English word.' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${redPng()}` } }], expected: /\bred\b/i },
];
for (const probe of probes) {
  // Exactly one request per probe. No retries, fallback or project data.
  try {
    const response = await fetch(`${base}/api/model-calls`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' },
      body: JSON.stringify({ model: 'gpt-5.6-terra', messages: [{ role: 'user', content: probe.content }],
        reasoningEffort: 'low', maxOutputTokens: 4096, allowPaid: true }),
      signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 180000) + 5000) });
    const result = await response.json();
    const passed = response.ok && result.status === 'completed' && probe.expected.test(result.text || '');
    console.log(JSON.stringify({ at: new Date().toISOString(), kind: probe.kind, passed,
      httpStatus: response.status, requestedModel: result.requestedModel, reportedModel: result.reportedModel,
      reasoningEffort: result.reasoningEffort, usage: result.usage, durationMs: result.durationMs,
      error: result.error ? { code: result.error.code, upstreamStatus: result.error.upstreamStatus } : undefined }));
    if (!passed) process.exitCode = 1;
  } catch {
    console.log(JSON.stringify({ kind: probe.kind, passed: false, error: 'TRANSPORT_FAILURE_NO_RETRY' }));
    process.exitCode = 1;
  }
}
