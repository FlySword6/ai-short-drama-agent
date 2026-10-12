import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

const [mode, ...args] = process.argv.slice(2);
const base = `http://127.0.0.1:${process.env.PORT || 8788}`;
if (mode === 'list') {
  const response = await fetch(`${base}/api/models`, { signal: AbortSignal.timeout(5000) });
  console.log(JSON.stringify(await response.json(), null, 2));
  if (!response.ok) process.exitCode = 1;
} else {
  if (!['text', 'image'].includes(mode) || !args.includes('--allow-paid')) {
    throw new Error('需明确 --allow-paid；text "提示词" [模型] 或 image "图片路径" "问题" [模型]。每次调用可能消耗公司额度。');
  }
  const values = args.filter(arg => arg !== '--allow-paid');
  let content;
  let model;
  if (mode === 'text') {
    if (!values[0]) throw new Error('缺少提示词');
    content = values[0]; model = values[1];
  } else {
    const [path, question, selected] = values;
    if (!path || !question) throw new Error('缺少图片路径或问题');
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(path).toLowerCase()];
    if (!mime || (await stat(path)).size > 5 * 1024 * 1024) throw new Error('只支持 <=5 MiB PNG/JPEG/WebP');
    content = [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: `data:${mime};base64,${(await readFile(path)).toString('base64')}` } }];
    model = selected;
  }
  const response = await fetch(`${base}/api/model-calls`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shortdrama-Call': '1' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], allowPaid: true }),
    signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS || 180000) + 5000),
  });
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok || result.status !== 'completed') process.exitCode = 1;
}
