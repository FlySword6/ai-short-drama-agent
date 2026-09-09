import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const configPath = path.join(root, "config/repository-size-allowlist.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const errors = [];

if (config.schema !== "shortdrama-repository-size-allowlist/v1") {
  errors.push("体积门禁白名单 schema 无效");
}
if (!Number.isInteger(config.defaultMaxBytes) || config.defaultMaxBytes < 1) {
  errors.push("defaultMaxBytes 必须是正整数");
}
if (!Number.isInteger(config.docsImageMaxBytes) || config.docsImageMaxBytes < 1) {
  errors.push("docsImageMaxBytes 必须是正整数");
}

const exceptions = new Map();
for (const exception of config.exceptions ?? []) {
  const normalized = path.posix.normalize(exception.path ?? "");
  if (
    !exception.path ||
    path.isAbsolute(exception.path) ||
    normalized !== exception.path ||
    exception.path.startsWith("../") ||
    !Number.isInteger(exception.maxBytes) ||
    exception.maxBytes < 1 ||
    typeof exception.reason !== "string" ||
    exception.reason.trim() === ""
  ) {
    errors.push(`体积门禁白名单项无效: ${exception.path ?? "(missing path)"}`);
    continue;
  }
  if (exceptions.has(exception.path)) {
    errors.push(`体积门禁白名单路径重复: ${exception.path}`);
    continue;
  }
  exceptions.set(exception.path, exception);
}

const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .sort();
const forbiddenExtensions = new Set(
  (config.forbiddenExtensions ?? []).map((extension) => extension.toLowerCase()),
);
const imageExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
let checked = 0;
let allowedByException = 0;
let largest = { path: "", bytes: 0 };

for (const relativePath of listed) {
  let stat;
  try {
    stat = lstatSync(path.join(root, relativePath));
  } catch {
    continue;
  }
  if (!stat.isFile()) continue;
  checked += 1;

  const exception = exceptions.get(relativePath);
  if (exception) {
    allowedByException += 1;
    if (stat.size > exception.maxBytes) {
      errors.push(
        `${relativePath} 为运行时豁免，但 ${stat.size} bytes 超过豁免上限 ${exception.maxBytes}`,
      );
    }
    continue;
  }
  if (stat.size > largest.bytes) largest = { path: relativePath, bytes: stat.size };

  const extension = path.extname(relativePath).toLowerCase();
  if (forbiddenExtensions.has(extension)) {
    errors.push(`${relativePath} 使用默认禁止入仓的资料扩展名 ${extension}`);
    continue;
  }
  const maxBytes =
    relativePath.startsWith("docs/") && imageExtensions.has(extension)
      ? config.docsImageMaxBytes
      : config.defaultMaxBytes;
  if (stat.size > maxBytes) {
    errors.push(`${relativePath} 为 ${stat.size} bytes，超过门禁上限 ${maxBytes}`);
  }
}

for (const exceptionPath of exceptions.keys()) {
  if (!listed.includes(exceptionPath)) {
    errors.push(`体积门禁白名单指向未跟踪文件: ${exceptionPath}`);
  }
}

if (errors.length > 0) {
  console.error("仓库体积门禁失败:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `仓库体积门禁通过：检查 ${checked} 个文件，${allowedByException} 个运行时豁免；`
    + `最大普通文件 ${largest.path} (${largest.bytes} bytes)。`,
);
