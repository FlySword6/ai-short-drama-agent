import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import {
  assetEntities,
  assetMedia,
  assetVariants,
  episodes,
  mediaResults,
  projects,
  shots,
  users,
} from "../src/db/schema.js";
import { AssetCopyRepository } from "../src/modules/assets/copyRepository.js";
import { AssetCatalogService } from "../src/modules/assets/catalog.js";
import { AssetEntityRepository } from "../src/repositories/assetEntityRepository.js";
import { DrizzleDeliveryRepository } from "../src/modules/delivery/repository.js";
import { ShotMediaRepository } from "../src/modules/shot-media/repository.js";
import { GenerationError } from "../src/modules/generation/errors.js";
import { PostgresGenerationRepository } from "../src/modules/generation/repository.js";
import { ForbiddenError } from "../src/shared/errors.js";

const databaseUrl = process.env.LAUNCH_A_TEST_DATABASE_URL;

test("launch A: PostgreSQL imports approved personal copies and registers one asset-backed shot primary", {
  skip: !databaseUrl,
}, async () => withLaunchFixture(async (fixture) => {
  const now = new Date("2026-07-22T00:00:00.000Z");
  const {
    handle, actorId, otherUserId, sourceAssetId, sourceMediaIds, shotId, otherPersonalMediaId,
    firstFrameAssetId, firstFrameVideoAssetId, glbAssetId, audioAssetId,
    firstFrameMediaId, firstFrameVideoMediaId, glbMediaId, audioMediaId,
  } = fixture;
  const copyRepository = new AssetCopyRepository(handle.db);
  const generationRepository = new PostgresGenerationRepository(handle.db, 5_000);
  const nullUsageReference = await generationRepository.resolveControlReferenceSnapshots(actorId, "video", {
    referenceMediaIds: [sourceMediaIds[0]],
  });
  assert.deepEqual(nullUsageReference.map((item) => item.role), ["reference_image"]);
  await handle.db.update(assetEntities).set({
    role: "character_identity",
    usageMode: "reference",
  }).where(eq(assetEntities.id, sourceAssetId));

  await handle.db.insert(assetEntities).values([
    { ...assetValues(firstFrameAssetId, actorId, "personal", "首帧", now), usageMode: "first_frame" },
    { ...assetValues(firstFrameVideoAssetId, actorId, "personal", "错误首帧视频", now), usageMode: "first_frame" },
    { ...assetValues(glbAssetId, actorId, "personal", "导演台模型", now), usageMode: "reference" },
    { ...assetValues(audioAssetId, actorId, "personal", "声音参考", now), usageMode: "reference" },
  ]);
  await handle.db.insert(assetMedia).values([
    mediaValues(firstFrameMediaId, firstFrameAssetId, null, now),
    { ...mediaValues(firstFrameVideoMediaId, firstFrameVideoAssetId, null, now), mediaKind: "video", format: "mp4" },
    {
      ...mediaValues(glbMediaId, glbAssetId, null, now),
      mediaKind: "image",
      format: null,
      storagePath: "director/rig.bin",
      storageUrl: "https://assets.test/director/rig.glb?signature=test",
      metadata: { mime_type: "model/gltf-binary" },
    },
    {
      ...mediaValues(audioMediaId, audioAssetId, null, now),
      mediaKind: "audio",
      format: "mp3",
      storagePath: `common/${audioMediaId}.mp3`,
      storageUrl: `https://assets.test/common/${audioMediaId}.mp3`,
    },
  ]);
  const firstFrame = await generationRepository.resolveControlReferenceSnapshots(actorId, "video", {
    referenceMediaIds: [],
    firstFrameMediaId,
  });
  assert.equal(firstFrame[0]?.role, "first_frame");
  await assert.rejects(
    () => generationRepository.resolveControlReferenceSnapshots(actorId, "video", {
      referenceMediaIds: [],
      firstFrameMediaId: firstFrameVideoMediaId,
    }),
    (error: unknown) => error instanceof GenerationError
      && error.statusCode === 422
      && error.message.includes("首帧和尾帧资产必须是图片"),
  );
  await assert.rejects(
    () => generationRepository.resolveControlReferenceSnapshots(actorId, "video", {
      referenceMediaIds: [glbMediaId],
    }),
    (error: unknown) => error instanceof GenerationError
      && error.statusCode === 422
      && error.message.includes("3D 素模"),
  );
  await assert.rejects(
    () => generationRepository.resolveControlReferenceSnapshots(actorId, "video", {
      referenceMediaIds: [audioMediaId],
    }),
    (error: unknown) => error instanceof GenerationError
      && error.statusCode === 422
      && error.message.includes("音频不能放进本版全能参考集"),
  );
  await assert.rejects(
    () => generationRepository.resolveControlReferenceSnapshots(actorId, "video", {
      referenceMediaIds: [otherPersonalMediaId],
    }),
    (error: unknown) => error instanceof ForbiddenError
      && error.statusCode === 403
      && error.code === "forbidden",
  );
  const [first, retry] = await Promise.all([
    copyRepository.copyCommonToPersonal(actorId, sourceAssetId),
    copyRepository.copyCommonToPersonal(actorId, sourceAssetId),
  ]);

  assert.equal(first.assetId, retry.assetId);
  assert.equal(Number(first.created) + Number(retry.created), 1);
  assert.equal(first.copiedVariantCount, 1);
  assert.equal(first.copiedMediaCount, 2);

  const [copy] = await handle.db.select().from(assetEntities).where(eq(assetEntities.id, first.assetId));
  assert.ok(copy);
  assert.equal(copy.status, "approved");
  assert.equal(copy.approved, true);
  assert.equal(copy.role, "character_identity");
  assert.equal(copy.usageMode, "reference");
  const catalog = new AssetCatalogService(handle.db);
  const reclassified = await catalog.update(actorId, first.assetId, {
    role: "motion",
    usageMode: "reference",
  });
  assert.equal(reclassified.role, "motion");
  assert.equal(reclassified.usageMode, "reference");
  const [persistedReclassification] = await handle.db.select({
    role: assetEntities.role,
    usageMode: assetEntities.usageMode,
  }).from(assetEntities).where(eq(assetEntities.id, first.assetId));
  assert.deepEqual(persistedReclassification, { role: "motion", usageMode: "reference" });
  const entityRepository = new AssetEntityRepository(handle.db);
  const currentEntity = entityRepository.toData((await handle.db.select().from(assetEntities)
    .where(eq(assetEntities.id, first.assetId)).limit(1))[0]!);
  const { role: _role, usageMode: _usageMode, ...legacyReingest } = currentEntity;
  const preserved = await entityRepository.save(legacyReingest);
  assert.deepEqual(
    { role: preserved.role, usageMode: preserved.usageMode },
    { role: "motion", usageMode: "reference" },
  );
  const copyVariants = await handle.db.select().from(assetVariants)
    .where(eq(assetVariants.assetEntityId, first.assetId));
  assert.equal(copyVariants.length, 1);
  assert.equal(copyVariants[0]?.status, "approved");
  assert.equal(copyVariants[0]?.approved, true);
  const copyMedia = await handle.db.select().from(assetMedia).where(or(
    eq(assetMedia.assetEntityId, first.assetId),
    inArray(assetMedia.assetVariantId, copyVariants.map((row) => row.id)),
  ));
  assert.equal(copyMedia.length, 2);
  assert.equal(copyMedia.every((row) => row.approved === true), true);
  assert.deepEqual(
    copyMedia.map((row) => [row.storageBucket, row.storagePath, row.storageUrl]).sort(),
    sourceMediaIds.map((id) => [
      "launch-a-bucket",
      `common/${id}.png`,
      `https://assets.test/common/${id}.png`,
    ]).sort(),
  );

  const entityMedia = copyMedia.find((row) => row.assetEntityId === first.assetId);
  assert.ok(entityMedia);
  const shotMedia = new ShotMediaRepository(handle.db);
  const [registered, replayed] = await Promise.all([
    shotMedia.registerAssetMediaAsPrimary(actorId, shotId, entityMedia.id),
    shotMedia.registerAssetMediaAsPrimary(actorId, shotId, entityMedia.id),
  ]);
  assert.equal(registered.selectedMediaResultId, replayed.selectedMediaResultId);
  assert.equal(Number(registered.created) + Number(replayed.created), 1);

  const registeredRows = await handle.db.select().from(mediaResults).where(and(
    eq(mediaResults.shotId, shotId),
    eq(mediaResults.sourceAssetMediaId, entityMedia.id),
    isNull(mediaResults.deletedAt),
  ));
  assert.equal(registeredRows.length, 1);
  const canonical = registeredRows[0]!;
  assert.equal(canonical.originKind, "asset_media");
  assert.equal(canonical.requestId, null);
  assert.equal(canonical.attemptId, null);
  assert.equal(canonical.providerResultKey, null);
  assert.equal(canonical.registeredByUserId, actorId);
  assert.deepEqual(
    [canonical.storageBucket, canonical.storagePath, canonical.storageUrl, canonical.sha256],
    [entityMedia.storageBucket, entityMedia.storagePath, entityMedia.storageUrl, entityMedia.sha256],
  );

  const [shot] = await handle.db.select().from(shots).where(eq(shots.id, shotId));
  assert.equal(shot?.selectedImageResultId, canonical.id);
  const listed = await shotMedia.list(actorId, shotId);
  const listedRegistration = listed.items.find((item) => item.media.id === canonical.id);
  assert.ok(listedRegistration);
  assert.equal(listedRegistration.provider, null);
  assert.equal(listedRegistration.attemptStatus, null);

  const delivery = new DrizzleDeliveryRepository(handle.db);
  const source = await delivery.loadEpisode(actorId, fixture.episodeId);
  const delivered = source.media.find((item) => item.mediaId === canonical.id);
  assert.ok(delivered);
  assert.equal(delivered.originKind, "asset_media");
  assert.equal(delivered.generationRequestId, null);
  assert.equal(delivered.estimatedCostFen, 0);
  const download = await delivery.getDownload(actorId, canonical.id);
  assert.equal(download.storagePath, entityMedia.storagePath);

  await assert.rejects(
    shotMedia.registerAssetMediaAsPrimary(actorId, shotId, otherPersonalMediaId),
    (error: unknown) => error instanceof Error && error.name === "ForbiddenError",
  );
  await assert.rejects(
    shotMedia.registerAssetMediaAsPrimary(otherUserId, shotId, entityMedia.id),
    (error: unknown) => error instanceof Error && error.name === "ForbiddenError",
  );
}));

