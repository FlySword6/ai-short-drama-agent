/**
 * scripts/dev-* 的共享辅助：仓库根、compose 文件、子进程执行、.env 生成与读取。
 * 不 import src/，保持可独立运行。
 */
import { existsSync, readFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { effectiveDevEnv, parseEnvFile } from "./dev-guard.mts";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const devComposeFile = path.join(repoRoot, "docker-compose.dev.yml");
export const dotEnvPath = path.join(repoRoot, ".env");
export const dotEnvExamplePath = path.join(repoRoot, ".env.example");
export const initialAdminPasswordFile = path.join(repoRoot, "runtime", "dev", "initial-admin-password.txt");

/** 没有 .env 就从 .env.example 复制一份（example 本身就是按 dev 默认值写的）。 */
export function ensureDotEnv(): { created: boolean } {
  if (existsSync(dotEnvPath)) return { created: false };
  copyFileSync(dotEnvExamplePath, dotEnvPath);
  return { created: true };
}

export function loadEffectiveEnv(): Record<string, string | undefined> {
  const dotenvValues = existsSync(dotEnvPath) ? parseEnvFile(readFileSync(dotEnvPath, "utf8")) : {};
  return effectiveDevEnv(dotenvValues);
}

/** 以仓库根为 cwd 跑一个命令，stdio 直传，非零退出即抛错。 */
export function run(command: string, args: readonly string[], extraEnv?: Record<string, string>): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Windows 上 npx/npm 是 .cmd 包装，spawn 默认不解析后缀也不走 shell，会 ENOENT。
    // 加 shell:true 走 cmd.exe 解析；含空格的参数 Node 会自动加引号，docker/npx 均安全。
    const child = spawn(command, [...args], {
      cwd: repoRoot, stdio: "inherit", env: { ...process.env, ...extraEnv }, shell: true,
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(" ")} 退出码 ${code}`));
    });
  });
}

export function runCompose(args: readonly string[]): Promise<void> {
  return run("docker", ["compose", "-f", devComposeFile, ...args]);
}

/** 通过 npx 调本地 tsx 跑一个 TypeScript 脚本（迁移、Day-0 引导、播种）。
 *  extraEnv 用于把密码这类值只传给子进程，不落到日志或命令行参数里。 */
export function runTsx(
  scriptPath: string,
  args: readonly string[] = [],
  extraEnv?: Record<string, string>,
): Promise<void> {
  return run("npx", ["tsx", scriptPath, ...args], extraEnv);
}

/** Day-0 管理员用户名：取 ADMIN_USERNAMES 第一个，兜底 admin。 */
export function devAdminUsername(env: Record<string, string | undefined>): string {
  const first = (env.ADMIN_USERNAMES ?? "").split(",").map((item) => item.trim()).filter(Boolean)[0];
  return first ?? "admin";
}
