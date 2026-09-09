/**
 * dev:down —— 停掉本地开发库。数据卷保留，下次 dev:up 数据还在；
 * 要连数据一起清掉用 npm run dev:reset。
 */
import { runCompose } from "./dev-env.mts";

async function main(): Promise<void> {
  await runCompose(["down"]);
  console.log("本地开发库已停（数据卷保留）。重新起：npm run dev:up；清空重来：npm run dev:reset");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
