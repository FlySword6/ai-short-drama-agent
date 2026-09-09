#!/usr/bin/env node
/**
 * fetch-director-assets.mjs
 *
 * Downloads staged director GLB assets from Volcano Engine TOS into
 * runtime/director-assets/. Runs in Docker at container start (background)
 * and locally; pure Node >=22 stdlib + global fetch, zero dependencies.
 *
 * Behaviour:
 *   - reads assets/director/manifest.json
 *   - for every entry, downloads `${TOS_PUBLIC_BASE_URL}/${tosKey}` to
 *     runtime/director-assets/${file} (local layout mirrors the tosKey with
 *     the "director-assets/v1/" prefix stripped)
 *   - verifies sha256 after download; existing files whose size+sha256 match
 *     the manifest are skipped
 *   - prints a summary; exits non-zero if anything is missing or corrupt
 *
 * Options:
 *   --check        verify only, never download; exit 0 only if every file is
 *                  present and matches size+sha256
 *   --base <url>   override the download base URL (default: env
 *                  TOS_PUBLIC_BASE_URL, optionally read from a local .env)
 *   --concurrency <n>  parallel downloads (default 4)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "assets", "director", "manifest.json");
const STAGE_ROOT = path.join(REPO_ROOT, "runtime", "director-assets");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const baseOverride = args.includes("--base") ? args[args.indexOf("--base") + 1] : undefined;
const concurrencyArg = args.includes("--concurrency") ? Number(args[args.indexOf("--concurrency") + 1]) : 4;
const concurrency = Number.isInteger(concurrencyArg) && concurrencyArg > 0 ? concurrencyArg : 4;

function log(message) {
  console.log(`[director-assets] ${message}`);
}

/** Minimal .env reader so the script stays dependency-free. */
function loadDotEnv() {
  const envPath = path.join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trimStart().startsWith("#")) continue;
    const key = match[1];
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function verifyEntry(asset) {
  const target = path.join(STAGE_ROOT, asset.file);
  if (!existsSync(target)) return { status: "missing", target };
  if (statSync(target).size !== asset.size) return { status: "size-mismatch", target };
  if (sha256File(target) !== asset.sha256) return { status: "sha-mismatch", target };
  return { status: "ok", target };
}

async function downloadToFile(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, buffer);
}

async function main() {
  loadDotEnv();
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const assets = manifest.assets ?? [];
  if (assets.length === 0) throw new Error(`manifest has no assets: ${MANIFEST_PATH}`);

  const baseUrl = (baseOverride ?? process.env.TOS_PUBLIC_BASE_URL)?.replace(/\/+$/, "");
  if (!checkOnly && !baseUrl) {
    throw new Error("TOS_PUBLIC_BASE_URL is not set; pass --base <url> or configure the environment");
  }

  let downloaded = 0;
  let skipped = 0;
  const failures = [];

  log(`${checkOnly ? "checking" : "fetching"} ${assets.length} assets${baseUrl ? ` from ${baseUrl}` : ""}`);

  let cursor = 0;
  async function worker() {
    while (cursor < assets.length) {
      const asset = assets[cursor];
      cursor += 1;
      const before = verifyEntry(asset);
      if (before.status === "ok") {
        skipped += 1;
        continue;
      }
      if (checkOnly) {
        failures.push(`${asset.file}: ${before.status}`);
        continue;
      }
      const url = `${baseUrl}/${asset.tosKey.split("/").map(encodeURIComponent).join("/")}`;
      try {
        await downloadToFile(url, before.target);
        const after = verifyEntry(asset);
        if (after.status !== "ok") {
          failures.push(`${asset.file}: downloaded but ${after.status}`);
        } else {
          downloaded += 1;
        }
      } catch (error) {
        failures.push(`${asset.file}: ${error.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  log(`ok=${skipped + downloaded} (downloaded ${downloaded}, already present ${skipped}), failed=${failures.length}`);
  for (const failure of failures.slice(0, 20)) log(`  FAIL ${failure}`);
  if (failures.length > 20) log(`  ... and ${failures.length - 20} more`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`[director-assets] FAILED: ${error.message}`);
  process.exit(1);
});
