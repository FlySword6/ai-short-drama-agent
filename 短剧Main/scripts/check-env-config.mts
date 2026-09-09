#!/usr/bin/env tsx
/**
 * 环境配置对账：核对某个环境该配的键是否齐。
 *
 * 只读。绝不打印任何密钥值——密钥一律只报「有 / 缺」。
 *
 *   npx tsx scripts/check-env-config.mts --target test-env
 *   npx tsx scripts/check-env-config.mts --target dev
 *
 * 退出码 0 = 齐；1 = 有缺失或有孤儿键。
 *
 * 起因（2026-08-09）：一线同事在测试环境点「新建项目」被拒，根因是
 * ALLOW_MEMBER_CREATE_PROJECT 代码默认 "false" 且集群从未注入这个键。
 * 运维查集群查不到它，不看代码就不知道它存在。本脚本让这类漏配在
 * 启动前就能被一条命令查出来，而不是等人点按钮才发现。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = ["dev", "test-env", "production"] as const;
type Target = (typeof TARGETS)[number];

interface EnvManifest {
  target: string;
  required: Record<string, string>;
  secrets: string[];
}

/** 键名像密钥就当密钥待遇：只报有无，不读值、不打印值。 */
const SECRET_NAME_PATTERN = /(API_?KEY|APIKEY|SECRET|PASSWORD|TOKEN|ACCESS_KEY|CREDENTIAL|_SHA256$)/i;

function parseTarget(argv: readonly string[]): Target {
  const index = argv.indexOf("--target");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  if (!raw) {
    throw new Error(`必须指定 --target <${TARGETS.join(" | ")}>`);
  }
  if (!TARGETS.includes(raw as Target)) {
    throw new Error(`未知环境 ${raw}；只支持 ${TARGETS.join(" / ")}`);
  }
  return raw as Target;
}

/**
 * 从 env.ts 里抠出所有声明过的键名。用正则而不是 import，是为了让本脚本
 * 在「配置本身不完整、env.ts 加载会抛」的时候仍然能跑——那恰恰是最需要它的时候。
 *
 * 注意：键名不一定全大写。实查 env.ts 里就有 `doubao_seedence_mini`
 * 这种小写键（2026-08-09），只匹配大写会把它误判成「代码不认的键」。
 * 同时要排掉 zod 链上的属性名（如 required_error）与对象字面里的非键行，
 * 所以只认「缩进 2 格 + 键名 + 冒号 + 空格」这一种形状。
 */
async function declaredKeys(repoRoot: string): Promise<Set<string>> {
  const source = await readFile(path.join(repoRoot, "src/config/env.ts"), "utf8");
  const keys = new Set<string>();
  for (const match of source.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_.]*):\s/gmu)) {
    keys.add(match[1]!);
  }
  return keys;
}

async function main(): Promise<void> {
  const target = parseTarget(process.argv.slice(2));
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifestPath = path.join(repoRoot, "config", `env.${target}.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as EnvManifest;

  const declared = await declaredKeys(repoRoot);
  const listed = new Set([...Object.keys(manifest.required), ...manifest.secrets]);

  const missingRequired = Object.keys(manifest.required)
    .filter((key) => !(key in process.env) || process.env[key] === undefined);
  const missingSecrets = manifest.secrets
    .filter((key) => !process.env[key]?.trim());
  // 清单里写了、但代码根本不认的键：要么代码删了没同步清单，要么键名拼错。
  const unknownInManifest = [...listed].filter((key) => !declared.has(key)).sort();
  // 代码声明了、三份清单都没提的键：静默走默认值的灰色地带。
  const orphanInCode = [...declared].filter((key) => !listed.has(key)).sort();

  console.log(`[check-env-config] target=${target}`);
  console.log(`  清单声明:必配 ${Object.keys(manifest.required).length} 个、密钥 ${manifest.secrets.length} 个`);
  console.log(`  代码声明:${declared.size} 个键`);

  if (missingRequired.length > 0) {
    console.error(`\n缺少必配键 ${missingRequired.length} 个(当前进程环境里没有):`);
    for (const key of missingRequired) console.error(`  - ${key}`);
  }
  if (missingSecrets.length > 0) {
    // 只报键名,绝不报值
    console.error(`\n缺少密钥 ${missingSecrets.length} 个(只报键名):`);
    for (const key of missingSecrets) console.error(`  - ${key}`);
  }
  if (unknownInManifest.length > 0) {
    console.error(`\n清单里有、代码不认的键 ${unknownInManifest.length} 个(拼错或代码已删):`);
    for (const key of unknownInManifest) console.error(`  - ${key}`);
  }
  if (orphanInCode.length > 0) {
    console.log(`\n代码声明了、清单未提的键 ${orphanInCode.length} 个(静默走默认值,建议逐个归类):`);
    for (const key of orphanInCode) {
      const suffix = SECRET_NAME_PATTERN.test(key) ? "  ← 名字像密钥,应进 secrets" : "";
      console.log(`  - ${key}${suffix}`);
    }
  }

  const failed = missingRequired.length > 0 || missingSecrets.length > 0 || unknownInManifest.length > 0;
  if (failed) {
    console.error("\n结论:不齐。上面列的键要么注入,要么从清单里删掉,别留着当谜。");
    process.exitCode = 1;
    return;
  }
  console.log("\n结论:必配键与密钥键齐全。");
}

const isDirectRun = process.argv[1]?.endsWith("check-env-config.mts")
  || process.argv[1]?.endsWith("check-env-config");
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
