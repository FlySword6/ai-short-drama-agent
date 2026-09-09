#!/usr/bin/env node
/**
 * S50 一次性实验脚本(E1/E3 投喂探针)。
 *
 * 用途:把改前/改后元数据的参考产物经 TOS 公网 URL 投喂 Seedance 2.0 fast,
 * 记录方舟侧是否拦截(真人脸/信任豁免),错误码逐字落回执。
 *
 * 纪律:
 * - 凭据只从环境变量读(由调用方 source 工作区根 .env 注入),本脚本不打印、
 *   不落盘任何密钥值;stdout 仅输出 HTTP 状态与 API 响应体。
 * - 请求形状复刻 src/modules/generation/provider/arkGenerationProvider.ts
 *   (submitVideo :198-235 / buildVideoContent :366-396 / query :81-127),
 *   上传复刻 src/integrations/tosStorage.ts(putObject)。
 *
 * 用法:
 *   node scripts/experiments/s50-ark-video-probe.mts upload <localPath> <tosKey>
 *   node scripts/experiments/s50-ark-video-probe.mts submit <referenceUrl> <video|image> <prompt>
 *   node scripts/experiments/s50-ark-video-probe.mts query <taskId>
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const ARK_BASE_URL = (process.env.ARK_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/+$/, "");
const ARK_API_KEY = process.env.ARK_API_KEY?.trim() ?? "";
const VIDEO_MODEL = process.env.ARK_VIDEO_MODEL?.trim() || "doubao-seedance-2-0-fast-260128";

function need(name: string, value: string): string {
  if (!value) {
    console.error(`missing required env: ${name}`);
    process.exit(2);
  }
  return value;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function upload(localPath: string, key: string): Promise<void> {
  const { TosClient } = require("@volcengine/tos-sdk") as {
    TosClient: new (options: Record<string, unknown>) => {
      putObject(input: Record<string, unknown>): Promise<unknown>;
    };
  };
  const bucket = need("TOS_BUCKET", process.env.TOS_BUCKET?.trim() ?? "");
  const endpointRaw = need("TOS_ENDPOINT", process.env.TOS_ENDPOINT?.trim() ?? "");
  const client = new TosClient({
    accessKeyId: need("TOS_ACCESS_KEY", process.env.TOS_ACCESS_KEY?.trim() ?? ""),
    accessKeySecret: need("TOS_SECRET_KEY", process.env.TOS_SECRET_KEY?.trim() ?? ""),
    region: need("TOS_REGION", process.env.TOS_REGION?.trim() ?? ""),
    endpoint: new URL(/^https?:\/\//i.test(endpointRaw) ? endpointRaw : `https://${endpointRaw}`).host,
  });
  const body = await readFile(localPath);
  const contentType = localPath.endsWith(".mp4") ? "video/mp4" : "image/jpeg";
  await client.putObject({ bucket, key, body, contentType });
  const base = (process.env.TOS_PUBLIC_BASE_URL?.trim() || endpointRaw).replace(/\/+$/, "");
  const url = `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  console.log(JSON.stringify({ ok: true, url, bytes: body.length }, null, 2));
}

async function submit(referenceUrl: string, kind: "video" | "image", prompt: string): Promise<void> {
  need("ARK_API_KEY", ARK_API_KEY);
  const refItem = kind === "video"
    ? { type: "video_url", video_url: { url: referenceUrl }, role: "reference_video" }
    : { type: "image_url", image_url: { url: referenceUrl }, role: "reference_image" };
  const body = {
    model: VIDEO_MODEL,
    content: [{ type: "text", text: prompt }, refItem],
    ratio: "9:16",
    resolution: "720p",
    duration: 4,
    watermark: false,
    generate_audio: false,
  };
  const res = await fetch(`${ARK_BASE_URL}/contents/generations/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ARK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(JSON.stringify({ httpStatus: res.status, requestModel: VIDEO_MODEL, body: safeJson(text) }, null, 2));
}

async function query(taskId: string): Promise<void> {
  need("ARK_API_KEY", ARK_API_KEY);
  const res = await fetch(`${ARK_BASE_URL}/contents/generations/tasks/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${ARK_API_KEY}` },
  });
  const text = await res.text();
  console.log(JSON.stringify({ httpStatus: res.status, body: safeJson(text) }, null, 2));
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "upload" && args.length === 2) {
  await upload(args[0], args[1]);
} else if (cmd === "submit" && args.length === 3 && (args[1] === "video" || args[1] === "image")) {
  await submit(args[0], args[1], args[2]);
} else if (cmd === "query" && args.length === 1) {
  await query(args[0]);
} else {
  console.error("usage: upload <localPath> <tosKey> | submit <referenceUrl> <video|image> <prompt> | query <taskId>");
  process.exit(2);
}
