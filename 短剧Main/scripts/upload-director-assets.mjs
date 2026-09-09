#!/usr/bin/env node
/**
 * upload-director-assets.mjs
 *
 * Uploads staged director GLB assets from runtime/director-assets/ to
 * Volcano Engine TOS, using the tosKey recorded in
 * assets/director/manifest.json. Idempotent: objects that already exist with
 * the same size are skipped (headObject first).
 *
 * Requires TOS credentials in the environment or in a local .env:
 *   TOS_BUCKET, TOS_ENDPOINT (or TOS_SDK_ENDPOINT), TOS_REGION,
 *   TOS_ACCESS_KEY, TOS_SECRET_KEY
 *
 * Usage: node scripts/upload-director-assets.mjs [--force]
 */
import "dotenv/config";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "assets", "director", "manifest.json");
const STAGE_ROOT = path.join(REPO_ROOT, "runtime", "director-assets");
const force = process.argv.includes("--force");

function log(message) {
  console.log(`[director-assets-upload] ${message}`);
}

/** The SDK wants a bare host; TOS_ENDPOINT may be a full URL. */
function normalizeEndpoint(endpoint) {
  const value = endpoint.trim();
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).host;
  } catch {
    return value.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  }
}

function createClient() {
  const bucket = process.env.TOS_BUCKET;
  const endpoint = process.env.TOS_SDK_ENDPOINT ?? process.env.TOS_ENDPOINT;
  const accessKey = process.env.TOS_ACCESS_KEY;
  const secretKey = process.env.TOS_SECRET_KEY;
  const region = process.env.TOS_REGION ?? "cn-beijing";
  const missing = [
    ["TOS_BUCKET", bucket],
    ["TOS_ENDPOINT/TOS_SDK_ENDPOINT", endpoint],
    ["TOS_ACCESS_KEY", accessKey],
    ["TOS_SECRET_KEY", secretKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`TOS credentials incomplete, missing: ${missing.join(", ")} (set them in .env or the environment)`);
  }
  const moduleValue = require("@volcengine/tos-sdk");
  const Constructor = moduleValue.TosClient ?? moduleValue.Client;
  if (!Constructor) throw new Error("@volcengine/tos-sdk client constructor is unavailable");
  return {
    bucket,
    client: new Constructor({
      accessKeyId: accessKey,
      accessKeySecret: secretKey,
      region,
      endpoint: normalizeEndpoint(endpoint),
    }),
  };
}

async function remoteSize(client, bucket, key) {
  try {
    const result = await client.headObject({ bucket, key });
    const headers = result?.headers ?? result?.data?.headers ?? {};
    const length = headers["content-length"] ?? headers["Content-Length"];
    return length === undefined ? undefined : Number(length);
  } catch (error) {
    const status = error?.statusCode ?? error?.status ?? error?.response?.status;
    if (status === 404 || error?.code === "NoSuchKey" || error?.code === "NotFound") return undefined;
    throw error;
  }
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const assets = manifest.assets ?? [];
  if (assets.length === 0) throw new Error(`manifest has no assets: ${MANIFEST_PATH}`);
  const { bucket, client } = createClient();

  let uploaded = 0;
  let skipped = 0;
  const failures = [];
  log(`uploading ${assets.length} assets to bucket ${bucket}`);
  for (const asset of assets) {
    const localPath = path.join(STAGE_ROOT, asset.file);
    if (!existsSync(localPath)) {
      failures.push(`${asset.tosKey}: local file missing (${asset.file})`);
      continue;
    }
    try {
      const size = statSync(localPath).size;
      if (!force) {
        const existing = await remoteSize(client, bucket, asset.tosKey);
        if (existing === size) {
          skipped += 1;
          continue;
        }
      }
      await client.putObject({
        bucket,
        key: asset.tosKey,
        body: readFileSync(localPath),
        contentType: "model/gltf-binary",
      });
      uploaded += 1;
      if (uploaded % 50 === 0) log(`  ... ${uploaded} uploaded so far`);
    } catch (error) {
      failures.push(`${asset.tosKey}: ${error.message}`);
    }
  }
  log(`uploaded=${uploaded}, skipped=${skipped}, failed=${failures.length}`);
  for (const failure of failures.slice(0, 20)) log(`  FAIL ${failure}`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`[director-assets-upload] FAILED: ${error.message}`);
  process.exit(1);
});
