/**
 * dev:reset —— 干净地推倒重来：停库、删数据卷、清掉上一轮的初始密码文件，
 * 然后完整重跑 dev:up（起库→迁移→Day-0 管理员→演示数据）。
 *
 * 删卷前先过一遍护栏：配置指向云端时报错停下，不让"我以为在清本地"变成事故。
 */
import { existsSync, rmSync } from "node:fs";
import { assertDevDatabaseTarget } from "./dev-guard.mts";
import {
  ensureDotEnv,
  initialAdminPasswordFile,
  loadEffectiveEnv,
  runCompose,
  runTsx,
} from "./dev-env.mts";

async function main(): Promise<void> {
  ensureDotEnv();
  const env = loadEffectiveEnv();
  assertDevDatabaseTarget(env);

  console.log("== 停库并删除本地数据卷 ==");
  await runCompose(["down", "-v"]);
  if (existsSync(initialAdminPasswordFile)) {
    rmSync(initialAdminPasswordFile);
    console.log("已清掉上一轮的初始密码文件。");
  }

  console.log("\n== 重新起一整套干净的 dev 环境 ==");
  await runTsx("scripts/dev-up.mts");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
