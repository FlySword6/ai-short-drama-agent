import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * 复算 package.json 的 test:node 到底会跑哪些文件。
 *
 * 守卫不复述那串 glob——直接执行脚本里 `|` 左边的 rg 部分，
 * 这样排除规则怎么改，守卫看到的都是真实结果，不会与真源各说各话。
 */
export function fastLaneTestFiles(): string[] {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const command = pkg.scripts?.["test:node"] ?? "";
  const pipeIndex = command.indexOf("|");
  if (pipeIndex < 0) {
    throw new Error("test:node 不再是 `rg ... | xargs ...` 的形状，守卫需要同步更新");
  }
  const listFilesCommand = command.slice(0, pipeIndex).trim().replace(/\s-0$/u, "");
  const stdout = execFileSync("bash", ["-c", listFilesCommand], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.split("\n").filter((line) => line.length > 0);
}
