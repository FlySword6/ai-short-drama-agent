import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { settings } from "../src/config/env.js";
import { createDatabase } from "../src/db/client.js";
import { quoteIdentifier, runMigrations, runVnextMigrations } from "../src/db/migrate.js";
import { createAuthenticationHook } from "../src/http/authenticate.js";
import { toHttpErrorResponse } from "../src/http/errorResponse.js";
import { hashSessionToken } from "../src/modules/auth/service.js";
import { createAssistantTools } from "../src/modules/assistant/tools.js";
import { createVnextDatabase, VNEXT_OWNER_ROLE, VNEXT_RUNTIME_ROLE } from "../src/modules/vnext/db.js";
import { registerVnextRoutes } from "../src/modules/vnext/routes.js";
import { VnextProjectService, type GraphDocument } from "../src/modules/vnext/service.js";

const databaseUrl = process.env.VNEXT_TEST_DATABASE_URL;

function documentWithLabel(label: string): GraphDocument {
  return {
    schemaVersion: 1,
    nodes: [{ id: randomUUID(), kind: "scene", label, position: { x: 144, y: 96 } }],
    edges: [],
  };
}

test("vNext 正式迁移/隔离/同一事实/竞态验收（真 PG）", { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  const host = new URL(databaseUrl).hostname;
  assert.ok(["127.0.0.1", "localhost", "db"].includes(host), "vNext test only permits local PostgreSQL");
  const handle = createDatabase(databaseUrl);
  const appSchema = quoteIdentifier(settings.postgresSchema);
  const actor = { id: randomUUID(), role: "member" as const };
  try {
    // ── 1. 正式迁移入口：干净环境跑受控迁移链，vNext schema/tables 必须随之存在 ──
    await handle.pool.query("DROP SCHEMA IF EXISTS vnext CASCADE");
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${appSchema} CASCADE`);
    const applied = await runMigrations(handle);
    assert.ok(applied.includes("vnext/001_vnext_projects_graph.sql"), "vNext 001 必须记录在正式迁移结果里");
    assert.ok(applied.includes("vnext/002_graph_revisions_actor_kind.sql"), "vNext 002 必须记录在正式迁移结果里");
    assert.ok(applied.includes("vnext/003_vnext_app_runtime_membership.sql"), "vNext 003 必须记录在正式迁移结果里");
    const vnextTables = await handle.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'vnext' ORDER BY tablename",
    );
    assert.deepEqual(
      vnextTables.rows.map((row) => row.tablename),
      ["agent_session_contexts", "generation_telemetry_events", "graph_documents", "graph_revisions", "project_members", "projects", "schema_migrations"],
      "干净环境只跑正式迁移链就必须拥有全部 vNext 表",
    );
    const owners = await handle.pool.query<{ tableowner: string }>(
      "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'vnext' AND tablename <> 'schema_migrations'",
    );
    assert.deepEqual(owners.rows.map((row) => row.tableowner), [VNEXT_OWNER_ROLE], "vNext 产品表必须由独立 NOLOGIN owner 持有");

    // ── 2. 运行时隔离：vnext_app 角色只读写 vnext schema，且不得硬删 ──
    const isolation = await handle.pool.connect();
    try {
      await isolation.query("SET ROLE vnext_app");
      const selectable = await isolation.query("SELECT count(*)::int AS n FROM vnext.projects");
      assert.equal(selectable.rows[0]?.n, 0, "vnext_app 可以读 vnext schema");
      const writable = await isolation.query(
        "INSERT INTO vnext.projects (id, owner_user_id, name) VALUES ($1, $2, '角色验收') RETURNING id",
        [randomUUID(), randomUUID()],
      );
      assert.ok(writable.rows[0]?.id, "vnext_app 可以写 vnext schema");
      await assert.rejects(
        isolation.query("DELETE FROM vnext.projects"),
        /permission denied/,
        "vnext_app 禁止硬删（红线 R1 同口径：不给 DELETE）",
      );
      await assert.rejects(
        isolation.query(`SELECT count(*) FROM ${appSchema}.users`),
        /permission denied/,
        "vnext_app 不得读 Lite/完整版所在的主 schema",
      );
      await assert.rejects(
        isolation.query(`CREATE TABLE ${appSchema}.vnext_escape (id int)`),
        /permission denied/,
        "vnext_app 不得在主 schema 建表",
      );
      await isolation.query("RESET ROLE");
      await isolation.query("DELETE FROM vnext.projects WHERE name = '角色验收'");
    } finally {
      await isolation.query("RESET ROLE").catch(() => undefined);
      isolation.release();
    }

    const service = new VnextProjectService(handle.db);

    // ── 排序/分页：稳定 keyset 翻页不漏不重 ──
    const pageOwner = { id: randomUUID(), role: "member" as const };
    const pageProjects = [
      await service.createProject(pageOwner, "分页 A"),
      await service.createProject(pageOwner, "分页 B"),
    ];
    const firstPage = await service.listProjects(pageOwner, { limit: 1 });
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.nextCursor, "limit=1 时必须给出下一页游标");
    const secondPage = await service.listProjects(pageOwner, { limit: 1, cursor: firstPage.nextCursor ?? undefined });
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(firstPage.items[0]?.id, secondPage.items[0]?.id, "两页不得重复");
    assert.deepEqual(
      new Set([firstPage.items[0]?.id, secondPage.items[0]?.id]),
      new Set(pageProjects.map((project) => project.id)),
      "keyset 分页必须覆盖全部项目",
    );
    assert.equal(secondPage.nextCursor, null, "最后一页不再有游标");

    // ── GraphDocument 修订持久化与拒写陈旧 revision ──
    const project = await service.createProject(actor, "持久画布验收项目");
    const initial = await service.getDocument(actor, project.id);
    assert.equal(initial.revision, 0);
    assert.equal(initial.lastWrite, null);
    const saved = await service.replaceDocument({
      actor,
      projectId: project.id,
      expectedRevision: initial.revision,
      document: documentWithLabel("第一场"),
      actorKind: "human",
    });
    assert.equal(saved.revision, 1);
    assert.equal(saved.lastWrite?.kind, "human");
    await assert.rejects(
      service.replaceDocument({
        actor,
        projectId: project.id,
        expectedRevision: 1,
        document: {
          schemaVersion: 1,
          nodes: [{
            id: "not-a-uuid",
            kind: "scene",
            label: "非法节点",
            position: { x: 0, y: 0 },
            data: { nested: { forbidden: true } },
          }],
          edges: [],
        } as unknown as GraphDocument,
        actorKind: "human",
      }),
      (error: { statusCode?: number }) => error.statusCode === 400,
      "服务边界必须独立拒绝非法 UUID 与嵌套 data，不能只依赖 HTTP/Agent adapter",
    );
    await assert.rejects(
      service.replaceDocument({ actor, projectId: project.id, expectedRevision: 0, document: saved.document, actorKind: "human" }),
      (error: { code?: string }) => error.code === "vnext_revision_conflict",
    );
    await assert.rejects(
      handle.pool.query("UPDATE vnext.graph_revisions SET revision = 9 WHERE project_id = $1", [project.id]),
      /immutable/,
    );

    // ── 4. 画布保存竞态：同一 revision 并发写只能有一个成功，败者重读合并后必须能继续 ──
    const raceProject = await service.createProject(actor, "竞态验收项目");
    await service.replaceDocument({
      actor, projectId: raceProject.id, expectedRevision: 0, document: documentWithLabel("基线"), actorKind: "human",
    });
    const racing = [
      service.replaceDocument({ actor, projectId: raceProject.id, expectedRevision: 1, document: documentWithLabel("拖动 A"), actorKind: "human" }),
      service.replaceDocument({ actor, projectId: raceProject.id, expectedRevision: 1, document: documentWithLabel("拖动 B"), actorKind: "human" }),
    ];
    const settled = await Promise.allSettled(racing);
    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    assert.equal(
      fulfilled.length, 1,
      `同一旧 revision 的两笔并发写，必须恰好一笔落库;实际拒绝原因: ${rejected.map((result) => String((result as PromiseRejectedResult).reason)).join(" | ")}`,
    );
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "vnext_revision_conflict");
    // 败方的合并动作：重读真实 revision，把自己的编辑重放到新事实之上（前端串行保存的同一语义）。
    const currentAfterRace = await service.getDocument(actor, raceProject.id);
    assert.equal(currentAfterRace.revision, 2);
    const merged = await service.replaceDocument({
      actor, projectId: raceProject.id, expectedRevision: currentAfterRace.revision, document: documentWithLabel("败方合并重放"), actorKind: "human",
    });
    assert.equal(merged.revision, 3);
    const revisionChain = await service.listRevisions(actor, raceProject.id);
    assert.deepEqual(revisionChain.map((row) => row.revision), [3, 2, 1], "修订链必须完整连续，没有覆盖写");

    // ── 生成遥测：只落合同字段，不落提示词/剧本等敏感列 ──
    const taskId = randomUUID();
    await service.recordGenerationTelemetry(actor, {
      id: randomUUID(), userId: actor.id, requestId: "request-acceptance", projectId: project.id, taskId,
      eventType: "submitted", provider: "test-provider", model: "test-model", paidConfirmation: false,
    });
    const telemetry = await handle.pool.query<{ user_id: string; request_id: string; project_id: string; task_id: string; event_type: string }>(
      "SELECT user_id, request_id, project_id, task_id, event_type FROM vnext.generation_telemetry_events",
    );
    assert.deepEqual(telemetry.rows[0], { user_id: actor.id, request_id: "request-acceptance", project_id: project.id, task_id: taskId, event_type: "submitted" });
    const sensitiveColumns = await handle.pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'vnext' AND table_name = 'generation_telemetry_events'",
    );
    assert.ok(!sensitiveColumns.rows.some((column) => /prompt|script|media_content/i.test(column.column_name)));

    // ── 3/5. 生产认证（真 AuthService 会话）+ 未登录/无权限/Agent 同一写入链 ──
    const human = { id: randomUUID(), username: "vnext-human", displayName: "vNext Human" };
    const viewer = { id: randomUUID(), username: "vnext-viewer", displayName: "vNext Viewer" };
    const outsider = { id: randomUUID(), username: "vnext-outsider", displayName: "vNext Outsider" };
    const future = new Date(Date.now() + 60 * 60 * 1000);
    for (const user of [human, viewer, outsider]) {
      await handle.pool.query(
        `INSERT INTO ${appSchema}.users (id, username, display_name, password_hash) VALUES ($1, $2, $3, 'test-only')`,
        [user.id, user.username, user.displayName],
      );
    }
    const humanToken = `vnext-web-${randomUUID()}`;
    const agentToken = `vnext-agent-${randomUUID()}`;
    const viewerToken = `vnext-viewer-${randomUUID()}`;
    const outsiderToken = `vnext-outsider-${randomUUID()}`;
    const humanSessionId = randomUUID();
    await handle.pool.query(
      `INSERT INTO ${appSchema}.sessions (id, user_id, token_hash, credential_source, expires_at) VALUES ($1, $2, $3, 'web', $4)`,
      [humanSessionId, human.id, hashSessionToken(humanToken), future],
    );
    await handle.pool.query(
      `INSERT INTO ${appSchema}.sessions (id, user_id, token_hash, credential_source, agent_type, credential_label, issued_by_session_id, expires_at)
       VALUES ($1, $2, $3, 'agent', 'test-agent', 'vNext 验收 Agent', $4, $5)`,
      [randomUUID(), human.id, hashSessionToken(agentToken), humanSessionId, future],
    );
    await handle.pool.query(
      `INSERT INTO ${appSchema}.sessions (id, user_id, token_hash, credential_source, expires_at) VALUES ($1, $2, $3, 'web', $4)`,
      [randomUUID(), viewer.id, hashSessionToken(viewerToken), future],
    );
    await handle.pool.query(
      `INSERT INTO ${appSchema}.sessions (id, user_id, token_hash, credential_source, expires_at) VALUES ($1, $2, $3, 'web', $4)`,
      [randomUUID(), outsider.id, hashSessionToken(outsiderToken), future],
    );

    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const { statusCode, body } = toHttpErrorResponse(error);
      return reply.code(statusCode).send({ ok: false, error: body });
    });
    app.addHook("preHandler", createAuthenticationHook(() => handle.db));
    await registerVnextRoutes(app, () => handle.db);
    const asUser = (token: string) => ({ authorization: `Bearer ${token}` });
    try {
      const anonymous = await app.inject({ method: "GET", url: "/api/vnext/projects" });
      assert.equal(anonymous.statusCode, 401, "未登录必须 401");
      const badToken = await app.inject({ method: "GET", url: "/api/vnext/projects", headers: asUser("not-a-session") });
      assert.equal(badToken.statusCode, 401, "无效会话必须 401");
      const malformedCursor = Buffer.from(
        `${new Date().toISOString()}|------------------------------------`,
        "utf8",
      ).toString("base64url");
      const badCursor = await app.inject({
        method: "GET",
        url: `/api/vnext/projects?cursor=${malformedCursor}`,
        headers: asUser(humanToken),
      });
      assert.equal(badCursor.statusCode, 400, "形似 UUID 的非法游标必须在服务边界返回 400");

      const created = await app.inject({ method: "POST", url: "/api/vnext/projects", headers: asUser(humanToken), payload: { name: "API 项目" } });
      assert.equal(created.statusCode, 201);
      const projectId = (created.json() as { ok: true; data: { id: string } }).data.id;

      const humanWrite = await app.inject({
        method: "PUT", url: `/api/vnext/projects/${projectId}/graph`, headers: asUser(humanToken),
        payload: { expected_revision: 0, document: { schema_version: 1, nodes: [], edges: [] } },
      });
      assert.equal(humanWrite.statusCode, 200);
      const humanWriteBody = humanWrite.json() as { ok: true; data: { project_id: string; revision: number; document: { schema_version: number }; last_write: { kind: string } } };
      assert.equal(humanWriteBody.data.project_id, projectId);
      assert.equal(humanWriteBody.data.revision, 1);
      assert.equal(humanWriteBody.data.document.schema_version, 1);
      assert.equal(humanWriteBody.data.last_write.kind, "human", "人类写入要记 human");

      // Agent 与界面走同一服务、同一 revision 链，只靠 created_by_kind 区分。
      const agentWrite = await app.inject({
        method: "PUT", url: `/api/vnext/projects/${projectId}/graph`, headers: asUser(agentToken),
        payload: { expected_revision: 1, document: { schema_version: 1, nodes: [{ id: randomUUID(), kind: "scene", label: "Agent 增量", position: { x: 8, y: 9 } }], edges: [] } },
      });
      assert.equal(agentWrite.statusCode, 200);
      const agentWriteBody = agentWrite.json() as { ok: true; data: { revision: number; last_write: { kind: string } } };
      assert.equal(agentWriteBody.data.revision, 2);
      assert.equal(agentWriteBody.data.last_write.kind, "agent", "Agent 写入要记 agent——页面的 Agent 状态只能来自这份事实");
      const revisions = await app.inject({ method: "GET", url: `/api/vnext/projects/${projectId}/revisions`, headers: asUser(humanToken) });
      const revisionItems = (revisions.json() as { ok: true; data: { items: Array<{ revision: number; created_by_kind: string }> } }).data.items;
      assert.deepEqual(revisionItems.map((row) => [row.revision, row.created_by_kind]), [[2, "agent"], [1, "human"]]);

      // Agent 凭证对其他 mutation 保持 fail-closed：只画布 PUT 经 agentAccess candidate 放行。
      const agentCreate = await app.inject({ method: "POST", url: "/api/vnext/projects", headers: asUser(agentToken), payload: { name: "Agent 越权项目" } });
      assert.equal(agentCreate.statusCode, 403, "Agent 不得创建项目");
      assert.equal((agentCreate.json() as { ok: false; error: { code: string } }).error.code, "agent_action_not_allowed");
      const agentTelemetry = await app.inject({
        method: "POST", url: "/api/vnext/generation-telemetry", headers: asUser(agentToken),
        payload: { id: randomUUID(), user_id: human.id, request_id: "agent-telemetry", project_id: projectId, task_id: randomUUID(), event_type: "submitted" },
      });
      assert.equal(agentTelemetry.statusCode, 403, "Agent 不得写遥测");
      assert.equal((agentTelemetry.json() as { ok: false; error: { code: string } }).error.code, "agent_action_not_allowed");

      const stale = await app.inject({
        method: "PUT", url: `/api/vnext/projects/${projectId}/graph`, headers: asUser(humanToken),
        payload: { expected_revision: 0, document: { schema_version: 1, nodes: [], edges: [] } },
      });
      assert.equal(stale.statusCode, 409, "陈旧 revision 必须 409");
      const staleBody = stale.json() as { ok: false; error: { code: string; details: unknown } };
      assert.equal(staleBody.error.code, "vnext_revision_conflict");
      assert.equal(staleBody.error.details, null, "409 错误体按合同不带 details");
      // 合并重放路径:409 后调用方重读最新事实再重放本地编辑,当前真实 revision 必须是 2。
      const reread = await app.inject({ method: "GET", url: `/api/vnext/projects/${projectId}/graph`, headers: asUser(humanToken) });
      assert.equal(reread.statusCode, 200);
      assert.equal((reread.json() as { ok: true; data: { revision: number } }).data.revision, 2, "409 后重读必须拿到当前真实 revision 供合并重放");

      // ── 3b. 真实 Agent 工具入口：projectId 只从真实 Agent Context 取，写入走与 UI 相同的
      // VnextProjectService/GraphDocument revision 链，再由 API 读回同一份事实 ──
      const vnextService = new VnextProjectService(handle.db);
      const assistantSessionId = randomUUID();
      await vnextService.bindAssistantSession(human, assistantSessionId, projectId);
      assert.equal(
        await vnextService.resolveAssistantProject(human, assistantSessionId),
        projectId,
        "Assistant 会话必须从 vNext 专用事实解析项目上下文",
      );
      const assistantTools = createAssistantTools(
        { sessionId: assistantSessionId, userId: human.id, vnextProjectId: projectId },
        {
          searchAssets: async () => ({}),
          addProjectAsset: async () => ({}),
          executeDirectorCommand: async () => ({}),
          prepareGenerationCard: async () => ({}),
          getGenerationTask: async () => ({}),
          vnextProjectService: vnextService,
        },
      );
      const readCanvasTool = assistantTools.find((tool) => tool.name === "get_vnext_canvas");
      const canvasTool = assistantTools.find((tool) => tool.name === "write_vnext_canvas");
      assert.ok(readCanvasTool, "真实 Assistant 工具注册表必须提供最新画布读取工具");
      assert.ok(canvasTool, "真实 Assistant 工具注册表必须为 vNext 上下文注册画布工具");
      const toolRead = await readCanvasTool.execute("call-read", {});
      const readPayload = JSON.parse(toolRead.content[0]?.text ?? "{}") as {
        revision: number;
        document: { schema_version: 1; nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
      };
      assert.equal(readPayload.revision, 2, "Agent 写入前必须读到当前真实 revision");
      const existingNodeIds = readPayload.document.nodes.map((node) => node.id);
      const toolWrite = await canvasTool.execute("call-1", {
        expected_revision: readPayload.revision,
        document: {
          ...readPayload.document,
          nodes: [
            ...readPayload.document.nodes,
            { id: randomUUID(), kind: "note", label: "Agent 工具写入", position: { x: 3, y: 4 } },
          ],
        },
      });
      const toolPayload = JSON.parse(toolWrite.content[0]?.text ?? "{}") as { revision: number };
      assert.equal(toolPayload.revision, 3, "工具写入必须前进同一条 revision 链");
      const afterTool = await app.inject({ method: "GET", url: `/api/vnext/projects/${projectId}/graph`, headers: asUser(humanToken) });
      const afterToolBody = afterTool.json() as {
        ok: true;
        data: { revision: number; document: { nodes: Array<{ id: string }> }; last_write: { kind: string } };
      };
      assert.equal(afterToolBody.data.revision, 3, "API 必须读回工具写入的同一 revision");
      assert.equal(afterToolBody.data.last_write.kind, "agent", "工具写入与 Agent HTTP 写入同样记 agent");
      assert.deepEqual(
        afterToolBody.data.document.nodes.slice(0, existingNodeIds.length).map((node) => node.id),
        existingNodeIds,
        "Agent 先读后写不得覆盖既有 GraphDocument 节点",
      );
      const toolRevisions = await app.inject({ method: "GET", url: `/api/vnext/projects/${projectId}/revisions`, headers: asUser(humanToken) });
      const toolRevisionItems = (toolRevisions.json() as { ok: true; data: { items: Array<{ revision: number; created_by_kind: string }> } }).data.items;
      assert.deepEqual(toolRevisionItems.map((row) => [row.revision, row.created_by_kind]), [[3, "agent"], [2, "agent"], [1, "human"]]);
      assert.equal(
        createAssistantTools(
          { sessionId: randomUUID(), userId: human.id },
          {
            searchAssets: async () => ({}),
            addProjectAsset: async () => ({}),
            executeDirectorCommand: async () => ({}),
            prepareGenerationCard: async () => ({}),
            getGenerationTask: async () => ({}),
          },
        ).some((tool) => tool.name.includes("vnext_canvas")),
        false,
        "没有 vNext project 的 Agent Context 不得注册画布工具",
      );

      await handle.pool.query("INSERT INTO vnext.project_members (project_id, user_id, role) VALUES ($1, $2, 'viewer')", [projectId, viewer.id]);
      const viewerRead = await app.inject({ method: "GET", url: `/api/vnext/projects/${projectId}/graph`, headers: asUser(viewerToken) });
      assert.equal(viewerRead.statusCode, 200, "viewer 可以读画布");
      const viewerWrite = await app.inject({
        method: "PUT", url: `/api/vnext/projects/${projectId}/graph`, headers: asUser(viewerToken),
        payload: { expected_revision: 2, document: { schema_version: 1, nodes: [], edges: [] } },
      });
      assert.equal(viewerWrite.statusCode, 403, "viewer 不得写画布");
      const outsiderRead = await app.inject({ method: "GET", url: `/api/vnext/projects/${projectId}/graph`, headers: asUser(outsiderToken) });
      assert.equal(outsiderRead.statusCode, 404, "非成员按不存在处理");

      const telemetryEvent = {
        id: randomUUID(), user_id: human.id, request_id: "request-api", project_id: projectId,
        task_id: randomUUID(), event_type: "queued", paid_confirmation: false,
      };
      const telemetryWrite = await app.inject({ method: "POST", url: "/api/vnext/generation-telemetry", headers: asUser(humanToken), payload: telemetryEvent });
      assert.equal(telemetryWrite.statusCode, 201);
      const impersonated = await app.inject({
        method: "POST", url: "/api/vnext/generation-telemetry", headers: asUser(humanToken),
        payload: { ...telemetryEvent, id: randomUUID(), user_id: randomUUID() },
      });
      assert.equal(impersonated.statusCode, 400, "遥测不得冒充他人身份");

      // ── 2b. 非超级用户真实运行：vNext repository 的实际连接钉死最小权限角色 vnext_app，
      // 会话认证走主连接的非超级用户身份；应用全程不以超级用户跑 ──
      const runtimeRole = "vnext_runtime_test";
      const runtimePassword = "vnext-runtime-pass";
      await handle.pool.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
      await handle.pool.query(`CREATE ROLE ${runtimeRole} LOGIN NOINHERIT PASSWORD '${runtimePassword}'`);
      await handle.pool.query(`GRANT USAGE ON SCHEMA ${appSchema} TO ${runtimeRole}`);
      await handle.pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${appSchema} TO ${runtimeRole}`);
      await handle.pool.query(`GRANT ${quoteIdentifier(VNEXT_RUNTIME_ROLE)} TO ${runtimeRole}`);
      const runtimeUrl = new URL(databaseUrl);
      runtimeUrl.username = runtimeRole;
      runtimeUrl.password = runtimePassword;
      const runtimeMain = createDatabase(runtimeUrl.toString());
      const runtimeVnext = createVnextDatabase(runtimeUrl.toString());
      const runtimeApp = Fastify();
      runtimeApp.setErrorHandler((error, _request, reply) => {
        const { statusCode, body } = toHttpErrorResponse(error);
        return reply.code(statusCode).send({ ok: false, error: body });
      });
      runtimeApp.addHook("preHandler", createAuthenticationHook(() => runtimeMain.db));
      await registerVnextRoutes(runtimeApp, () => runtimeVnext.db);
      try {
        const roleRow = await runtimeVnext.pool.query<{ role: string }>("SHOW role");
        assert.equal(roleRow.rows[0]?.role, VNEXT_RUNTIME_ROLE, "vNext 连接的 role GUC 必须钉死 vnext_app");
        await assert.rejects(
          runtimeMain.pool.query("SELECT count(*) FROM vnext.projects"),
          /permission denied/,
          "普通主连接不得继承 vNext 产品表权限",
        );
        const runtimeRead = await runtimeApp.inject({ method: "GET", url: `/api/vnext/projects/${projectId}/graph`, headers: asUser(humanToken) });
        assert.equal(runtimeRead.statusCode, 200, "非超级用户运行身份下画布读必须通");
        const currentRevision = (runtimeRead.json() as { ok: true; data: { revision: number } }).data.revision;
        const runtimeWrite = await runtimeApp.inject({
          method: "PUT", url: `/api/vnext/projects/${projectId}/graph`, headers: asUser(humanToken),
          payload: {
            expected_revision: currentRevision,
            document: { schema_version: 1, nodes: [{ id: randomUUID(), kind: "scene", label: "非超户运行时写入", position: { x: 5, y: 6 } }], edges: [] },
          },
        });
        assert.equal(runtimeWrite.statusCode, 200, "非超级用户运行身份下画布写必须通");
        assert.equal((runtimeWrite.json() as { ok: true; data: { revision: number } }).data.revision, currentRevision + 1);
        await assert.rejects(runtimeVnext.pool.query("DELETE FROM vnext.projects"), /permission denied/, "运行时连接禁止硬删");
        await assert.rejects(runtimeVnext.pool.query(`SELECT count(*) FROM ${appSchema}.users`), /permission denied/, "运行时连接不得读主 schema");
      } finally {
        await runtimeApp.close();
        await runtimeMain.pool.end();
        await runtimeVnext.pool.end();
        // DROP ROLE 不自动回收已授予的权限:先 DROP OWNED 清授权(角色不拥有任何对象)。
        await handle.pool.query(`DROP OWNED BY ${runtimeRole}`);
        await handle.pool.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
      }
    } finally {
      await app.close();
    }
  } finally {
    await handle.pool.query("DROP SCHEMA IF EXISTS vnext CASCADE").catch(() => undefined);
    await handle.pool.query(`DROP SCHEMA IF EXISTS ${appSchema} CASCADE`).catch(() => undefined);
    await handle.pool.end();
  }
});

