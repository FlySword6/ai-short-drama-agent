import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ASSET_VECTOR_COLLECTION_NAME } from "../src/config/vectorProjection.js";

test("env 示例与 k8s 清单使用唯一资产向量 collection", async () => {
  const [envExample, configMap] = await Promise.all([
    readFile(".env.example", "utf8"),
    readFile("deploy/k8s/base/configmap.yaml", "utf8"),
  ]);

  assert.match(envExample, new RegExp(`^MILVUS_COLLECTION_ASSET_ENTITY=${ASSET_VECTOR_COLLECTION_NAME}$`, "m"));
  assert.match(configMap, new RegExp(`^\\s+MILVUS_COLLECTION_ASSET_ENTITY:\\s+${ASSET_VECTOR_COLLECTION_NAME}$`, "m"));
});

test("启动期拒绝与唯一口径不一致的资产向量 collection", () => {
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    'await import("./src/config/env.ts")',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      MILVUS_COLLECTION_ASSET_ENTITY: `${ASSET_VECTOR_COLLECTION_NAME}_mismatch`,
    },
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stderr}\n${result.stdout}`,
    new RegExp(`MILVUS_COLLECTION_ASSET_ENTITY must equal ${ASSET_VECTOR_COLLECTION_NAME}`),
  );
});
