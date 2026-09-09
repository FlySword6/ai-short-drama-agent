import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDownloadFailure,
  parseRecoveryArgs,
} from "./fable007-recover-ark-video.mjs";

test("FABLE-007 Ark 恢复只接受窄窗口 dev 只读查找", () => {
  assert.deepEqual(
    parseRecoveryArgs(["--target", "dev", "--after-unix", "9900"], 10_000),
    { target: "dev", afterUnix: 9_900 },
  );
  assert.deepEqual(
    parseRecoveryArgs([
      "--target", "dev",
      "--after-unix", "9900",
      "--task-fingerprint", "0123456789ABCDEF",
    ], 10_000),
    { target: "dev", afterUnix: 9_900, taskFingerprint: "0123456789abcdef" },
  );
  assert.throws(
    () => parseRecoveryArgs(["--target", "prod", "--after-unix", "9900"], 10_000),
    /TARGET_MUST_BE_DEV/,
  );
  assert.throws(
    () => parseRecoveryArgs(["--target", "dev", "--after-unix", "1"], 20_000),
    /LOOKBACK_TOO_WIDE/,
  );
  assert.throws(
    () => parseRecoveryArgs([
      "--target", "dev",
      "--after-unix", "9900",
      "--task-fingerprint", "raw-task-id",
    ], 10_000),
    /TASK_FINGERPRINT_INVALID/,
  );
});

test("FABLE-007 Ark 恢复只输出固定下载失败分类", () => {
  assert.equal(
    classifyDownloadFailure(new Error("Media download failed with HTTP 403")),
    "ARK_RECOVERY_DOWNLOAD_HTTP_403",
  );
  assert.equal(
    classifyDownloadFailure(new Error("Media URL must not target a private or reserved host")),
    "ARK_RECOVERY_DOWNLOAD_SSRF_POLICY_REJECTED",
  );
  assert.equal(
    classifyDownloadFailure(new Error("secret provider body")),
    "ARK_RECOVERY_DOWNLOAD_UNKNOWN",
  );
});

test("FABLE-007 Ark 恢复脚本不输出任务 ID、URL 或原始错误正文", async () => {
  const file = await import("node:fs/promises").then(({ readFile }) => readFile(
    new URL("./fable007-recover-ark-video.mts", import.meta.url),
    "utf8",
  ));
  assert.match(file, /taskFingerprint: sha256\(candidate\.id\)/);
  assert.match(file, /error instanceof CandidateCountError/);
  assert.doesNotMatch(file, /process\.stdout\.write\([^;]*temporaryUrl/);
  assert.doesNotMatch(file, /process\.stderr\.write\([^)]*error\.message/);
});
