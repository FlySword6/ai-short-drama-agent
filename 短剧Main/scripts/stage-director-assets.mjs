#!/usr/bin/env node
/**
 * stage-director-assets.mjs
 *
 * One-shot (but re-runnable) staging script for 3D director assets.
 * Downloads CC0 assets from three public sources and stages them as GLB files
 * under runtime/director-assets/{source}/{category}/{id}.glb, then regenerates
 * assets/director/manifest.json (the only artifact that goes into git).
 *
 * Sources:
 *   - kenney.nl      CC0 kits, GLB files extracted from kit zips
 *   - quaternius.com CC0 packs, OBJ(+MTL) files pulled from the public Google
 *                    Drive folders the pack pages link to, converted to GLB
 *                    with obj2gltf (Quaternius no longer publishes zips)
 *   - polyhaven.com  CC0 models, 1k glTF + textures via the public API,
 *                    packed into self-contained GLB with gltf-transform
 *
 * Usage:
 *   node scripts/stage-director-assets.mjs [--source=kenney|quaternius|polyhaven]
 *                                          [--force] [--manifest-only]
 *
 * Requires network access and npm/npx (converter packages are installed once
 * into runtime/director-assets/.tools, which is gitignored).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGE_ROOT = path.join(REPO_ROOT, "runtime", "director-assets");
const TOOLS_DIR = path.join(STAGE_ROOT, ".tools");
const MANIFEST_PATH = path.join(REPO_ROOT, "assets", "director", "manifest.json");
const TOS_KEY_PREFIX = "director-assets/v1";
const USER_AGENT = "shortdrama-director-assets-staging/1.0 (+https://github.com/col-shortdrama/zhongwen-shortdrama-main)";

const KENNEY_KITS = [
  { slug: "furniture-kit", category: "furniture", tags: ["interior", "furniture"] },
  { slug: "city-kit-roads", category: "city-roads", tags: ["street", "road", "exterior"] },
  { slug: "city-kit-commercial", category: "city-commercial", tags: ["street", "building", "exterior"] },
  { slug: "city-kit-suburban", category: "city-suburban", tags: ["suburb", "building", "exterior"] },
  { slug: "car-kit", category: "vehicle", tags: ["vehicle", "car"] },
];

// Quaternius pack pages link to public Google Drive folders; each pack keeps
// its OBJ export in one of these folders (resolved 2026-07-20).
const QUATERNIUS_PACKS = [
  { pack: "ultimatefurniture", driveFolder: "1nt4N9hEZMPmJR7_rYx5nSitgjj_aNNzk", category: "furniture", tags: ["interior", "furniture"] },
  { pack: "ultimatehomeinterior", driveFolder: "1LQTY5A0u17mgjsJzDDbL7Nssx9SynaqJ", category: "interior", tags: ["interior", "room"] },
  { pack: "modularstreets", driveFolder: "1-zy-1ny2tKA--hf89dIZnjFavUKK8TC3", category: "street", tags: ["street", "exterior"] },
  { pack: "cars", driveFolder: "1kMPGKO8D_k3c1f0us9MJr9aiWrzz_72C", category: "vehicle", tags: ["vehicle", "car"] },
  { pack: "ultimatefood", driveFolder: "162kVYo9aact5gCGYS0VdNTx49Dos8bJg", category: "food", tags: ["food", "prop"] },
  { pack: "backgroundposedhumans-female", driveFolder: "16wRBY4XMiG5Fc2Mg2EZbFvb-OMhXI__Z", category: "human", tags: ["human", "character", "posed"] },
  { pack: "backgroundposedhumans-male", driveFolder: "1Y3ZM823JC1ecSMvnUYangz-P5E6T-g0h", category: "human", tags: ["human", "character", "posed"] },
];

// Curated realistic PBR models (1k textures are enough for previs).
const POLYHAVEN_PICKS = [
  // 沙发 / 扶手椅 / 椅子
  { slug: "Sofa_01", category: "furniture", tags: ["sofa", "living-room"] },
  { slug: "sofa_02", category: "furniture", tags: ["sofa", "living-room"] },
  { slug: "chinese_sofa", category: "furniture", tags: ["sofa", "chinese"] },
  { slug: "ArmChair_01", category: "furniture", tags: ["armchair", "living-room"] },
  { slug: "Rockingchair_01", category: "furniture", tags: ["chair", "rocking"] },
  { slug: "WoodenChair_01", category: "furniture", tags: ["chair", "dining"] },
  { slug: "GreenChair_01", category: "furniture", tags: ["chair"] },
  { slug: "SchoolChair_01", category: "furniture", tags: ["chair", "school"] },
  { slug: "chinese_armchair", category: "furniture", tags: ["armchair", "chinese"] },
  // 桌 / 柜 / 架
  { slug: "CoffeeTable_01", category: "furniture", tags: ["table", "coffee-table"] },
  { slug: "WoodenTable_01", category: "furniture", tags: ["table", "dining"] },
  { slug: "coffee_table_round_01", category: "furniture", tags: ["table", "coffee-table"] },
  { slug: "chinese_console_table", category: "furniture", tags: ["table", "chinese"] },
  { slug: "chinese_tea_table", category: "furniture", tags: ["table", "chinese", "tea"] },
  { slug: "metal_office_desk", category: "furniture", tags: ["desk", "office"] },
  { slug: "SchoolDesk_01", category: "furniture", tags: ["desk", "school"] },
  { slug: "Shelf_01", category: "furniture", tags: ["shelf", "storage"] },
  { slug: "wooden_bookshelf_worn", category: "furniture", tags: ["bookshelf", "storage"] },
  { slug: "modern_wooden_cabinet", category: "furniture", tags: ["cabinet", "storage"] },
  { slug: "vintage_cabinet_01", category: "furniture", tags: ["cabinet", "storage"] },
  { slug: "chinese_cabinet", category: "furniture", tags: ["cabinet", "chinese"] },
  // 床
  { slug: "GothicBed_01", category: "furniture", tags: ["bed", "bedroom"] },
  { slug: "old_bed_frame", category: "furniture", tags: ["bed", "bedroom"] },
  { slug: "vintage_day_bed", category: "furniture", tags: ["bed", "bedroom"] },
  // 门 / 窗
  { slug: "large_castle_door", category: "door", tags: ["door"] },
  { slug: "rollershutter_door", category: "door", tags: ["door", "shop"] },
  { slug: "rollershutter_window_01", category: "window", tags: ["window", "shop"] },
  { slug: "rollershutter_window_02", category: "window", tags: ["window", "shop"] },
  // 灯
  { slug: "desk_lamp_arm_01", category: "lamp", tags: ["lamp", "desk"] },
  { slug: "hanging_industrial_lamp", category: "lamp", tags: ["lamp", "ceiling"] },
  { slug: "vintage_oil_lamp", category: "lamp", tags: ["lamp", "vintage"] },
  { slug: "modern_ceiling_lamp_01", category: "lamp", tags: ["lamp", "ceiling"] },
  { slug: "street_lamp_01", category: "lamp", tags: ["lamp", "street"] },
  // 绿植
  { slug: "potted_plant_01", category: "plant", tags: ["plant", "pot"] },
  { slug: "planter_pot_clay", category: "plant", tags: ["plant", "pot"] },
  { slug: "planter_box_01", category: "plant", tags: ["plant", "planter"] },
  // 桶 / 箱 / 杂物
  { slug: "Barrel_01", category: "prop", tags: ["barrel"] },
  { slug: "wooden_barrels_01", category: "prop", tags: ["barrel"] },
  { slug: "wine_barrel_01", category: "prop", tags: ["barrel", "wine"] },
  { slug: "wooden_crate_01", category: "prop", tags: ["crate", "box"] },
  { slug: "plastic_crate_01", category: "prop", tags: ["crate", "box"] },
  { slug: "old_military_crate", category: "prop", tags: ["crate", "military"] },
  { slug: "cardboard_box_01", category: "prop", tags: ["box", "cardboard"] },
  { slug: "metal_toolbox", category: "prop", tags: ["toolbox"] },
  { slug: "book_encyclopedia_set_01", category: "prop", tags: ["book"] },
  // 街道杂物
  { slug: "concrete_road_barrier", category: "street", tags: ["barrier", "street"] },
  { slug: "concrete_road_barrier_02", category: "street", tags: ["barrier", "street"] },
  { slug: "metal_trash_can", category: "street", tags: ["trash", "street"] },
  { slug: "trashbag", category: "street", tags: ["trash", "street"] },
  { slug: "fire_hydrant", category: "street", tags: ["hydrant", "street"] },
  { slug: "WetFloorSign_01", category: "street", tags: ["sign"] },
  { slug: "power_box_01", category: "street", tags: ["utility", "street"] },
  { slug: "utility_box_01", category: "street", tags: ["utility", "street"] },
  { slug: "modular_chainlink_fence", category: "street", tags: ["fence", "street"] },
];

const CONCURRENCY = 6;
const args = process.argv.slice(2);
const onlySource = args.find((a) => a.startsWith("--source="))?.split("=")[1];
const force = args.includes("--force");
const manifestOnly = args.includes("--manifest-only");

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function log(message) {
  console.log(`[stage] ${message}`);
}

async function fetchBuffer(url, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

async function fetchText(url) {
  return (await fetchBuffer(url)).toString("utf8");
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assertGlb(filePath) {
  const fd = readFileSync(filePath).subarray(0, 4).toString("latin1");
  if (fd !== "glTF") throw new Error(`not a GLB (bad magic): ${filePath}`);
}

function displayName(base) {
  return base
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

async function mapPool(items, worker, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function toolPath(name) {
  const bin = path.join(TOOLS_DIR, "node_modules", ".bin", name);
  if (!existsSync(bin)) {
    log(`installing converter tools into ${TOOLS_DIR} (one-time npm install) ...`);
    mkdirSync(TOOLS_DIR, { recursive: true });
    execFileSync("npm", ["install", "--prefix", TOOLS_DIR, "--no-save", "--silent", "obj2gltf", "@gltf-transform/cli"], {
      stdio: "inherit",
    });
  }
  return bin;
}

// ---------------------------------------------------------------------------
// kenney
// ---------------------------------------------------------------------------

async function stageKenney() {
  for (const kit of KENNEY_KITS) {
    const outDir = path.join(STAGE_ROOT, "kenney", kit.category);
    mkdirSync(outDir, { recursive: true });
    const pageUrl = `https://kenney.nl/assets/${kit.slug}`;
    log(`kenney: resolving download for ${kit.slug}`);
    const html = await fetchText(pageUrl);
    const zipMatch = html.match(/https:\/\/kenney\.nl\/media\/pages\/assets\/[^"'\\]+?\.zip/);
    if (!zipMatch) throw new Error(`kenney: no zip link found on ${pageUrl}`);
    const tmpDir = path.join(os.tmpdir(), `kenney-${kit.slug}-${process.pid}`);
    try {
      const zipPath = path.join(tmpDir, "kit.zip");
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(zipPath, await fetchBuffer(zipMatch[0]));
      execFileSync("unzip", ["-oq", zipPath, "-d", path.join(tmpDir, "x")]);
      const glbs = [...walkFiles(path.join(tmpDir, "x"))].filter(
        (f) => f.toLowerCase().endsWith(".glb") && f.includes(`${path.sep}Models${path.sep}`),
      );
      if (glbs.length === 0) throw new Error(`kenney: no GLB files under Models/ in ${kit.slug}`);
      let copied = 0;
      for (const glb of glbs) {
        const base = path.basename(glb);
        const target = path.join(outDir, base);
        if (!force && existsSync(target)) continue;
        writeFileSync(target, readFileSync(glb));
        assertGlb(target);
        copied += 1;
      }
      log(`kenney: ${kit.slug} -> ${glbs.length} GLBs staged (${copied} new) into kenney/${kit.category}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// quaternius (google drive folders -> obj -> glb)
// ---------------------------------------------------------------------------

async function driveList(folderId) {
  const html = await fetchText(`https://drive.google.com/drive/folders/${folderId}`);
  const entries = new Map();
  const pattern = /data-id="([a-zA-Z0-9_-]{25,})"[^>]*>.*?aria-label="([^"]{1,150}?)"/gs;
  for (const match of html.matchAll(pattern)) {
    if (!entries.has(match[1])) entries.set(match[1], match[2]);
  }
  return entries;
}

async function driveDownload(fileId) {
  const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
  let buffer = await fetchBuffer(url);
  // Large files trigger a virus-scan interstitial; follow the confirm link.
  if (buffer.subarray(0, 200).toString("latin1").toLowerCase().includes("<html")) {
    const html = buffer.toString("utf8");
    const confirm = html.match(/confirm=([0-9A-Za-z_-]+)/);
    if (confirm) {
      buffer = await fetchBuffer(`${url}&confirm=${confirm[1]}`);
    }
  }
  return buffer;
}

async function stageQuaternius() {
  const obj2gltf = toolPath("obj2gltf");
  for (const pack of QUATERNIUS_PACKS) {
    const outDir = path.join(STAGE_ROOT, "quaternius", pack.category);
    mkdirSync(outDir, { recursive: true });
    log(`quaternius: listing drive folder for ${pack.pack}`);
    const entries = await driveList(pack.driveFolder);
    const objs = [...entries.entries()]
      .filter(([, label]) => /\.obj\s/i.test(label))
      .map(([id, label]) => ({ id, name: label.replace(/\.obj.*$/i, "") }));
    const mtls = new Map(
      [...entries.entries()]
        .filter(([, label]) => /\.mtl\s/i.test(label))
        .map(([id, label]) => [label.replace(/\.mtl.*$/i, ""), id]),
    );
    if (objs.length === 0) throw new Error(`quaternius: no .obj entries in ${pack.pack} folder`);
    let converted = 0;
    await mapPool(objs, async (obj) => {
      const target = path.join(outDir, `${obj.name}.glb`);
      if (!force && existsSync(target)) return;
      const tmpDir = path.join(os.tmpdir(), `quat-${process.pid}-${obj.name}`);
      mkdirSync(tmpDir, { recursive: true });
      try {
        writeFileSync(path.join(tmpDir, `${obj.name}.obj`), await driveDownload(obj.id));
        const mtlId = mtls.get(obj.name);
        if (mtlId) writeFileSync(path.join(tmpDir, `${obj.name}.mtl`), await driveDownload(mtlId));
        execFileSync(obj2gltf, ["-i", path.join(tmpDir, `${obj.name}.obj`), "-o", target], { stdio: "pipe" });
        assertGlb(target);
        converted += 1;
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
    log(`quaternius: ${pack.pack} -> ${objs.length} GLBs staged (${converted} new) into quaternius/${pack.category}`);
  }
}

// ---------------------------------------------------------------------------
// polyhaven (1k gltf + textures -> packed glb)
// ---------------------------------------------------------------------------

async function stagePolyhaven() {
  const gltfTransform = toolPath("gltf-transform");
  let staged = 0;
  const failed = [];
  await mapPool(POLYHAVEN_PICKS, async (pick) => {
    const outDir = path.join(STAGE_ROOT, "polyhaven", pick.category);
    mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, `${pick.slug}.glb`);
    if (!force && existsSync(target)) return;
    try {
      const files = JSON.parse(await fetchText(`https://api.polyhaven.com/files/${pick.slug}`));
      const variant = files?.gltf?.["1k"]?.gltf;
      if (!variant?.url) throw new Error(`no 1k gltf variant`);
      const tmpDir = path.join(os.tmpdir(), `ph-${process.pid}-${pick.slug}`);
      mkdirSync(tmpDir, { recursive: true });
      try {
        const gltfName = path.basename(new URL(variant.url).pathname);
        writeFileSync(path.join(tmpDir, gltfName), await fetchBuffer(variant.url));
        for (const [relPath, info] of Object.entries(variant.include ?? {})) {
          const dest = path.join(tmpDir, relPath);
          mkdirSync(path.dirname(dest), { recursive: true });
          writeFileSync(dest, await fetchBuffer(info.url));
        }
        execFileSync(gltfTransform, ["copy", path.join(tmpDir, gltfName), target], { stdio: "pipe" });
        assertGlb(target);
        staged += 1;
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (error) {
      failed.push(`${pick.slug}: ${error.message}`);
    }
  });
  log(`polyhaven: ${staged} new GLBs staged (${POLYHAVEN_PICKS.length} curated total)`);
  for (const failure of failed) log(`polyhaven: SKIPPED ${failure}`);
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

function sourceMeta(source) {
  if (source === "kenney") {
    return { license: "CC0-1.0", kitTags: new Map(KENNEY_KITS.map((k) => [k.category, [k.slug, ...k.tags]])) };
  }
  if (source === "quaternius") {
    const kitTags = new Map();
    for (const p of QUATERNIUS_PACKS) {
      const existing = kitTags.get(p.category) ?? [];
      kitTags.set(p.category, [...new Set([...existing, p.pack.replace(/-(female|male)$/, ""), ...p.tags])]);
    }
    return { license: "CC0-1.0", kitTags };
  }
  const kitTags = new Map();
  for (const p of POLYHAVEN_PICKS) {
    const existing = kitTags.get(p.category) ?? [];
    kitTags.set(p.category, [...new Set([...existing, ...p.tags])]);
  }
  return { license: "CC0-1.0", kitTags };
}

function buildManifest() {
  const assets = [];
  for (const source of ["kenney", "quaternius", "polyhaven"]) {
    const sourceDir = path.join(STAGE_ROOT, source);
    if (!existsSync(sourceDir)) continue;
    const meta = sourceMeta(source);
    for (const category of readdirSync(sourceDir, { withFileTypes: true })) {
      if (!category.isDirectory()) continue;
      const categoryDir = path.join(sourceDir, category.name);
      for (const file of readdirSync(categoryDir).filter((f) => f.endsWith(".glb")).sort()) {
        const full = path.join(categoryDir, file);
        const base = path.basename(file, ".glb");
        const rel = `${source}/${category.name}/${file}`;
        const tokens = base
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .split(/[\s_\-0-9]+/)
          .map((t) => t.toLowerCase())
          .filter((t) => t.length > 1);
        assets.push({
          id: `${source}/${category.name}/${base}`,
          name: displayName(base),
          category: category.name,
          source,
          license: meta.license,
          tosKey: `${TOS_KEY_PREFIX}/${rel}`,
          file: rel,
          size: statSync(full).size,
          sha256: sha256File(full),
          tags: [...new Set([...(meta.kitTags.get(category.name) ?? []), ...tokens])],
        });
      }
    }
  }
  assets.sort((a, b) => a.id.localeCompare(b.id));
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    assets,
  };
  mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

// ---------------------------------------------------------------------------

async function main() {
  if (!manifestOnly) {
    mkdirSync(STAGE_ROOT, { recursive: true });
    const sources = [
      ["kenney", stageKenney],
      ["quaternius", stageQuaternius],
      ["polyhaven", stagePolyhaven],
    ];
    for (const [name, fn] of sources) {
      if (onlySource && onlySource !== name) continue;
      await fn();
    }
  }
  const manifest = buildManifest();
  let totalSize = 0;
  const bySource = new Map();
  for (const asset of manifest.assets) {
    totalSize += asset.size;
    const entry = bySource.get(asset.source) ?? { count: 0, size: 0 };
    entry.count += 1;
    entry.size += asset.size;
    bySource.set(asset.source, entry);
  }
  log(`manifest written: ${MANIFEST_PATH}`);
  for (const [source, entry] of bySource) {
    log(`  ${source}: ${entry.count} assets, ${(entry.size / 1024 / 1024).toFixed(1)} MB`);
  }
  log(`  total: ${manifest.assets.length} assets, ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((error) => {
  console.error(`[stage] FAILED: ${error.message}`);
  process.exit(1);
});
