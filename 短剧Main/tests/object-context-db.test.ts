import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { settings } from "../src/config/env.js";
import { createDatabase, type DatabaseHandle } from "../src/db/client.js";
import { quoteIdentifier, renderMigrationSql } from "../src/db/migrate.js";
import {
  assetEntities,
  assetMedia,
  assetVariants,
  deliveryRecords,
  episodes,
  generationAttempts,
  generationRequests,
  mediaResults,
  projectAssetRefs,
  projectMembers,
  projectReviewPolicies,
  projects,
  providerCosts,
  scenes,
  shots,
  users,
} from "../src/db/schema.js";
import { AssetUsageService } from "../src/modules/assets/usage.js";
import { ObjectContextRepository } from "../src/modules/object-context/repository.js";
import { ObjectContextService } from "../src/modules/object-context/service.js";
import { NotFoundError } from "../src/shared/errors.js";

/**
 * R1 object-context must run against a disposable PostgreSQL schema.  These
 * assertions deliberately exercise observable response shape instead of
 * repository internals: counts, coverage, actions and revisions are all
 * potential cross-project side channels.
 */
const databaseUrl = process.env.OBJECT_CONTEXT_TEST_DATABASE_URL;
const schema = settings.postgresSchema;

test("对象上下文真 PG：权限投影、稳定分页、权威状态和付费动作出口", async (t) => {
  assert.ok(databaseUrl, "对象图 runner 必须提供一次性本地 PostgreSQL URL；本测试不得跳过");
  assertLocalDatabase(databaseUrl);
  assert.match(schema, /^object_context_[a-z0-9_]+$/);

  const handle = createDatabase(databaseUrl);
  const quoted = quoteIdentifier(schema);
  try {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
    await handle.pool.query(`CREATE SCHEMA ${quoted}`);
    await applyMigrations(handle);
    const fixture = await seedFixture(handle);
    const service = new ObjectContextService(handle.db);
    const actorA = { id: fixture.ownerA, role: "member" as const };

    await t.test("1. 无权主体统一 404", async () => {
      await assertNotFound(() => service.context(actorA, "shot", fixture.shotB, contextQuery()));
      await assertNotFound(() => service.context(actorA, "media_result", fixture.mediaB, contextQuery()));
    });

    await t.test("2/3. 通用资产可见，但隐藏项目关系插入前后整个响应完全一致", async () => {
      const before = await service.context(actorA, "asset_entity", fixture.commonAsset, contextQuery({
        projectContextId: fixture.projectA,
      }));
      await addProjectAssetRef(handle, fixture.projectB, fixture.commonAsset, fixture.ownerB, fixture.now);
      const after = await service.context(actorA, "asset_entity", fixture.commonAsset, contextQuery({
        projectContextId: fixture.projectA,
      }));
      assert.deepEqual(after, before, "隐藏关系不得改变节点、计数、coverage、next_actions 或 revision");
      assert.equal(JSON.stringify(after).includes(fixture.projectB), false, "响应不得包含隐藏项目 ID");
      assert.equal(JSON.stringify(after).includes("对象图隐藏项目 B"), false, "响应不得包含隐藏项目名称");
    });

    await t.test("4. 授权项目 A 搭配项目 B 的四种 scope/context 组合统一 404", async () => {
      await assertNotFound(() => service.productionGraph(actorA, fixture.projectA, {
        scopeKind: "project", scopeId: fixture.projectB, preset: "pipeline",
      }));
      await assertNotFound(() => service.productionGraph(actorA, fixture.projectA, {
        scopeKind: "episode", scopeId: fixture.episodeB, preset: "pipeline",
      }));
      await assertNotFound(() => service.productionGraph(actorA, fixture.projectA, {
        scopeKind: "scene", scopeId: fixture.sceneB, preset: "pipeline",
      }));
      await assertNotFound(() => service.context(actorA, "asset_entity", fixture.commonAsset, contextQuery({
        projectContextId: fixture.projectB,
      })));
    });

    await t.test("5. 同一对象的来源、使用方与动作稳定", async () => {
      const first = await service.context(actorA, "shot", fixture.shotA, contextQuery({
        projectContextId: fixture.projectA,
      }));
      const second = await service.context(actorA, "shot", fixture.shotA, contextQuery({
        projectContextId: fixture.projectA,
      }));
      assert.deepEqual(second, first);
      assert.ok(first.origin.edges.length >= 1, "分镜必须有正式来源边");
      assert.ok(first.usage.edges.length >= 1, "分镜必须有正式使用边");
      assert.ok(first.nextActions.length >= 1, "分镜必须提供下一步");
    });

    await t.test("6. 旧 usage 与新投影的已覆盖关系对账", async () => {
      const oldUsage = await new AssetUsageService(handle.db).report(actorA, fixture.commonAsset, fixture.projectA);
      const projection = await service.context(actorA, "asset_entity", fixture.commonAsset, contextQuery({
        projectContextId: fixture.projectA,
      }));
      assert.deepEqual(oldUsage.bindings.map((row) => row.projectId), [fixture.projectA]);
      assert.ok(
        projection.usage.edges.some((edge) => edge.to.kind === "project" && edge.to.id === fixture.projectA),
        "对象图必须包含旧 usage 已覆盖的项目资产引用",
      );
      assert.equal(projection.usage.edges.some((edge) => edge.to.id === fixture.projectB), false);
    });

    await t.test("7. usage 503 条分页无重复、无遗漏，也不硬截 500", async () => {
      const startedAt = performance.now();
      const all = new Set<string>();
      let cursor: string | undefined;
      do {
        const response = await service.context(actorA, "asset_entity", fixture.bulkAsset, contextQuery({
          usageCursor: cursor,
          usagePageSize: 97,
          projectContextId: fixture.projectA,
        }));
        for (const edge of response.usage.edges) {
          assert.equal(all.has(edge.id), false, `重复 usage edge: ${edge.id}`);
          all.add(edge.id);
        }
        cursor = response.usage.nextCursor ?? undefined;
      } while (cursor);
      assert.equal(all.size, 503, "503 条可见关系必须全部读出，不能复制旧接口的 500 截断");
      assert.ok(
        performance.now() - startedAt < 10_000,
        "503 条边必须批量做权限解析，不能退化为逐边 N+1 查询",
      );
    });

    await t.test("8. 审核状态与实际成本只读权威字段", async () => {
      const result = await service.context(actorA, "media_result", fixture.mediaA, contextQuery({
        projectContextId: fixture.projectA,
      }));
      assert.equal(result.state.review?.mediaStatus, "needs_review");
      assert.equal(result.state.providerCost?.source, "provider_costs");
      assert.equal(result.state.providerCost?.costCnyMicros, 123_456);
      assert.equal(result.state.providerCost?.requiresAttention, true);

      const reviewerResult = await service.context(
        { id: fixture.reviewerA, role: "member" },
        "media_result",
        fixture.mediaA,
        contextQuery({ projectContextId: fixture.projectA }),
      );
      const reviewAction = reviewerResult.nextActions.find((action) => action.key === "review_media_result");
      const selectAction = reviewerResult.nextActions.find((action) => action.key === "select_primary_media");
      assert.equal(reviewAction?.enabled, true, "项目指定审核人即使是 viewer 也必须能审核");
      assert.equal(reviewAction?.invocation?.kind, "existing_api");
      assert.equal(selectAction?.enabled, false, "指定审核人不能借审核身份获得项目编辑权限");
      assert.equal(reviewerResult.state.providerCost, undefined, "viewer 不得读取供应商成本");

      for (const actor of [
        { id: fixture.editorA, role: "member" as const },
        { id: fixture.adminA, role: "admin" as const },
        { id: fixture.operatorA, role: "operator" as const },
      ]) {
        const visible = await service.context(actor, "media_result", fixture.mediaA, contextQuery({
          projectContextId: fixture.projectA,
        }));
        assert.equal(visible.state.providerCost?.costCnyMicros, 123_456);
      }

      const viewerRevision = reviewerResult.revision;
      await handle.pool.query(
        `UPDATE ${quoted}.provider_costs SET cost_cny_micros = 654321, updated_at = $2 WHERE id = $1`,
        [fixture.providerCostId, new Date("2026-07-29T01:05:00.000Z")],
      );
      const viewerAfterCostChange = await service.context(
        { id: fixture.reviewerA, role: "member" },
        "media_result",
        fixture.mediaA,
        contextQuery({ projectContextId: fixture.projectA }),
      );
      assert.equal(viewerAfterCostChange.state.providerCost, undefined);
      assert.equal(
        viewerAfterCostChange.revision,
        viewerRevision,
        "无成本权限用户的 revision 不能成为成本变动侧信道",
      );
    });

    await t.test("9. 项目引用精确授权协作者个人资产，且媒体锁不扩散", async () => {
      await assertNotFound(() => service.context(
        actorA,
        "asset_entity",
        fixture.personalAsset,
        contextQuery(),
      ));
      const entity = await service.context(
        actorA,
        "asset_entity",
        fixture.personalAsset,
        contextQuery({ projectContextId: fixture.projectA }),
      );
      assert.ok(entity.usage.edges.some((edge) => edge.to.id === fixture.personalMedia));
      assert.equal(
        entity.usage.edges.some((edge) => edge.to.id === fixture.personalSiblingMedia),
        false,
        "精确媒体锁不能扩散到同资产的其他媒体",
      );
      await service.context(
        actorA,
        "asset_media",
        fixture.personalMedia,
        contextQuery({ projectContextId: fixture.projectA }),
      );
      await assertNotFound(() => service.context(
        actorA,
        "asset_media",
        fixture.personalSiblingMedia,
        contextQuery({ projectContextId: fixture.projectA }),
      ));
    });

    await t.test("10. revision 不随 include、页大小或 cursor 改变", async () => {
      const full = await service.context(actorA, "asset_entity", fixture.bulkAsset, contextQuery({
        usagePageSize: 97,
        projectContextId: fixture.projectA,
      }));
      const smallPage = await service.context(actorA, "asset_entity", fixture.bulkAsset, {
        ...contextQuery({
          usagePageSize: 7,
          projectContextId: fixture.projectA,
        }),
        include: new Set(["usage"] as const),
      });
      const nextPage = await service.context(actorA, "asset_entity", fixture.bulkAsset, {
        ...contextQuery({
          usageCursor: smallPage.usage.nextCursor ?? undefined,
          usagePageSize: 7,
          projectContextId: fixture.projectA,
        }),
        include: new Set(["usage"] as const),
      });
      assert.equal(smallPage.revision, full.revision);
      assert.equal(nextPage.revision, full.revision);
    });

    await t.test("11. origin_depth 做有界逐层展开，正确标记截断并阻断循环", async () => {
      const depthOne = await service.context(actorA, "asset_entity", fixture.copyLeaf, {
        ...contextQuery({ originDepth: 1 }),
        include: new Set(["origin"] as const),
      });
      assert.equal(depthOne.origin.edges.length, 1);
      assert.equal(depthOne.origin.truncated, true);

      const depthTwo = await service.context(actorA, "asset_entity", fixture.copyLeaf, {
        ...contextQuery({ originDepth: 2 }),
        include: new Set(["origin"] as const),
      });
      assert.equal(depthTwo.origin.edges.length, 2);
      assert.equal(depthTwo.origin.truncated, false);

      const cycle = await service.context(actorA, "asset_entity", fixture.cycleAssetA, {
        ...contextQuery({ originDepth: 5 }),
        include: new Set(["origin"] as const),
      });
      assert.equal(cycle.origin.edges.length, 2);
      assert.equal(cycle.origin.truncated, false);
    });

    await t.test("12. 付费动作只能指向现有估价入口，绝不直接创建任务", async () => {
      const result = await service.context(actorA, "shot", fixture.shotA, contextQuery({
        projectContextId: fixture.projectA,
      }));
      const paid = result.nextActions.filter((action) => action.effect === "paid");
      assert.ok(paid.length >= 1);
      for (const action of paid) {
        assert.equal(action.invocation?.kind, "paid_quote");
        if (action.invocation?.kind === "paid_quote") {
          assert.deepEqual(
            { method: action.invocation.method, href: action.invocation.quoteHref },
            { method: "POST", href: "/api/v1/generations/estimate" },
          );
        }
      }
      assert.equal(JSON.stringify(result.nextActions).includes("/submit"), false);
      assert.equal(JSON.stringify(result.nextActions).includes("/confirm"), false);
    });

    await t.test("13. 项目生产图一次聚合，且排除权威项目冲突的产物", async () => {
      const graph = await service.productionGraph(actorA, fixture.projectA, {
        scopeKind: "project",
        preset: "pipeline",
      });
      const shotNodes = graph.nodes.filter((node) => node.subject?.kind === "shot");
      assert.equal(shotNodes.length, 3);
      assert.ok(graph.nodes.some((node) => node.subject?.id === fixture.mediaA));
      assert.equal(
        graph.nodes.some((node) => node.subject?.id === fixture.conflictingMedia),
        false,
        "request 属于项目 B 的产物不能借项目 A 的 shot 混入生产图",
      );
      const shotContext = await service.context(actorA, "shot", fixture.shotA, contextQuery({
        projectContextId: fixture.projectA,
      }));
      assert.equal(shotContext.state.execution, "succeeded");
      assert.equal(
        shotContext.usage.edges.some((edge) => edge.to.id === fixture.conflictingMedia),
        false,
        "单对象 usage 也必须使用 generation request 的权威项目",
      );
      await handle.pool.query(
        `UPDATE ${quoted}.generation_attempts
         SET status = 'running', phase = 'provider_running', provider_status = 'running',
             error_code = NULL, error_message = NULL, retryable = true,
             finished_at = NULL, updated_at = $2
         WHERE id = $1`,
        [fixture.conflictingAttempt, new Date("2026-07-29T01:10:00.000Z")],
      );
      const shotAfterHiddenAttemptChange = await service.context(
        actorA,
        "shot",
        fixture.shotA,
        contextQuery({ projectContextId: fixture.projectA }),
      );
      assert.deepEqual(
        shotAfterHiddenAttemptChange,
        shotContext,
        "隐藏项目 attempt 的状态变化不得污染分镜 state、动作或 revision",
      );
      assert.equal(new Set(graph.actions.map((action) => action.key)).size, graph.actions.length);
      const actionByKey = new Map(graph.actions.map((action) => [action.key, action]));
      for (const node of shotNodes) {
        for (const key of node.actionKeys) {
          assert.ok(actionByKey.has(key), `节点动作 ${key} 必须能在 graph.actions 中解析`);
          assert.ok(key.includes(node.subject!.id), "范围图动作键必须带主体 ID，不能跨分镜互相覆盖");
        }
      }
      for (const shotId of [fixture.shotA2, fixture.shotA3]) {
        const action = graph.actions.find((candidate) =>
          candidate.key === `shot:${shotId}:complete_control_package`,
        );
        assert.deepEqual(
          action?.invocation,
          { kind: "route", href: `/shots/${shotId}/workbench` },
        );
      }
      assert.equal(JSON.stringify(graph.actions).includes("/submit"), false);
      assert.equal(JSON.stringify(graph.actions).includes("/confirm"), false);
    });

    await t.test("14. 空场次 scope 仍保留项目、集、场上下文，不退化为项目孤点", async () => {
      const graph = await service.productionGraph(actorA, fixture.projectA, {
        scopeKind: "scene",
        scopeId: fixture.emptySceneA,
        preset: "pipeline",
      });
      assert.deepEqual(
        graph.nodes.map((node) => `${node.subject?.kind}:${node.subject?.id}`).sort(),
        [
          `project:${fixture.projectA}`,
          `episode:${fixture.episodeA}`,
          `scene:${fixture.emptySceneA}`,
        ].sort(),
      );
      assert.deepEqual(
        graph.edges.map((edge) => edge.id).sort(),
        [
          `contains:project:${fixture.projectA}:episode:${fixture.episodeA}`,
          `contains:episode:${fixture.episodeA}:scene:${fixture.emptySceneA}`,
        ].sort(),
      );
      assert.equal(graph.actions.length, 0);
    });

    await t.test("15. 多变体、多媒体、多控制包引用的资产边 ID 唯一，小页游标无重复且能走完", async () => {
      const full = await service.context(actorA, "asset_entity", fixture.multiAsset, contextQuery({
        usagePageSize: 100,
        projectContextId: fixture.projectA,
      }));
      const fullIds = full.usage.edges.map((edge) => edge.id);
      assert.equal(new Set(fullIds).size, fullIds.length, "完整投影不得包含重复 edge ID");
      for (const mediaId of fixture.multiMediaIds) {
        assert.ok(
          fullIds.includes(`contains:asset_entity:${fixture.multiAsset}:asset_media:${mediaId}`),
          `变体媒体 ${mediaId} 也必须归属到资产实体`,
        );
      }
      for (const refId of fixture.multiControlPackageRefIds) {
        assert.ok(
          fullIds.includes(`used_by:asset_entity:${fixture.multiAsset}:control_package_ref:${refId}`),
          `每一个控制包引用必须保留独立且可分页的边 ${refId}`,
        );
      }

      const pagedIds = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await service.context(actorA, "asset_entity", fixture.multiAsset, contextQuery({
          usageCursor: cursor,
          usagePageSize: 1,
          projectContextId: fixture.projectA,
        }));
        assert.equal(page.usage.edges.length, 1);
        const edge = page.usage.edges[0]!;
        assert.equal(pagedIds.has(edge.id), false, `分页不得重复边 ${edge.id}`);
        pagedIds.add(edge.id);
        cursor = page.usage.nextCursor ?? undefined;
        if (cursor) {
          assert.equal(cursors.has(cursor), false, "游标不得回到已出现的位置");
          cursors.add(cursor);
        }
      } while (cursor);
      assert.deepEqual([...pagedIds].sort(), [...fullIds].sort(), "小页游标不得遗漏任何边");
    });

    await t.test("16. request=B、shot=A 的冲突产物对项目 B 发起人也 fail-closed 为 404", async () => {
      await assertNotFound(() => service.context(
        { id: fixture.ownerB, role: "member" },
        "media_result",
        fixture.conflictingMedia,
        contextQuery({ projectContextId: fixture.projectB }),
      ));
    });

    await t.test("17. 场生产状态在真 PG 使用当前 attempt、动态 lane 分母与主视频快照", async () => {
      const inFlightRequest = randomUUID();
      const inFlightAttempt = randomUUID();
      await insertGeneration(handle, {
        requestId: inFlightRequest,
        attemptId: inFlightAttempt,
        actorId: fixture.ownerA,
        projectId: fixture.projectA,
        episodeId: fixture.episodeA,
        sceneId: fixture.sceneA,
        shotId: fixture.shotA,
        mediaKind: "video",
        now: fixture.now,
      });
      await handle.pool.query(
        `UPDATE ${quoted}.generation_attempts
         SET status = 'pending', phase = 'created', next_poll_at = $2,
             retryable = true, finished_at = NULL, updated_at = $2
         WHERE id = $1`,
        [inFlightAttempt, new Date("2026-07-29T01:11:00.000Z")],
      );
      await handle.pool.query(
        `UPDATE ${quoted}.generation_requests SET media_kind = 'video' WHERE id = $1`,
        [fixture.requestA],
      );
      await handle.pool.query(
        `UPDATE ${quoted}.generation_attempts
         SET status = 'succeeded', phase = 'complete',
             price_snapshot = '{"productionMode":"sample"}'::jsonb
         WHERE id = $1`,
        [fixture.attemptA],
      );
      await handle.pool.query(
        `UPDATE ${quoted}.shots SET selected_video_result_id = $2 WHERE id = $1`,
        [fixture.shotA, fixture.mediaA],
      );
      const imageInVideoSlot = await service.sceneProductionStatus(actorA, fixture.sceneA);
      assert.equal(imageInVideoSlot.scene.shotSummary.withPrimaryVideo, 0, "图片不能借 selected_video_result_id 冒充主视频");

      const crossShotMedia = randomUUID();
      await handle.db.insert(mediaResults).values(mediaResultValue(
        crossShotMedia,
        fixture.requestA,
        fixture.attemptA,
        fixture.shotA2,
        fixture.now,
        "accepted",
      ));
      await handle.pool.query(
        `UPDATE ${quoted}.media_results SET media_kind = 'video', mime_type = 'video/mp4' WHERE id = $1`,
        [crossShotMedia],
      );
      await handle.pool.query(
        `UPDATE ${quoted}.shots SET selected_video_result_id = $2 WHERE id = $1`,
        [fixture.shotA2, crossShotMedia],
      );
      const crossShotPrimary = await service.sceneProductionStatus(actorA, fixture.sceneA);
      assert.equal(crossShotPrimary.scene.shotSummary.withPrimaryVideo, 0, "request 与 shot 血缘不一致时必须拒绝投影");
      await handle.pool.query(
        `UPDATE ${quoted}.shots SET selected_video_result_id = NULL WHERE id = $1`,
        [fixture.shotA2],
      );
      await handle.pool.query(
        `UPDATE ${quoted}.media_results
         SET media_kind = 'video', mime_type = 'video/mp4', storage_url = 'https://example.invalid/sample.mp4'
         WHERE id = $1`,
        [fixture.mediaA],
      );
      await handle.pool.query(
        `UPDATE ${quoted}.media_results SET media_kind = 'video', mime_type = 'video/mp4' WHERE id = $1`,
        [fixture.conflictingMedia],
      );
      await handle.pool.query(
        `UPDATE ${quoted}.shots SET selected_video_result_id = $2 WHERE id = $1`,
        [fixture.shotA, fixture.conflictingMedia],
      );
      const crossProjectPrimary = await service.sceneProductionStatus(actorA, fixture.sceneA);
      assert.equal(crossProjectPrimary.scene.shotSummary.withPrimaryVideo, 0, "跨项目产物不能借主版本引用泄漏到投影");
      await handle.pool.query(
        `UPDATE ${quoted}.shots SET selected_video_result_id = $2 WHERE id = $1`,
        [fixture.shotA, fixture.mediaA],
      );

      const first = await service.sceneProductionStatus(actorA, fixture.sceneA);
      assert.equal(first.scene.productionStatus, "generating", "当前 pending attempt 覆盖旧主视频");
      assert.equal(first.scene.attemptSummary.pending, 1);
      assert.notEqual(first.scene.attemptSummary.queuePosition, null, "仅本地待提交 attempt 才给队列位");
      const paidDisabledRows = await new ObjectContextRepository(handle.db, false)
        .loadSceneProductionRows(fixture.sceneA);
      assert.equal(
        paidDisabledRows.some((row) => row.queuePosition !== null),
        false,
        "付费生成关闭时 created attempt 不可领取，投影也不能显示队列位",
      );
      assert.deepEqual(first.scene.outputSummary, { samplePrimaryCount: 1, fullPrimaryCount: 0 });
      assert.equal(first.scene.controlPackageSummary.filledLaneCount, 3);
      assert.equal(first.scene.controlPackageSummary.enabledLaneCount, 7);

      await handle.pool.query(
        `UPDATE ${quoted}.generation_attempts
         SET next_poll_at = $2, lease_owner = 'projection-test', lease_until = $3
         WHERE id = $1`,
        [
          inFlightAttempt,
          new Date(Date.now() + 60_000),
          new Date(Date.now() + 120_000),
        ],
      );
      const deferred = await service.sceneProductionStatus(actorA, fixture.sceneA);
      assert.equal(deferred.scene.productionStatus, "generating");
      assert.equal(deferred.scene.attemptSummary.queuePosition, null, "未来轮询或有效租约不得伪造队列位");
      await handle.pool.query(
        `UPDATE ${quoted}.generation_attempts
         SET next_poll_at = $2, lease_owner = NULL, lease_until = NULL
         WHERE id = $1`,
        [inFlightAttempt, new Date("2026-07-29T01:11:00.000Z")],
      );

      const episode = await service.episodeProductionStatus(actorA, fixture.episodeA);
      assert.equal(episode.sceneCount, 2);
      assert.equal(episode.statusCounts.generating, 1);
      assert.equal(episode.productionStatus, "not_broken_down", "集级必须取最早未完成场状态");
      assert.equal(episode.nextSceneId, fixture.emptySceneA);

      await handle.pool.query(`UPDATE ${quoted}.reference_lane_vocabulary SET active = false WHERE id = 'audio'`);
      const afterVocabularyChange = await service.sceneProductionStatus(actorA, fixture.sceneA);
      assert.equal(afterVocabularyChange.scene.controlPackageSummary.enabledLaneCount, 6);
      assert.equal(afterVocabularyChange.scene.controlPackageSummary.filledLaneCount, 3);

      const deliveredMediaA2 = randomUUID();
      const deliveredMediaA3 = randomUUID();
      const replacementMedia = randomUUID();
      const requestA2 = randomUUID();
      const attemptA2 = randomUUID();
      const requestA3 = randomUUID();
      const attemptA3 = randomUUID();
      await insertGeneration(handle, {
        requestId: requestA2,
        attemptId: attemptA2,
        actorId: fixture.ownerA,
        projectId: fixture.projectA,
        episodeId: fixture.episodeA,
        sceneId: fixture.sceneA,
        shotId: fixture.shotA2,
        mediaKind: "video",
        now: fixture.now,
      });
      await insertGeneration(handle, {
        requestId: requestA3,
        attemptId: attemptA3,
        actorId: fixture.ownerA,
        projectId: fixture.projectA,
        episodeId: fixture.episodeA,
        sceneId: fixture.sceneA,
        shotId: fixture.shotA3,
        mediaKind: "video",
        now: fixture.now,
      });
      await handle.db.insert(mediaResults).values([
        mediaResultValue(
          deliveredMediaA2,
          requestA2,
          attemptA2,
          fixture.shotA2,
          fixture.now,
          "accepted",
        ),
        mediaResultValue(
          deliveredMediaA3,
          requestA3,
          attemptA3,
          fixture.shotA3,
          fixture.now,
          "accepted",
        ),
        mediaResultValue(
          replacementMedia,
          requestA3,
          attemptA3,
          fixture.shotA3,
          fixture.now,
          "accepted",
        ),
      ]);
      await handle.pool.query(
        `UPDATE ${quoted}.media_results
         SET media_kind = 'video', mime_type = 'video/mp4'
         WHERE id = ANY($1::uuid[])`,
        [[deliveredMediaA2, deliveredMediaA3, replacementMedia]],
      );
      await handle.pool.query(
        `UPDATE ${quoted}.generation_attempts
         SET status = 'succeeded', phase = 'complete', updated_at = $2
         WHERE id = ANY($1::uuid[])`,
        [[fixture.attemptA, inFlightAttempt, attemptA2, attemptA3], new Date("2026-07-29T01:12:00.000Z")],
      );
      const mismatchedAttemptMedia = randomUUID();
      await handle.db.insert(mediaResults).values(mediaResultValue(
        mismatchedAttemptMedia,
        fixture.requestA,
        inFlightAttempt,
        fixture.shotA,
        fixture.now,
        "accepted",
      ));
      await handle.pool.query(
        `UPDATE ${quoted}.media_results SET media_kind = 'video', mime_type = 'video/mp4' WHERE id = $1`,
        [mismatchedAttemptMedia],
      );
      await handle.pool.query(`UPDATE ${quoted}.shots SET selected_video_result_id = $2 WHERE id = $1`,
        [fixture.shotA, mismatchedAttemptMedia]);
      await handle.pool.query(`UPDATE ${quoted}.shots SET selected_video_result_id = $2 WHERE id = $1`,
        [fixture.shotA2, deliveredMediaA2]);
      await handle.pool.query(`UPDATE ${quoted}.shots SET selected_video_result_id = $2 WHERE id = $1`,
        [fixture.shotA3, deliveredMediaA3]);
      const mismatchedAttemptPrimary = await service.sceneProductionStatus(actorA, fixture.sceneA);
      assert.equal(
        mismatchedAttemptPrimary.scene.shotSummary.withPrimaryVideo,
        2,
        "attempt 不属于 media.request_id 时不能成为主视频",
      );
      await handle.pool.query(`UPDATE ${quoted}.shots SET selected_video_result_id = $2 WHERE id = $1`,
        [fixture.shotA, fixture.mediaA]);
      await handle.db.insert(deliveryRecords).values({
        id: randomUUID(),
        projectId: fixture.projectA,
        episodeId: fixture.episodeA,
        manifestHash: "d".repeat(64),
        mediaResultIds: [fixture.mediaA, deliveredMediaA2, deliveredMediaA3],
        partial: false,
        missingShotCodes: [],
        purpose: "P-02b 当前主版本交付测试",
        deliveredByUserId: fixture.ownerA,
        createdAt: fixture.now,
      });
      const delivered = await service.sceneProductionStatus(actorA, fixture.sceneA);
      assert.equal(delivered.scene.productionStatus, "delivered");
      assert.equal(delivered.scene.shotSummary.delivered, 3);

      await handle.pool.query(
        `UPDATE ${quoted}.shots SET selected_video_result_id = $2 WHERE id = $1`,
        [fixture.shotA3, replacementMedia],
      );
      const afterPrimaryChange = await service.sceneProductionStatus(actorA, fixture.sceneA);
      assert.equal(afterPrimaryChange.scene.productionStatus, "has_media", "换主版本后旧交付不能造成假交付");
      assert.equal(afterPrimaryChange.scene.shotSummary.delivered, 2);
    });
  } finally {
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

function contextQuery(overrides: Partial<{
  projectContextId: string;
  originDepth: number;
  usageCursor: string;
  usagePageSize: number;
}> = {}) {
  return {
    include: new Set(["origin", "usage", "next_actions"] as const),
    originDepth: 1,
    usagePageSize: 100,
    ...overrides,
  };
}

async function applyMigrations(handle: DatabaseHandle): Promise<void> {
  const files = (await readdir(path.resolve("migrations")))
    .filter((file) => /^\d+_[a-z0-9_]+\.sql$/.test(file))
    .sort();
  for (const file of files) {
    await handle.pool.query(renderMigrationSql(await readFile(path.resolve("migrations", file), "utf8"), schema));
  }
}

async function seedFixture(handle: DatabaseHandle) {
  const now = new Date("2026-07-29T01:00:00.000Z");
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const reviewerA = randomUUID();
  const editorA = randomUUID();
  const adminA = randomUUID();
  const operatorA = randomUUID();
  const projectA = randomUUID();
  const projectB = randomUUID();
  const episodeA = randomUUID();
  const episodeB = randomUUID();
  const sceneA = randomUUID();
  const sceneB = randomUUID();
  const emptySceneA = randomUUID();
  const shotA = randomUUID();
  const shotA2 = randomUUID();
  const shotA3 = randomUUID();
  const shotB = randomUUID();
  const commonAsset = randomUUID();
  const bulkAsset = randomUUID();
  const multiAsset = randomUUID();
  const assetMediaId = randomUUID();
  const multiVariantA = randomUUID();
  const multiVariantB = randomUUID();
  const multiMediaDirect = randomUUID();
  const multiMediaVariantA = randomUUID();
  const multiMediaVariantB = randomUUID();
  const personalAsset = randomUUID();
  const personalMedia = randomUUID();
  const personalSiblingMedia = randomUUID();
  const copyRoot = randomUUID();
  const copyMiddle = randomUUID();
  const copyLeaf = randomUUID();
  const cycleAssetA = randomUUID();
  const cycleAssetB = randomUUID();
  const mediaA = randomUUID();
  const mediaB = randomUUID();
  const conflictingMedia = randomUUID();
  const requestA = randomUUID();
  const attemptA = randomUUID();
  const conflictingRequest = randomUUID();
  const conflictingAttempt = randomUUID();
  const providerCostId = randomUUID();
  const quoted = quoteIdentifier(schema);

  await handle.db.insert(users).values([
    userValue(ownerA, "object-context-a", now),
    userValue(ownerB, "object-context-b", now),
    userValue(reviewerA, "object-context-reviewer", now),
    userValue(editorA, "object-context-editor", now),
    userValue(adminA, "object-context-admin", now, "admin"),
    userValue(operatorA, "object-context-operator", now, "operator"),
  ]);
  await handle.db.insert(projects).values([
    projectValue(projectA, ownerA, "对象图授权项目 A", now),
    projectValue(projectB, ownerB, "对象图隐藏项目 B", now),
  ]);
  await handle.db.insert(episodes).values([
    episodeValue(episodeA, projectA, now),
    episodeValue(episodeB, projectB, now),
  ]);
  await handle.db.insert(scenes).values([
    sceneValue(sceneA, episodeA, now),
    sceneValue(sceneB, episodeB, now),
    sceneValue(emptySceneA, episodeA, now, 2),
  ]);
  await handle.db.insert(shots).values([
    shotValue(shotA, episodeA, sceneA, "OBJECT-A", now),
    shotValue(shotA2, episodeA, sceneA, "OBJECT-A2", now),
    shotValue(shotA3, episodeA, sceneA, "OBJECT-A3", now),
    shotValue(shotB, episodeB, sceneB, "OBJECT-B", now),
  ]);
  await handle.db.insert(projectMembers).values([
    {
      projectId: projectA,
      userId: reviewerA,
      role: "viewer",
      addedByUserId: ownerA,
      createdAt: now,
    },
    {
      projectId: projectA,
      userId: editorA,
      role: "editor",
      addedByUserId: ownerA,
      createdAt: now,
    },
  ]);
  await handle.db.insert(projectReviewPolicies).values({
    id: randomUUID(),
    projectId: projectA,
    mediaKind: "image",
    defaultStrategy: "pending_review",
    reviewerUserId: reviewerA,
    updatedByUserId: ownerA,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  await handle.db.insert(assetEntities).values([
    assetValue(commonAsset, ownerA, "对象图通用资产", now),
    assetValue(bulkAsset, ownerA, "对象图分页资产", now),
    assetValue(multiAsset, ownerA, "对象图多变体资产", now),
    assetValue(personalAsset, ownerB, "对象图协作者个人资产", now, "personal"),
    assetValue(copyRoot, ownerA, "复制链根资产", now),
    {
      ...assetValue(copyMiddle, ownerA, "复制链中间资产", now),
      copiedFromAssetEntityId: copyRoot,
    },
    {
      ...assetValue(copyLeaf, ownerA, "复制链叶资产", now),
      copiedFromAssetEntityId: copyMiddle,
    },
    assetValue(cycleAssetA, ownerA, "循环资产 A", now),
    assetValue(cycleAssetB, ownerA, "循环资产 B", now),
  ]);
  await handle.pool.query(
    `UPDATE ${quoted}.asset_entities SET copied_from_asset_entity_id = $2 WHERE id = $1`,
    [cycleAssetA, cycleAssetB],
  );
  await handle.pool.query(
    `UPDATE ${quoted}.asset_entities SET copied_from_asset_entity_id = $2 WHERE id = $1`,
    [cycleAssetB, cycleAssetA],
  );
  await handle.db.insert(assetMedia).values([
    assetMediaValue(assetMediaId, commonAsset, "对象图参考图", 0, now),
    assetMediaValue(personalMedia, personalAsset, "项目精确引用媒体", 0, now),
    assetMediaValue(personalSiblingMedia, personalAsset, "未被项目引用的同资产媒体", 1, now),
  ]);
  await handle.db.insert(assetVariants).values([
    assetVariantValue(multiVariantA, multiAsset, "front", "对象图多变体正面", true, 0, now),
    assetVariantValue(multiVariantB, multiAsset, "side", "对象图多变体侧面", true, 1, now),
  ]);
  await handle.db.insert(assetMedia).values([
    assetMediaValue(multiMediaDirect, multiAsset, "对象图多变体直连媒体", 0, now),
    assetVariantMediaValue(multiMediaVariantA, multiVariantA, "对象图多变体正面媒体", now),
    assetVariantMediaValue(multiMediaVariantB, multiVariantB, "对象图多变体侧面媒体", now),
  ]);
  await addProjectAssetRef(handle, projectA, multiAsset, ownerA, now);
  const controlPackageA = randomUUID();
  await handle.pool.query(
    `INSERT INTO ${quoted}.control_packages (id, shot_id, ready_marked_by, ready_marked_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, $4)`,
    [controlPackageA, shotA, ownerA, now],
  );
  const multiControlPackageRefIds = [randomUUID(), randomUUID(), randomUUID()];
  await handle.pool.query(
    `INSERT INTO ${quoted}.control_package_refs
       (id, package_id, lane, asset_media_id, media_result_id, note, sort_order, created_at)
     VALUES
       ($1, $4, 'character', $5, NULL, NULL, 0, $8),
       ($2, $4, 'scene',     $6, NULL, NULL, 1, $8),
       ($3, $4, 'prop',      $7, NULL, NULL, 2, $8)`,
    [
      multiControlPackageRefIds[0], multiControlPackageRefIds[1], multiControlPackageRefIds[2],
      controlPackageA, multiMediaDirect, multiMediaVariantA, multiMediaVariantB, now,
    ],
  );
  await addProjectAssetRef(handle, projectA, commonAsset, ownerA, now);
  await handle.db.insert(projectAssetRefs).values({
    id: randomUUID(),
    projectId: projectA,
    assetEntityId: personalAsset,
    assetVariantId: null,
    assetMediaId: personalMedia,
    versionSnapshot: {},
    createdByUserId: ownerA,
    createdAt: now,
    deletedAt: null,
    deletedByUserId: null,
  });
  await insertGeneration(handle, { requestId: requestA, attemptId: attemptA, actorId: ownerA, projectId: projectA, episodeId: episodeA, sceneId: sceneA, shotId: shotA, now });
  await insertGeneration(handle, {
    requestId: conflictingRequest,
    attemptId: conflictingAttempt,
    actorId: ownerB,
    projectId: projectB,
    episodeId: episodeB,
    sceneId: sceneB,
    shotId: shotA,
    now,
  });
  await handle.pool.query(
    `UPDATE ${quoted}.generation_attempts
     SET status = 'failed', phase = 'complete', provider_status = 'failed',
         error_code = 'hidden_project_failure', error_message = 'hidden project',
         retryable = false, finished_at = $2, created_at = $2, updated_at = $2
     WHERE id = $1`,
    [conflictingAttempt, new Date("2026-07-29T01:09:00.000Z")],
  );
  await handle.db.insert(mediaResults).values([
    mediaResultValue(mediaA, requestA, attemptA, shotA, now, "needs_review"),
    mediaResultValue(mediaB, null, null, shotB, now, "accepted", {
      sourceAssetMediaId: assetMediaId,
      registeredByUserId: ownerB,
    }),
    mediaResultValue(conflictingMedia, conflictingRequest, conflictingAttempt, shotA, now, "accepted"),
  ]);
  await handle.db.insert(providerCosts).values({
    id: providerCostId, generationRequestId: requestA, generationAttemptId: attemptA,
    projectId: projectA, actorUserId: ownerA, rateConfigEntryId: "84000000-0000-4000-8000-000000000001",
    provider: "ark", model: "test-model", actualModelId: "test-model", mediaKind: "image",
    providerResultStatus: "succeeded", calculationStatus: "estimated", usageSource: "formula_fallback",
    usageUnit: "image", usageQuantity: 1, billingUnit: "image", unitPriceCnyMicros: 123_456,
    unitSize: 1, costCnyMicros: 123_456, costFenRounded: 123, currency: "CNY",
    rateConfigUpdatedAt: now, rateConfigChecksum: "a".repeat(64), calculationVersion: "test", requiresAttention: true,
    failureCode: null, createdAt: now, updatedAt: now,
  });

  // 503 visible project references exercise cursor completeness beyond the old
  // asset page's 500-item ceiling.  The same actor owns each project, so this
  // is a valid project-permission fixture rather than a role bypass.
  const bulkProjects = Array.from({ length: 503 }, (_, index) => {
    const id = randomUUID();
    return { id, index };
  });
  await handle.db.insert(projects).values(bulkProjects.map(({ id, index }) =>
    projectValue(id, ownerA, `对象图分页项目 ${String(index).padStart(3, "0")}`, now),
  ));
  await handle.db.insert(projectAssetRefs).values(bulkProjects.map(({ id }) => projectAssetRefValue(id, bulkAsset, ownerA, now)));

  return {
    now, ownerA, ownerB, reviewerA, editorA, adminA, operatorA,
    projectA, projectB, episodeA, episodeB, sceneA, sceneB, emptySceneA,
    shotA, shotA2, shotA3, shotB, commonAsset, bulkAsset, multiAsset,
    multiMediaIds: [multiMediaDirect, multiMediaVariantA, multiMediaVariantB],
    multiControlPackageRefIds,
    personalAsset, personalMedia, personalSiblingMedia,
    copyLeaf, cycleAssetA,
    mediaA, mediaB, conflictingMedia, conflictingAttempt, providerCostId, requestA, attemptA,
  };
}

async function addProjectAssetRef(
  handle: DatabaseHandle,
  projectId: string,
  assetEntityId: string,
  actorId: string,
  now: Date,
): Promise<void> {
  await handle.db.insert(projectAssetRefs).values(projectAssetRefValue(projectId, assetEntityId, actorId, now));
}

async function insertGeneration(handle: DatabaseHandle, input: {
  requestId: string;
  attemptId: string;
  actorId: string;
  projectId: string;
  episodeId: string;
  sceneId: string;
  shotId: string;
  mediaKind?: "image" | "video" | "audio";
  now: Date;
}): Promise<void> {
  await handle.db.insert(generationRequests).values({
    id: input.requestId, userId: input.actorId, projectId: input.projectId,
    episodeId: input.episodeId, sceneId: input.sceneId, shotId: input.shotId,
    targetAssetEntityId: null, mediaKind: input.mediaKind ?? "image", prompt: "对象图真库测试",
    referenceMediaIds: [], referenceAssetSnapshots: [], parameters: {}, quantity: 1,
    clientIdempotencyKey: `object-context-${input.requestId}`,
    requestHash: "0".repeat(64), chargedPoints: 0, createdAt: input.now, updatedAt: input.now,
  });
  await handle.db.insert(generationAttempts).values({
    id: input.attemptId, requestId: input.requestId, attemptNo: 1, retryIdempotencyKey: null,
    provider: "ark", providerTaskId: `task-${input.attemptId}`, model: "test-model", parameters: {}, quantity: 1,
    status: "succeeded", phase: "persisting", providerStatus: "succeeded", providerResponse: null,
    errorCode: null, errorMessage: null, retryable: false, estimatedCostFen: 123,
    actualCostFen: null, actualCostStatus: "unavailable", pricingRuleId: null, priceSnapshot: {},
    lastQueryError: null, nextPollAt: input.now, lastPolledAt: input.now, leaseOwner: null,
    leaseUntil: null, submittedAt: input.now, startedAt: input.now, finishedAt: input.now,
    createdAt: input.now, updatedAt: input.now,
  });
}

function userValue(
  id: string,
  username: string,
  now: Date,
  role: "member" | "admin" | "operator" = "member",
) {
  return {
    id, username: `${username}-${id.slice(0, 6)}`, email: null, emailVerifiedAt: null,
    displayName: username, passwordHash: "test-only", active: true, role,
    createdAt: now, updatedAt: now,
  };
}

function projectValue(id: string, ownerUserId: string, name: string, now: Date) {
  return {
    id, ownerUserId, teamId: null, genre: null, name, description: null, status: "active",
    createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function episodeValue(id: string, projectId: string, now: Date) {
  return {
    id, projectId, episodeNo: 1, name: "对象图第 1 集", sortOrder: 1, status: "active",
    createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function sceneValue(id: string, episodeId: string, now: Date, sceneNo = 1) {
  return {
    id, episodeId, sceneNo, name: `对象图第 ${sceneNo} 场`, description: null, sortOrder: sceneNo,
    sourceBreakdownRunId: null, sourceCandidateId: null,
    createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function assetVariantValue(
  id: string,
  assetEntityId: string,
  variantKind: string,
  name: string,
  isPrimary: boolean,
  sortOrder: number,
  now: Date,
) {
  return {
    id, assetEntityId, variantKind, name, description: null, usageContext: null, visualPrompt: null,
    approved: true, status: "approved", isPrimary, sortOrder, sourceFileUrl: null, sourceText: null,
    metadata: {}, searchText: name, createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function assetVariantMediaValue(id: string, assetVariantId: string, title: string, now: Date) {
  return {
    id, assetEntityId: null, assetVariantId,
    mediaKind: "image", viewAngle: null, title, description: null,
    storageBucket: "test", storagePath: `assets/${id}.png`, storageUrl: null,
    widthPx: 1024, heightPx: 1024, format: "png", sha256: null,
    isPrimary: true, approved: true, sortOrder: 0, metadata: {}, createdAt: now,
    deletedAt: null, deletedByUserId: null,
  };
}

function shotValue(id: string, episodeId: string, sceneId: string, shotCode: string, now: Date) {
  return {
    id, episodeId, sceneId, shotCode, title: `${shotCode} 分镜`, scriptText: null,
    directorPrompt: null, imagePrompt: null, videoPrompt: null, durationSeconds: null, sortOrder: 1,
    referenceAssetSnapshots: [], sourceBreakdownRunId: null, sourceCandidateId: null,
    selectedImageResultId: null, selectedVideoResultId: null,
    createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function assetValue(
  id: string,
  ownerUserId: string,
  name: string,
  now: Date,
  visibility: "common" | "personal" = "common",
) {
  return {
    id, copiedFromAssetEntityId: null, sourceProjectId: null, sourceProjectName: null, ownerUserId,
    visibility, assetKind: "keyframe", role: null, usageMode: "reference", name,
    displayName: name, intro: null, appearance: null, ageValue: null, gender: null, heightCm: null,
    hairDescription: null, outfitDescription: null, category: null, styleTags: [], approved: true,
    reuseScope: "all_projects", status: "approved", sourceFileUrl: null, metadata: {},
    clearance: { search: true, gen_reference: true, commercial_publish: false, model_training: false },
    searchText: name, createdAt: now, updatedAt: now, useCount: 0, deletedAt: null, deletedByUserId: null,
  };
}

function assetMediaValue(
  id: string,
  assetEntityId: string,
  title: string,
  sortOrder: number,
  now: Date,
) {
  return {
    id, assetEntityId, assetVariantId: null,
    mediaKind: "image", viewAngle: null, title, description: null,
    storageBucket: "test", storagePath: `assets/${id}.png`, storageUrl: null,
    widthPx: 1024, heightPx: 1024, format: "png", sha256: null,
    isPrimary: sortOrder === 0, approved: true, sortOrder, metadata: {}, createdAt: now,
    deletedAt: null, deletedByUserId: null,
  };
}

function projectAssetRefValue(projectId: string, assetEntityId: string, actorId: string, now: Date) {
  return {
    id: randomUUID(), projectId, assetEntityId, assetVariantId: null, assetMediaId: null,
    versionSnapshot: {}, createdByUserId: actorId, createdAt: now, deletedAt: null, deletedByUserId: null,
  };
}

function mediaResultValue(
  id: string,
  requestId: string | null,
  attemptId: string | null,
  shotId: string,
  now: Date,
  reviewStatus: string,
  assetOrigin?: { sourceAssetMediaId: string; registeredByUserId: string },
) {
  const generated = !assetOrigin;
  return {
    id, requestId: generated ? requestId : null, attemptId: generated ? attemptId : null, shotId,
    originKind: generated ? "generation" : "asset_media",
    sourceAssetMediaId: assetOrigin?.sourceAssetMediaId ?? null,
    registeredByUserId: assetOrigin?.registeredByUserId ?? null,
    mediaKind: "image", resultIndex: 0, providerResultKey: generated ? `provider-${id}` : null,
    providerUrl: null, providerUrlExpiresAt: null, persistenceStatus: "persisted", storageBucket: "test",
    storagePath: `results/${id}.png`, storageUrl: `https://example.invalid/results/${id}.png`, sha256: null, mimeType: "image/png",
    widthPx: 1024, heightPx: 1024, durationSeconds: null, reviewStatus, complianceMetadata: {},
    createdAt: now, updatedAt: now, deletedAt: null, deletedByUserId: null,
  };
}

async function assertNotFound(work: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    work,
    (error: unknown) => error instanceof NotFoundError
      && error.message === "对象不存在或你没有访问权限",
  );
}

function assertLocalDatabase(value: string): void {
  const host = new URL(value).hostname;
  if (!['127.0.0.1', 'localhost', 'db'].includes(host)) {
    throw new Error("OBJECT_CONTEXT_TEST_DATABASE_URL 只能指向本机或本地 Compose PostgreSQL，拒绝连接云 RDS");
  }
}
