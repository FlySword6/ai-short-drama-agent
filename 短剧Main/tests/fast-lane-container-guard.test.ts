import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fastLaneTestFiles } from "./support/fast-lane.js";

/**
 * 2026-08-12 立。
 *
 * pre-push 只跑快测试(npm run test:node)，数据库那批交给 GitHub CI。做法是在
 * test:node 里用一串 `-g '!...'` 把真 PG 用例逐个排除掉——手工名单，随新增测试漂移。
 *
 * 当天实际撞到的后果：tests/s69-storage-deletion-integrity-db.test.ts 不在名单里，
 * 而它会 docker run 一个 postgres:14-alpine。Docker 没起来时 push 被拦下，报的是
 * 一长串 node child_process 堆栈加 "Cannot connect to the Docker daemon"，
 * 根因很难一眼看出来。
 *
 * 名单换成了按文件名后缀排除(-db / .db / -postgres)，但命名约定同样会漂。
 * 所以这里再加一层按行为判的守卫：快车道里任何文件都不许起容器。
 */

const repoRoot = path.resolve(".");

/**
 * 判据是「派生子进程去调 docker 可执行文件」，不是「文中出现 docker 字样」——
 * 后者会误伤那些只对 Dockerfile / docker-compose.yml / runner 脚本做静态断言的用例。
 */
function spawnsContainer(source: string): boolean {
  return source.includes("node:child_process") && /(["'`])docker\1/u.test(source);
}

test("快车道 test:node 里没有任何会起容器的测试", () => {
  const offenders = fastLaneTestFiles().filter((file) =>
    spawnsContainer(readFileSync(path.join(repoRoot, file), "utf8")),
  );

  assert.deepEqual(
    offenders,
    [],
    "这些用例会 docker run：要么补一个 scripts/run-*-db-test.sh 并从 test:node 排除，要么去掉容器依赖。" +
      "留在快车道里会让没起 Docker 的人 push 时看到一堆 child_process 堆栈。",
  );
});

test("S69 守卫:自带容器的删除完整性用例排除后必须仍有真 PG 证人", () => {
  const witness = "tests/s69-storage-deletion-integrity-db.test.ts";
  assert.ok(
    !fastLaneTestFiles().includes(witness),
    `${witness} 自带一次性 PostgreSQL 容器，不能留在 test:node 快车道`,
  );

  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  assert.equal(
    scripts["test:s69-storage-deletion-db"],
    "bash scripts/run-s69-storage-deletion-integrity-db-test.sh",
  );
  assert.match(
    scripts.test ?? "",
    /(?:^|&&\s*)npm run test:s69-storage-deletion-db(?:\s*&&|$)/u,
    "从默认 test 链摘掉 S69 runner 时本守卫必须报红",
  );

  // 只断言「ci.yml 里出现了这条命令」不够。2026-08-12 的 code review 逮到过：
  // 命令在，但落在 `push && refs/heads/dev` 的车道上，而它原先在快车道里、
  // 每个 PR 都真跑。门被关小，覆盖就薄了，光看命令在不在完全看不出来。
  // 所以这里连触发条件一起钉：PR 一条、dev push 一条，两条都要在。
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const jobsRunningS69 = workflow
    .split(/\n(?= {2}[a-z][a-z0-9-]*:\n)/u)
    .filter((job) => job.includes("npm run test:s69-storage-deletion-db"));

  assert.ok(
    jobsRunningS69.some((job) => /if: github\.event_name == 'pull_request'/u.test(job)),
    "S69 移出快车道前，每个 PR 都会跟着 test:node 跑到它。必须有一条 pull_request 车道接住原有触发面",
  );
  assert.ok(
    jobsRunningS69.some((job) =>
      /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/dev'/u.test(job),
    ),
    "dev push 的 verify-postgres 车道也必须真跑",
  );

  const runner = readFileSync(
    path.join(repoRoot, "scripts/run-s69-storage-deletion-integrity-db-test.sh"),
    "utf8",
  );
  assert.match(runner, /timeout 15 docker info/u, "runner 必须先预检 docker，而不是让堆栈裸奔");
  assert.match(
    runner,
    /if \[\[ "\$\{CI:-\}" == "true" \]\]; then[\s\S]*exit 1/u,
    "本地无 docker 可跳过，CI 无 docker 必须报红，跳过≠通过",
  );
  assert.match(
    runner,
    /node --import tsx --test tests\/s69-storage-deletion-integrity-db\.test\.ts/u,
  );
});
