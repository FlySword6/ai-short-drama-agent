import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyDirectorPreviewImportPlan,
  buildDirectorPreviewImportPlan,
  validateDirectorPreviewManifest,
  verifyDirectorPreviewPng,
  type DirectorPreviewManifest,
} from "../src/modules/assets/directorPreviewImport.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifestPath = path.join(workspaceRoot, "assets/director/manifest.json");
const apply = process.argv.slice(2).includes("--apply");
const manifestPath = resolveManifestPath(readOption("--manifest") ?? "assets/director/preview-manifest.json");

async function main(): Promise<void> {
  const [sourceText, previewText] = await Promise.all([readFile(sourceManifestPath, "utf8"), readFile(manifestPath, "utf8")]);
  const sourceManifest: unknown = JSON.parse(sourceText);
  const previewManifest: unknown = JSON.parse(previewText);
  validateDirectorPreviewManifest(previewManifest, sourceManifest);
  await verifyLocalPngs(previewManifest);
  const plan = buildDirectorPreviewImportPlan(previewManifest, sourceManifest);

  if (!apply) {
    process.stdout.write(JSON.stringify({
      mode: "dry-run",
      manifest: path.relative(workspaceRoot, manifestPath),
      previewCount: plan.media.length,
      assetMediaUpserts: plan.media.length,
      renditionRepairsRequired: plan.media.length * 2,
      descriptionUpdates: plan.descriptions.length,
      writes: 0,
      note: "Validated existing local PNGs and TOS keys only. No database or TOS call was made.",
    }, null, 2) + "\n");
    return;
  }

  // Keep configuration and database imports behind the explicit write switch:
  // dry-run is usable on a renderer machine without database credentials.
  const [{ createDatabase }, { settings }] = await Promise.all([
    import("../src/db/client.js"),
    import("../src/config/env.js"),
  ]);
  if (!settings.databaseUrl) throw new Error("--apply requires DATABASE_URL or complete POSTGRES_* configuration");
  const handle = createDatabase();
  try {
    await applyDirectorPreviewImportPlan(handle.db, plan);
    process.stdout.write(JSON.stringify({
      mode: "apply",
      previewCount: plan.media.length,
      assetMediaUpserts: plan.media.length,
      renditionRepairsRequired: plan.media.length * 2,
      descriptionUpdates: plan.descriptions.length,
      tosUploads: 0,
    }, null, 2) + "\n");
  } finally {
    await handle.pool.end();
  }
}

async function verifyLocalPngs(manifest: DirectorPreviewManifest): Promise<void> {
  for (const preview of manifest.previews) {
    const localPath = resolveLocalPngPath(preview.localFile);
    let content: Buffer;
    try {
      content = await readFile(localPath);
    } catch {
      throw new Error(`Preview PNG is missing: ${preview.localFile}`);
    }
    await verifyDirectorPreviewPng(content, preview);
  }
}

function resolveManifestPath(value: string): string {
  const resolved = path.resolve(workspaceRoot, value);
  if (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error("--manifest must stay inside the workspace");
  }
  return resolved;
}

function resolveLocalPngPath(value: string): string {
  const resolved = path.resolve(workspaceRoot, value);
  if (resolved === workspaceRoot || !resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`Preview localFile must stay inside the workspace: ${value}`);
  }
  return resolved;
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Director preview import failed"}\n`);
  process.exitCode = 1;
});
