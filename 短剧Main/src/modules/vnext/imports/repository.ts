import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "../../../db/client.js";
import type {
  SnapshotAImportInput,
  SnapshotAssetView,
  SnapshotRegistrationReadback,
  SnapshotRegistrationStatus,
} from "./service.js";
import { transportFailure } from "./failures.js";

const LIBRARY_ID = "00000000-0000-0000-0000-000000000309";

export class SnapshotAImportRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<SnapshotAssetView[]> {
    const result = await this.db.execute<SnapshotAssetRow>(assetSelect(sql`
      FROM vnext.imported_assets a
      JOIN vnext.asset_libraries l ON l.id=a.library_id
      JOIN vnext.import_source_mappings m ON m.imported_asset_id=a.id
      WHERE a.library_id=${LIBRARY_ID}::uuid
      ORDER BY a.created_at DESC, a.id DESC`));
    return result.rows.map(toView);
  }

  async find(assetId: string, database: Database = this.db): Promise<SnapshotAssetView | undefined> {
    const result = await database.execute<SnapshotAssetRow>(assetSelect(sql`
      FROM vnext.imported_assets a
      JOIN vnext.asset_libraries l ON l.id=a.library_id
      JOIN vnext.import_source_mappings m ON m.imported_asset_id=a.id
      WHERE a.id=${assetId}::uuid`));
    return result.rows[0] ? toView(result.rows[0]) : undefined;
  }

  async findBySource(sourceSystem: string, sourceId: string, database: Database = this.db, forUpdate = false): Promise<SnapshotAssetView | undefined> {
    const result = await database.execute<SnapshotAssetRow>(assetSelect(sql`
      FROM vnext.import_source_mappings m
      JOIN vnext.imported_assets a ON a.id=m.imported_asset_id
      JOIN vnext.asset_libraries l ON l.id=a.library_id
      WHERE m.source_system=${sourceSystem} AND m.source_id=${sourceId}
      ${forUpdate ? sql`FOR UPDATE OF a` : sql``}`));
    return result.rows[0] ? toView(result.rows[0]) : undefined;
  }

  async approvedFactsMatch(input: SnapshotAImportInput): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1 FROM vnext.import_source_approvals
      WHERE source_system=${input.sourceSystem} AND source_id=${input.sourceId}
        AND media_sha256=${input.mediaSha256.toLowerCase()}
        AND asset_kind=${input.assetKind} AND media_kind=${input.mediaKind}
        AND name=${input.name} AND snapshot_version=${input.snapshotVersion}
        AND source_snapshot_at=${new Date(input.snapshotAt)}
        AND approved IS TRUE AND is_human IS FALSE`);
    return Boolean(result.rows[0]);
  }

  async createAsset(input: SnapshotAImportInput): Promise<{ asset: SnapshotAssetView; outcome: "created" | "replayed" }> {
    return this.db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      await database.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.sourceSystem}:${input.sourceId}`}, 0))`);
      const existing = await this.findBySource(input.sourceSystem, input.sourceId, database, true);
      if (existing) return { asset: existing, outcome: "replayed" as const };
      const id = randomUUID();
      await database.execute(sql`
        INSERT INTO vnext.imported_assets (
          id, library_id, asset_kind, media_kind, name, media_url, media_sha256, snapshot_version, snapshot_at, review_status, registration_status
        ) VALUES (
          ${id}::uuid, ${LIBRARY_ID}::uuid, ${input.assetKind}, ${input.mediaKind}, ${input.name}, ${input.mediaUrl},
          ${input.mediaSha256.toLowerCase()}, ${input.snapshotVersion}, ${new Date(input.snapshotAt)}, 'approved', 'not_required'
        )`);
      await database.execute(sql`
        INSERT INTO vnext.import_source_mappings (id, imported_asset_id, source_system, source_id, media_sha256, source_snapshot_at)
        VALUES (${randomUUID()}::uuid, ${id}::uuid, ${input.sourceSystem}, ${input.sourceId}, ${input.mediaSha256.toLowerCase()}, ${new Date(input.snapshotAt)})`);
      return { asset: requireAsset(await this.find(id, database)), outcome: "created" as const };
    });
  }

  async claimRegistration(assetId: string, expectedStatus: SnapshotRegistrationStatus): Promise<boolean> {
    const claim = await this.db.execute(sql`
      UPDATE vnext.imported_assets SET registration_status='pending', updated_at=now()
      WHERE id=${assetId}::uuid AND registration_status=${expectedStatus}
      RETURNING id`);
    return Boolean(claim.rows[0]);
  }

  async persistRegistration(assetId: string, result: SnapshotRegistrationReadback, action: "register" | "readback", expectedStatus?: SnapshotRegistrationStatus): Promise<SnapshotAssetView> {
    const failureReason = result.failureReason?.slice(0, 255) ?? null;
    const readbackPayload = JSON.stringify(result.readback ?? null);
    return this.db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      const update = await database.execute(sql`
        UPDATE vnext.imported_assets
        SET registration_status=${result.status}, registration_id=${result.registrationId},
            registration_failure_code=${result.failureCode ?? null}, registration_failure_reason=${failureReason},
            registration_readback=${readbackPayload}::jsonb, updated_at=now()
        WHERE id=${assetId}::uuid ${expectedStatus ? sql`AND registration_status=${expectedStatus}` : sql``}
        RETURNING id`);
      if (!update.rows[0]) return requireAsset(await this.find(assetId, database));
      await database.execute(sql`
        INSERT INTO vnext.import_registration_attempts (id, imported_asset_id, action, outcome, registration_id, failure_code, failure_reason, readback)
        VALUES (${randomUUID()}::uuid, ${assetId}::uuid, ${action}, ${result.status}, ${result.registrationId},
          ${result.failureCode ?? null}, ${failureReason}, ${readbackPayload}::jsonb)`);
      return requireAsset(await this.find(assetId, database));
    });
  }
  async reconcileUnknownRegistration(assetId: string, readback: () => Promise<SnapshotRegistrationReadback>): Promise<{ asset: SnapshotAssetView; claimed: boolean }> {
    return this.db.transaction(async (tx) => {
      const database = tx as unknown as Database;
      await database.execute(sql`SELECT id FROM vnext.imported_assets WHERE id=${assetId}::uuid FOR UPDATE`);
      const update = await database.execute(sql`
        UPDATE vnext.imported_assets SET registration_status='pending', updated_at=now()
        WHERE id=${assetId}::uuid AND registration_status='unknown'
        RETURNING id`);
      if (!update.rows[0]) return { asset: requireAsset(await this.find(assetId, database)), claimed: false };
      let result: SnapshotRegistrationReadback;
      try {
        result = await readback();
      } catch {
        result = transportFailure(null);
      }
      const failureReason = result.failureReason?.slice(0, 255) ?? null;
      const readbackPayload = JSON.stringify(result.readback ?? null);
      await database.execute(sql`
        UPDATE vnext.imported_assets
        SET registration_status=${result.status}, registration_id=${result.registrationId},
            registration_failure_code=${result.failureCode ?? null}, registration_failure_reason=${failureReason},
            registration_readback=${readbackPayload}::jsonb, updated_at=now()
        WHERE id=${assetId}::uuid AND registration_status='pending'`);
      await database.execute(sql`
        INSERT INTO vnext.import_registration_attempts (id, imported_asset_id, action, outcome, registration_id, failure_code, failure_reason, readback)
        VALUES (${randomUUID()}::uuid, ${assetId}::uuid, 'readback', ${result.status}, ${result.registrationId},
          ${result.failureCode ?? null}, ${failureReason}, ${readbackPayload}::jsonb)`);
      return { asset: requireAsset(await this.find(assetId, database)), claimed: true };
    });
  }
  async setRegistrationUnavailable(assetId: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE vnext.imported_assets
      SET registration_status='failed', registration_failure_code='snapshot_registration_unavailable',
          registration_failure_reason='火山素材注册尚未开启，未发送任何请求', updated_at=now()
      WHERE id=${assetId}::uuid AND registration_status='not_required'`);
  }

  async recordVerification(input: SnapshotAImportInput, outcome: "verified" | "failed", failureCode: string | null = null, failureReason: string | null = null): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO vnext.import_verification_attempts (id, source_system, source_id, media_url, outcome, failure_code, failure_reason)
      VALUES (${randomUUID()}::uuid, ${input.sourceSystem}, ${input.sourceId}, ${input.mediaUrl}, ${outcome}, ${failureCode}, ${failureReason?.slice(0, 255) ?? null})`);
  }
}

type SnapshotAssetRow = {
  id: string; library_name: string; source_system: string; source_id: string; name: string;
  asset_kind: SnapshotAssetView["assetKind"]; media_kind: SnapshotAssetView["mediaKind"]; media_url: string; media_sha256: string;
  snapshot_at: Date; snapshot_version: string; review_status: SnapshotAssetView["reviewStatus"];
  registration_status: SnapshotRegistrationStatus; registration_id: string | null; registration_failure_code: string | null;
  registration_failure_reason: string | null; registration_readback: Record<string, unknown> | null; updated_at: Date;
};

function assetSelect(tail: SQL): SQL {
  return sql`SELECT a.id, l.name AS library_name, m.source_system, m.source_id, a.name, a.asset_kind, a.media_kind,
    a.media_url, a.media_sha256, a.snapshot_at, a.snapshot_version, a.review_status, a.registration_status,
    a.registration_id, a.registration_failure_code, a.registration_failure_reason, a.registration_readback, a.updated_at
    ${tail}`;
}

function toView(row: SnapshotAssetRow): SnapshotAssetView {
  return {
    id: row.id, libraryName: row.library_name, sourceSystem: row.source_system, sourceId: row.source_id, name: row.name,
    assetKind: row.asset_kind, mediaKind: row.media_kind, mediaUrl: row.media_url, mediaSha256: row.media_sha256,
    snapshotAt: row.snapshot_at instanceof Date ? row.snapshot_at : new Date(row.snapshot_at), snapshotVersion: row.snapshot_version, reviewStatus: row.review_status,
    registrationStatus: row.registration_status, registrationId: row.registration_id,
    registrationFailureCode: row.registration_failure_code, registrationFailureReason: row.registration_failure_reason,
    registrationReadback: row.registration_readback, updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at),
  };
}
function requireAsset(asset: SnapshotAssetView | undefined): SnapshotAssetView {
  if (!asset) throw new Error("Snapshot asset disappeared during persistence");
  return asset;
}