interface LaunchFixture {
  handle: DatabaseHandle;
  actorId: string;
  otherUserId: string;
  sourceAssetId: string;
  sourceVariantId: string;
  sourceMediaIds: [string, string];
  otherPersonalAssetId: string;
  otherPersonalMediaId: string;
  projectId: string;
  episodeId: string;
  shotId: string;
  firstFrameAssetId: string;
  firstFrameVideoAssetId: string;
  glbAssetId: string;
  audioAssetId: string;
  firstFrameMediaId: string;
  firstFrameVideoMediaId: string;
  glbMediaId: string;
  audioMediaId: string;
}

async function withLaunchFixture(run: (fixture: LaunchFixture) => Promise<void>): Promise<void> {
  assert.ok(databaseUrl);
  const handle = createDatabase(databaseUrl);
  const fixture: LaunchFixture = {
    handle,
    actorId: randomUUID(),
    otherUserId: randomUUID(),
    sourceAssetId: randomUUID(),
    sourceVariantId: randomUUID(),
    sourceMediaIds: [randomUUID(), randomUUID()],
    otherPersonalAssetId: randomUUID(),
    otherPersonalMediaId: randomUUID(),
    projectId: randomUUID(),
    episodeId: randomUUID(),
    shotId: randomUUID(),
    firstFrameAssetId: randomUUID(),
    firstFrameVideoAssetId: randomUUID(),
    glbAssetId: randomUUID(),
    audioAssetId: randomUUID(),
    firstFrameMediaId: randomUUID(),
    firstFrameVideoMediaId: randomUUID(),
    glbMediaId: randomUUID(),
    audioMediaId: randomUUID(),
  };
  const now = new Date("2026-07-22T00:00:00.000Z");
  try {
    await handle.db.insert(users).values([
      userValues(fixture.actorId, "launch-a-actor", now),
      userValues(fixture.otherUserId, "launch-a-other", now),
    ]);
    await handle.db.insert(projects).values({
      id: fixture.projectId,
      ownerUserId: fixture.actorId,
      name: `Launch A ${fixture.projectId.slice(0, 8)}`,
      description: null,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(episodes).values({
      id: fixture.episodeId,
      projectId: fixture.projectId,
      episodeNo: 1,
      name: "第一集",
      sortOrder: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(shots).values({
      id: fixture.shotId,
      episodeId: fixture.episodeId,
      sceneId: null,
      shotCode: "A01",
      title: "宫格图登记",
      scriptText: null,
      directorPrompt: null,
      imagePrompt: null,
      videoPrompt: null,
      durationSeconds: null,
      sortOrder: 0,
      referenceAssetSnapshots: [],
      selectedImageResultId: null,
      selectedVideoResultId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(assetEntities).values([
      assetValues(fixture.sourceAssetId, null, "common", "采购宫格源", now),
      assetValues(fixture.otherPersonalAssetId, fixture.otherUserId, "personal", "他人私有图", now),
    ]);
    await handle.db.insert(assetVariants).values({
      id: fixture.sourceVariantId,
      assetEntityId: fixture.sourceAssetId,
      variantKind: "turnaround",
      name: "转面",
      description: null,
      usageContext: null,
      visualPrompt: null,
      approved: true,
      status: "approved",
      isPrimary: true,
      sortOrder: 0,
      sourceFileUrl: null,
      sourceText: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      deletedByUserId: null,
    });
    await handle.db.insert(assetMedia).values([
      mediaValues(fixture.sourceMediaIds[0], fixture.sourceAssetId, null, now),
      mediaValues(fixture.sourceMediaIds[1], null, fixture.sourceVariantId, now),
      mediaValues(fixture.otherPersonalMediaId, fixture.otherPersonalAssetId, null, now),
    ]);

    await run(fixture);
  } finally {
    await handle.db.update(shots).set({
      selectedImageResultId: null,
      selectedVideoResultId: null,
    }).where(eq(shots.id, fixture.shotId)).catch(() => undefined);
    await handle.db.delete(mediaResults).where(eq(mediaResults.shotId, fixture.shotId)).catch(() => undefined);

    const copies = await handle.db.select({ id: assetEntities.id }).from(assetEntities)
      .where(eq(assetEntities.copiedFromAssetEntityId, fixture.sourceAssetId)).catch(() => []);
    const copyIds = copies.map((row) => row.id);
    const copyVariants = copyIds.length
      ? await handle.db.select({ id: assetVariants.id }).from(assetVariants)
        .where(inArray(assetVariants.assetEntityId, copyIds)).catch(() => [])
      : [];
    const copyVariantIds = copyVariants.map((row) => row.id);
    if (copyIds.length || copyVariantIds.length) {
      const conditions = [
        ...(copyIds.length ? [inArray(assetMedia.assetEntityId, copyIds)] : []),
        ...(copyVariantIds.length ? [inArray(assetMedia.assetVariantId, copyVariantIds)] : []),
      ];
      if (conditions.length) await handle.db.delete(assetMedia).where(or(...conditions)).catch(() => undefined);
    }
    if (copyVariantIds.length) {
      await handle.db.delete(assetVariants).where(inArray(assetVariants.id, copyVariantIds)).catch(() => undefined);
    }
    if (copyIds.length) {
      await handle.db.delete(assetEntities).where(inArray(assetEntities.id, copyIds)).catch(() => undefined);
    }
    await handle.db.delete(assetMedia).where(inArray(assetMedia.id, [
      ...fixture.sourceMediaIds,
      fixture.otherPersonalMediaId,
      fixture.firstFrameMediaId,
      fixture.firstFrameVideoMediaId,
      fixture.glbMediaId,
      fixture.audioMediaId,
    ])).catch(() => undefined);
    await handle.db.delete(assetVariants).where(eq(assetVariants.id, fixture.sourceVariantId)).catch(() => undefined);
    await handle.db.delete(assetEntities).where(inArray(assetEntities.id, [
      fixture.otherPersonalAssetId,
      fixture.sourceAssetId,
      fixture.firstFrameAssetId,
      fixture.firstFrameVideoAssetId,
      fixture.glbAssetId,
      fixture.audioAssetId,
    ])).catch(() => undefined);
    await handle.db.delete(shots).where(eq(shots.id, fixture.shotId)).catch(() => undefined);
    await handle.db.delete(episodes).where(eq(episodes.id, fixture.episodeId)).catch(() => undefined);
    await handle.db.delete(projects).where(eq(projects.id, fixture.projectId)).catch(() => undefined);
    await handle.db.delete(users).where(inArray(users.id, [fixture.actorId, fixture.otherUserId])).catch(() => undefined);
    await handle.pool.end();
  }
}

function userValues(id: string, prefix: string, now: Date) {
  return {
    id,
    username: `${prefix}-${id.slice(0, 8)}`,
    displayName: prefix,
    passwordHash: "test-only-hash",
    active: true,
    createdAt: now,
    updatedAt: now,
  };
}

function assetValues(
  id: string,
  ownerUserId: string | null,
  visibility: "personal" | "common",
  name: string,
  now: Date,
) {
  return {
    id,
    copiedFromAssetEntityId: null,
    sourceProjectId: null,
    sourceProjectName: null,
    ownerUserId,
    visibility,
    assetKind: "keyframe",
    name,
    displayName: name,
    intro: null,
    appearance: null,
    ageValue: null,
    gender: null,
    heightCm: null,
    hairDescription: null,
    outfitDescription: null,
    category: null,
    styleTags: [],
    approved: true,
    reuseScope: "all_projects",
    status: "approved",
    sourceFileUrl: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    useCount: 0,
    deletedAt: null,
    deletedByUserId: null,
  };
}

function mediaValues(
  id: string,
  assetEntityId: string | null,
  assetVariantId: string | null,
  now: Date,
) {
  return {
    id,
    assetEntityId,
    assetVariantId,
    mediaKind: "image",
    viewAngle: "front",
    title: "宫格图",
    description: null,
    storageBucket: "launch-a-bucket",
    storagePath: `common/${id}.png`,
    storageUrl: `https://assets.test/common/${id}.png`,
    widthPx: 1024,
    heightPx: 1024,
    format: "png",
    sha256: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    isPrimary: true,
    approved: true,
    sortOrder: 0,
    metadata: {},
    createdAt: now,
    deletedAt: null,
    deletedByUserId: null,
  };
}
