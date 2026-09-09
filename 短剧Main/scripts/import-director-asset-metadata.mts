import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../src/db/client.js";
import { settings } from "../src/config/env.js";
import {
  applyDirectorAssetImportPlan,
  buildDirectorAssetImportPlan,
  summarizeDirectorAssetDryRun,
  validateDirectorManifest,
  validateKimiDirectorUploadReceipt,
} from "../src/modules/assets/directorManifestImport.js";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(workspaceRoot, "assets/director/manifest.json");
const receiptPath = path.join(workspaceRoot, "docs/validation/v0.1.1-kimi-director-handoff.md");
const apply = process.argv.slice(2).includes("--apply");
const pending = process.argv.slice(2).includes("--pending");
const reviewerUserId = readOption("--reviewer-user-id");

async function main(): Promise<void> {
  const [manifestText, receiptText] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(receiptPath, "utf8"),
  ]);
  validateKimiDirectorUploadReceipt(receiptText);
  const manifest: unknown = JSON.parse(manifestText);
  validateDirectorManifest(manifest);
  const summary = summarizeDirectorAssetDryRun(manifest);

  if (!apply) {
    process.stdout.write(JSON.stringify({
      mode: "dry-run",
      total: summary.total,
      typeDistribution: summary.typeDistribution,
      unrecognized: summary.unrecognized,
      bucket: settings.tosBucket ?? null,
      reviewerRequiredForApply: true,
      reviewerUserIdProvided: Boolean(reviewerUserId),
      writes: 0,
      note: "No database or TOS call was made. Unknown paths block --apply. Re-run with --apply only after explicit authorization.",
    }, null, 2) + "\n");
    return;
  }

  if (!settings.databaseUrl) throw new Error("--apply requires DATABASE_URL or complete POSTGRES_* configuration");
  if (!settings.tosBucket || !settings.tosPublicBaseUrl) {
    throw new Error("--apply requires TOS_BUCKET and TOS_PUBLIC_BASE_URL");
  }
  if (summary.unrecognized.length) {
    throw new Error(`--apply blocked: ${summary.unrecognized.length} manifest path(s) are not classified`);
  }
  if (!reviewerUserId || !isUuid(reviewerUserId)) {
    throw new Error("--apply requires --reviewer-user-id <uuid> for the review audit record");
  }
  const plan = buildDirectorAssetImportPlan(manifest, {
    bucket: settings.tosBucket,
    publicBaseUrl: settings.tosPublicBaseUrl,
    receiptAcceptedAt: "2026-07-20T00:00:00.000Z",
    reviewState: pending ? "pending" : "approved",
    reviewerUserId,
  });
  const handle = createDatabase();
  try {
    await applyDirectorAssetImportPlan(handle.db, plan);
    process.stdout.write(JSON.stringify({
      mode: "apply",
      reviewState: pending ? "pending_review" : "approved",
      assetCount: plan.assets.length,
      mediaCount: plan.assets.length,
      reviewActionCount: plan.assets.filter((item) => item.auditAction).length,
      upserts: plan.assets.length * 3 + 1,
    }, null, 2) + "\n");
  } finally {
    await handle.pool.end();
  }
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Director asset metadata import failed"}\n`);
  process.exitCode = 1;
});
