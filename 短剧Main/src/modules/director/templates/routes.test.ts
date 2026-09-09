import assert from "node:assert/strict";
import test from "node:test";
import { authHeaders, createDirectorTestApp } from "../testUtils.js";

test("未登录访问模版接口一律 401（AUTH-04 无匿名接口）", async () => {
  const app = await createDirectorTestApp();
  try {
    for (const request of [
      { method: "GET", url: "/api/v1/director/templates" },
      { method: "GET", url: "/api/v1/director/templates/dialogue-reverse-2p" },
      { method: "POST", url: "/api/v1/director/templates/dialogue-reverse-2p/apply", payload: {} },
    ] as const) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 401, `${request.method} ${request.url}`);
      assert.equal(response.json().error.code, "unauthorized");
    }
  } finally {
    await app.close();
  }
});

test("伪造 Bearer token 返回 401", async () => {
  const app = await createDirectorTestApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/director/templates",
      headers: { authorization: "Bearer forged-token" },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("GET /api/v1/director/templates 返回 11 个模版摘要", async () => {
  const app = await createDirectorTestApp();
  try {
    const response = await app.inject({ method: "GET", url: "/api/v1/director/templates", headers: authHeaders });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.templates.length, 11);
    const sample = body.data.templates.find((entry: { id: string }) => entry.id === "dialogue-reverse-2p");
    assert.ok(sample);
    assert.equal(sample.name, "双人对话·内反打");
    assert.equal(sample.category, "dialogue");
    assert.equal(sample.characterCount, 2);
    assert.ok(Array.isArray(sample.tags) && sample.tags.includes("正反打"));
    assert.equal(sample.cameraCount, 4);
  } finally {
    await app.close();
  }
});

test("GET /api/v1/director/templates/:id 返回完整模版 JSON", async () => {
  const app = await createDirectorTestApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/director/templates/dialogue-reverse-2p",
      headers: authHeaders,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.schemaVersion, 1);
    assert.equal(body.data.id, "dialogue-reverse-2p");
    assert.equal(body.data.cameras.length, 4);
    assert.equal(body.data.promptHints.zh.length > 0, true);
    assert.equal(body.data.dataSource, "tianzun-master-table:T1");
  } finally {
    await app.close();
  }
});

test("GET 未知模版返回 404 统一错误信封", async () => {
  const app = await createDirectorTestApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/director/templates/not-exist",
      headers: authHeaders,
    });
    assert.equal(response.statusCode, 404);
    const body = response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "not_found");
  } finally {
    await app.close();
  }
});

test("POST apply 实例化场景：对象、机位、轴线与 promptHints 齐全", async () => {
  const app = await createDirectorTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/director/templates/dialogue-reverse-2p/apply",
      headers: authHeaders,
      payload: {
        origin: { x: 2, z: -1 },
        headingDeg: 30,
        roleAssignments: { A: { name: "天尊" }, B: { name: "对手" } },
      },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.ok, true);
    const scene = body.data;
    assert.equal(scene.schemaVersion, 1);
    assert.equal(scene.templateId, "dialogue-reverse-2p");
    assert.equal(scene.objects.length, 2);
    assert.equal(scene.objects[0].name, "天尊");
    assert.equal(scene.objects[0].type, "mannequin");
    assert.equal(scene.objects[1].name, "对手");
    assert.equal(scene.cameras.length, 4);
    assert.equal(scene.cameras[0].type, "camera");
    assert.equal(typeof scene.cameras[0].focalLength, "number");
    assert.equal(typeof scene.cameras[0].target.x, "number");
    assert.equal(scene.axis.fromRole, "A");
    assert.equal(scene.applied.origin.headingDeg, 30);
    assert.equal(scene.applied.origin.x, 2);
    assert.equal(scene.promptHints.zh.length > 0, true);
  } finally {
    await app.close();
  }
});

test("POST apply 空 body 使用模版默认落位与默认角色", async () => {
  const app = await createDirectorTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/director/templates/emotion-cu-1p/apply",
      headers: authHeaders,
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.ok, true);
    assert.equal(body.data.objects.length, 1);
    assert.equal(body.data.objects[0].name, "A");
    assert.deepEqual(body.data.objects[0].transform.position, { x: 0, y: 0, z: 0 });
  } finally {
    await app.close();
  }
});

test("POST apply 未知模版返回 404", async () => {
  const app = await createDirectorTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/director/templates/not-exist/apply",
      headers: authHeaders,
      payload: {},
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "not_found");
  } finally {
    await app.close();
  }
});

test("POST apply 指派未知角色返回 422 template_apply_failed", async () => {
  const app = await createDirectorTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/director/templates/dialogue-reverse-2p/apply",
      headers: authHeaders,
      payload: { roleAssignments: { Z: { name: "路人" } } },
    });
    assert.equal(response.statusCode, 422);
    const body = response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "template_apply_failed");
    assert.match(body.error.message, /选定的角色不在这个场景模板里/);
  } finally {
    await app.close();
  }
});

test("POST apply 请求体字段类型错误返回 400", async () => {
  const app = await createDirectorTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/director/templates/dialogue-reverse-2p/apply",
      headers: authHeaders,
      payload: { origin: { x: "east", z: 0 } },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "invalid_request");
  } finally {
    await app.close();
  }
});