test("vNext 001→002/003 真实升级:既有 graph revision 必须无损保留", { skip: !databaseUrl }, async () => {
  assert.ok(databaseUrl);
  const adminHandle = createDatabase(databaseUrl);
  const vnextDir = path.resolve("src/db/migrations/vnext");
  const roleSuffix = randomUUID().replaceAll("-", "");
  const sharedRole = `vnext_shared_${roleSuffix}`;
  const runtimeRole = `vnext_runtime_${roleSuffix}`;
  const rolePassword = `vnext-test-${roleSuffix}`;
  const databaseName = (await adminHandle.pool.query<{ current_database: string }>(
    "SELECT current_database()",
  )).rows[0]!.current_database;
  await adminHandle.pool.query(
    `CREATE ROLE ${quoteIdentifier(sharedRole)} LOGIN INHERIT CREATEROLE PASSWORD '${rolePassword}'`,
  );
  await adminHandle.pool.query(
    `GRANT CREATE ON DATABASE ${quoteIdentifier(databaseName)} TO ${quoteIdentifier(sharedRole)}`,
  );
  const sharedUrl = new URL(databaseUrl);
  sharedUrl.username = sharedRole;
  sharedUrl.password = rolePassword;
  const handle = createDatabase(sharedUrl.toString());
  // 第一阶段只应用 001:把真实 001 文件复制进独立目录跑同一条 runner,
  // checksum 与正式链一致,第二阶段才会把它当“已应用”跳过。
  const stageDir = await mkdtemp(path.join(tmpdir(), "vnext-upgrade-"));
  try {
    await adminHandle.pool.query("DROP SCHEMA IF EXISTS vnext CASCADE");
    await copyFile(
      path.join(vnextDir, "001_vnext_projects_graph.sql"),
      path.join(stageDir, "001_vnext_projects_graph.sql"),
    );
    const phaseOne = await runVnextMigrations(handle.pool, stageDir);
    assert.deepEqual(phaseOne, ["001_vnext_projects_graph.sql"], "第一阶段只能应用 001");
    const inheritBefore = await handle.pool.query<{ rolinherit: boolean }>(
      "SELECT rolinherit FROM pg_roles WHERE rolname = current_user",
    );
    assert.equal(inheritBefore.rows[0]?.rolinherit, true, "回归前置：共享迁移/主登录原本是 INHERIT");

    // 旧库真实写入一条 graph revision 和当前 document(001 结构,无 created_by_kind 列)。
    const projectId = randomUUID();
    const authorId = randomUUID();
    const legacyDocument = {
      schemaVersion: 1,
      nodes: [{ id: randomUUID(), kind: "scene", label: "升级前场景", position: { x: 1, y: 2 } }],
      edges: [{ id: randomUUID(), from: "a", to: "b" }],
    };
    await handle.pool.query("INSERT INTO vnext.projects (id, owner_user_id, name) VALUES ($1, $2, '升级验收')", [projectId, authorId]);
    await handle.pool.query(
      "INSERT INTO vnext.graph_documents (project_id, revision, document) VALUES ($1, 1, $2)",
      [projectId, JSON.stringify(legacyDocument)],
    );
    await handle.pool.query(
      "INSERT INTO vnext.graph_revisions (project_id, revision, document, created_by_user_id) VALUES ($1, 1, $2, $3)",
      [projectId, JSON.stringify(legacyDocument), authorId],
    );

    // 第二阶段:沿正式迁移链应用 002/003。001 装的 immutable trigger 在场,
    // 任何对既有 revision 的 UPDATE 都会让整个迁移回滚——这里必须 exit 0。
    const phaseTwo = await runVnextMigrations(handle.pool);
    assert.deepEqual(
      phaseTwo,
      ["002_graph_revisions_actor_kind.sql", "003_vnext_app_runtime_membership.sql"],
      "既有 revision 的库必须能沿正式链升到 002/003",
    );
    const inheritAfter = await handle.pool.query<{ rolinherit: boolean }>(
      "SELECT rolinherit FROM pg_roles WHERE rolname = current_user",
    );
    assert.equal(inheritAfter.rows[0]?.rolinherit, true, "001→003 不得改变共享登录的全局 rolinherit");
    const sharedRoleState = await handle.pool.query<{ rolsuper: boolean; vnext_memberships: number }>(
      `SELECT r.rolsuper,
              count(m.roleid)::int AS vnext_memberships
         FROM pg_roles r
         LEFT JOIN pg_auth_members m
           ON m.member = r.oid
          AND m.roleid IN (
            SELECT oid FROM pg_roles WHERE rolname IN ('vnext_app', 'vnext_owner')
          )
        WHERE r.rolname = session_user
        GROUP BY r.rolsuper`,
    );
    assert.equal(sharedRoleState.rows[0]?.rolsuper, false, "共享主连接断言不得使用超级用户旁路");
    assert.equal(sharedRoleState.rows[0]?.vnext_memberships, 0, "迁移后不得留下 vNext 运行时或 owner 成员资格");
    await assert.rejects(
      handle.pool.query("SELECT count(*) FROM vnext.projects"),
      /permission denied/,
      "共享登录的普通主连接不得自动取得 vNext 产品表权限",
    );

    await adminHandle.pool.query(
      `CREATE ROLE ${quoteIdentifier(runtimeRole)} LOGIN NOINHERIT PASSWORD '${rolePassword}'`,
    );
    await adminHandle.pool.query(
      `GRANT ${quoteIdentifier(VNEXT_RUNTIME_ROLE)} TO ${quoteIdentifier(runtimeRole)}`,
    );
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = rolePassword;
    const runtimeHandle = createVnextDatabase(runtimeUrl.toString());
    try {
      const runtimeRoleResult = await runtimeHandle.pool.query<{ role: string; rolsuper: boolean }>(
        `SELECT current_user AS role,
                (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS rolsuper`,
      );
      assert.equal(runtimeRoleResult.rows[0]?.role, VNEXT_RUNTIME_ROLE);
      assert.equal(runtimeRoleResult.rows[0]?.rolsuper, false, "vNext 专用连接成功断言不得使用超级用户旁路");
      await runtimeHandle.pool.query("SELECT count(*) FROM vnext.projects");
    } finally {
      await runtimeHandle.pool.end();
    }

    const kept = await adminHandle.pool.query<{
      revision: number; document: unknown; created_by_user_id: string; created_by_kind: string;
    }>(
      "SELECT revision, document, created_by_user_id, created_by_kind FROM vnext.graph_revisions WHERE project_id = $1",
      [projectId],
    );
    assert.equal(kept.rows.length, 1, "原 revision 不得丢失或翻倍");
    assert.equal(kept.rows[0]?.revision, 1);
    assert.deepEqual(kept.rows[0]?.document, legacyDocument, "原 document 必须完整保留");
    assert.equal(kept.rows[0]?.created_by_user_id, authorId, "原写入者必须保留");
    assert.equal(kept.rows[0]?.created_by_kind, "human", "历史 revision 回填为 human");
    const currentDoc = await adminHandle.pool.query<{ revision: number; document: unknown }>(
      "SELECT revision, document FROM vnext.graph_documents WHERE project_id = $1",
      [projectId],
    );
    assert.equal(currentDoc.rows[0]?.revision, 1);
    assert.deepEqual(currentDoc.rows[0]?.document, legacyDocument, "当前 document 必须完整保留");

    // 运行时不可变合同不得被升级削弱:UPDATE/DELETE 依旧被拒。
    await assert.rejects(
      adminHandle.pool.query("UPDATE vnext.graph_revisions SET revision = 9 WHERE project_id = $1", [projectId]),
      /immutable/,
      "升级后 immutable trigger 必须仍拦 UPDATE",
    );
    await assert.rejects(
      adminHandle.pool.query("DELETE FROM vnext.graph_revisions WHERE project_id = $1", [projectId]),
      /immutable/,
      "升级后 immutable trigger 必须仍拦 DELETE",
    );

    // 新写入语义:缺省 human、显式 agent 合法、非法类别被 CHECK 拒绝。
    await adminHandle.pool.query(
      "INSERT INTO vnext.graph_revisions (project_id, revision, document, created_by_user_id) VALUES ($1, 2, $2, $3)",
      [projectId, JSON.stringify(legacyDocument), authorId],
    );
    await adminHandle.pool.query(
      "INSERT INTO vnext.graph_revisions (project_id, revision, document, created_by_user_id, created_by_kind) VALUES ($1, 3, $2, $3, 'agent')",
      [projectId, JSON.stringify(legacyDocument), authorId],
    );
    const kinds = await adminHandle.pool.query<{ revision: number; created_by_kind: string }>(
      "SELECT revision, created_by_kind FROM vnext.graph_revisions WHERE project_id = $1 ORDER BY revision",
      [projectId],
    );
    assert.deepEqual(
      kinds.rows.map((row) => [row.revision, row.created_by_kind]),
      [[1, "human"], [2, "human"], [3, "agent"]],
      "缺省 DEFAULT 与显式 agent 的 actor 语义必须正确",
    );
    await assert.rejects(
      adminHandle.pool.query(
        "INSERT INTO vnext.graph_revisions (project_id, revision, document, created_by_user_id, created_by_kind) VALUES ($1, 4, $2, $3, 'robot')",
        [projectId, JSON.stringify(legacyDocument), authorId],
      ),
      /vnext_graph_revisions_actor_kind/,
      "非法 actor 类别必须被 CHECK 拒绝",
    );
  } finally {
    await handle.pool.end();
    await adminHandle.pool.query("DROP SCHEMA IF EXISTS vnext CASCADE").catch(() => undefined);
    await adminHandle.pool.query(`DROP OWNED BY ${quoteIdentifier(runtimeRole)}`).catch(() => undefined);
    await adminHandle.pool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(runtimeRole)}`).catch(() => undefined);
    await adminHandle.pool.query(`DROP OWNED BY ${quoteIdentifier(sharedRole)}`).catch(() => undefined);
    await adminHandle.pool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(sharedRole)}`).catch(() => undefined);
    await adminHandle.pool.end();
    await rm(stageDir, { recursive: true, force: true });
  }
});
