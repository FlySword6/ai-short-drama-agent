import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../db/client.js";
import {
  mediaProvenanceSubjects,
  mediaResults,
  mediaReviewActions,
} from "../../db/schema.js";
import { PostgresGenerationRepository } from "./repository.js";
import type { StoredGenerationMedia } from "./types.js";

/* happyhorse 预览集成 §2.2:saveMediaResult 把 StoredGenerationMedia.preview 转录进
   media_results.metadata.preview;schema 默认 {} 口径下显式写空对象。
   onConflictDoUpdate 不碰 metadata——恢复重放不得覆盖用户后写的 shot_version。 */

const attemptId = "attempt-preview-1";
const requestId = "request-preview-1";

interface InsertCall {
  values: Record<string, unknown>;
  conflictSet?: Record<string, unknown>;
}

function recordingStub(): {
  db: Database;
  inserts: Map<string, InsertCall>;
} {
  const inserts = new Map<string, InsertCall>();

  const tableName = (table: { constructor?: { name?: string } } | { symbol?: unknown }): string => {
    // drizzle 表对象带 Symbol.for("drizzle:Name") 名称;直接取构造函数参数不可靠,用已知引用比对。
    if (table === mediaResults) return "media_results";
    if (table === mediaProvenanceSubjects) return "media_provenance_subjects";
    if (table === mediaReviewActions) return "media_review_actions";
    return "unknown";
  };

  const thenable = (rows: unknown[]) => ({
    then: (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve as never, reject as never),
    from: () => thenable(rows),
    innerJoin: () => thenable(rows),
    where: () => thenable(rows),
    limit: () => thenable(rows),
    for: () => thenable(rows),
    set: () => thenable(rows),
    orderBy: () => thenable(rows),
  });

  const attemptRow = {
    request: {
      id: requestId,
      projectId: "project-preview-1",
      shotId: "shot-preview-1",
      userId: "user-preview-1",
      referenceMediaIds: [],
      referenceAssetSnapshots: [],
    },
    attempt: {
      id: attemptId,
      leaseOwner: null,
      status: "pending",
      provider: "happyhorse",
      model: "happyhorse-1.1-r2v",
      priceSnapshot: {},
      providerResponse: {
        status: "succeeded",
        media: [
          {
            kind: "video",
            temporaryUrl: "https://provider.example.test/preview.mp4",
            providerResultKey: "video-0",
          },
        ],
      },
    },
  };

  const db = {
    transaction: async (body: (tx: unknown) => Promise<void>) => body(db),
    select: (...args: unknown[]) => {
      // 首次 select=attempt+request 联查;其后=project_review_policies(空表→automatic 策略)。
      const projection = args[0] as Record<string, unknown> | undefined;
      const isJoinSelect = projection !== undefined && "request" in projection && "attempt" in projection;
      return thenable(isJoinSelect ? [attemptRow] : []);
    },
    insert: (table: object) => {
      const call: InsertCall = { values: {} };
      inserts.set(tableName(table as never), call);
      const conflictResultRows = table === mediaResults
        ? [{ id: "media-result-preview-1", createdAt: new Date("2026-08-18T00:00:00Z") }]
        : table === mediaProvenanceSubjects
          ? [{ id: "subject-preview-1" }]
          : [];
      const withReturning = Object.assign(thenable(conflictResultRows), {
        returning: () => thenable(conflictResultRows),
      });
      return {
        values: (values: Record<string, unknown>) => {
          call.values = values;
          return {
            onConflictDoUpdate: (config: { set: Record<string, unknown> }) => {
              call.conflictSet = config.set;
              return withReturning;
            },
            onConflictDoNothing: () => withReturning,
            then: withReturning.then,
          };
        },
      };
    },
    update: () => ({
      set: () => ({
        where: () => Object.assign(thenable([{ id: "tos-orphan-preview-1" }]), {
          returning: () => thenable([{ id: "tos-orphan-preview-1" }]),
        }),
      }),
    }),
  } as unknown as Database;

  return { db, inserts };
}

function storedMedia(preview?: boolean): StoredGenerationMedia {
  return {
    providerResultKey: "video-0",
    mediaKind: "video",
    storageBucket: "generated-media",
    storagePath: "projects/project-preview-1/shots/shot-preview-1/video/preview-task/0.mp4",
    storageUrl: "https://tos.example.com/preview.mp4",
    sha256: "a".repeat(64),
    mimeType: "video/mp4",
    ...(preview === true ? { preview: true } : {}),
  };
}

test("预览请求落库:insert 写 metadata.preview=true,onConflict 不覆盖 metadata", async () => {
  const { db, inserts } = recordingStub();
  const repository = new PostgresGenerationRepository(db, 5_000);

  await repository.saveMediaResult(attemptId, storedMedia(true));

  const mediaInsert = inserts.get("media_results");
  assert.ok(mediaInsert, "media_results insert 应被记录");
  assert.deepEqual(mediaInsert!.values.metadata, { preview: true });
  assert.ok(
    !("metadata" in (mediaInsert!.conflictSet ?? {})),
    "恢复重放的 onConflictDoUpdate 不得覆盖用户后写的 metadata(shot_version)",
  );
});

test("非预览请求落库:metadata 显式写空对象,与 schema 默认口径一致", async () => {
  const { db, inserts } = recordingStub();
  const repository = new PostgresGenerationRepository(db, 5_000);

  await repository.saveMediaResult(attemptId, storedMedia(undefined));

  const mediaInsert = inserts.get("media_results");
  assert.ok(mediaInsert, "media_results insert 应被记录");
  assert.deepEqual(mediaInsert!.values.metadata, {});
});
