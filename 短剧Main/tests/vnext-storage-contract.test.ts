import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  assertVnextStoragePath,
  buildVnextStoragePath,
  isVnextStoragePath,
  VNEXT_TOS_KEY_PREFIX,
} from "../src/modules/vnext/storage.js";

/**
 * vNext TOS namespace 合同（#345 修 2）：vNext 只拥有 `vnext/` 前缀，
 * 与 Lite/完整版资产键（`prod/asset/…`、`dev/asset/…` 等）互不重叠；
 * 任何拼路径必须先过 assertVnextStoragePath，防越界写。
 */
test("vNext TOS 前缀合同：合法键可构造，越界键一律拒绝", () => {
  const projectId = randomUUID();
  const objectId = randomUUID();
  const sha256 = createHash("sha256").update("canvas-snapshot").digest("hex");

  const key = buildVnextStoragePath({ projectId, objectId, sha256, extension: "png" });
  assert.ok(key.startsWith(`${VNEXT_TOS_KEY_PREFIX}projects/${projectId}/`));
  assert.ok(key.endsWith(`_${sha256.slice(0, 16)}.png`));
  assert.ok(isVnextStoragePath(key));
  assert.doesNotThrow(() => assertVnextStoragePath(key));

  const rejected = [
    "vnext/",
    "vnext/projects",
    `vnext/projects/${projectId}`, // 缺 object 段
    `vnext/projects/${projectId}/../escape.png`, // 目录穿越
    `vnext/projects/${projectId}/${objectId}.png`, // 缺 sha256 段
    `vnext/projects/${projectId}/${objectId}_${sha256.slice(0, 16)}`, // 缺扩展名
    `vnext/projects/${projectId}/${objectId}_${sha256.slice(0, 16)}.PNG`, // 大写扩展名
    `vnext/projects/not-a-uuid/${objectId}_${sha256.slice(0, 16)}.png`,
    `vnext/assets/${projectId}/${objectId}_${sha256.slice(0, 16)}.png`, // 只允许 projects 段
    `vneXt/projects/${projectId}/${objectId}_${sha256.slice(0, 16)}.png`,
  ];
  for (const bad of rejected) {
    assert.equal(isVnextStoragePath(bad), false, `应当拒绝: ${bad}`);
    assert.throws(() => assertVnextStoragePath(bad), /vNext 存储路径/, `应当抛合同错误: ${bad}`);
  }

  // 与 Lite/完整版资产键严格不重叠：同一对象在 Lite 命名空间下的任何形态都不是 vNext 键。
  for (const liteKey of [
    `prod/asset/${projectId}/${objectId}.png`,
    `dev/asset/${projectId}/${objectId}.png`,
    `asset/${objectId}.png`,
    `prod/project/${projectId}/shots/${objectId}.png`,
  ]) {
    assert.equal(isVnextStoragePath(liteKey), false, `Lite 键不得落入 vNext 合同: ${liteKey}`);
  }
});
