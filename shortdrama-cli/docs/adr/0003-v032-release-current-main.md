# ADR 0003：用 0.3.2 发布当前 v0.3 主干

状态：发版准备已实现并通过本地门禁，PR 复核整改中；未创建 tag、未 publish

关联工作项：[Issue #72](https://github.com/col-shortdrama/zhongwen-shortdrama-cli/issues/72)、[Issue #71](https://github.com/col-shortdrama/zhongwen-shortdrama-cli/issues/71)、[Issue #47](https://github.com/col-shortdrama/zhongwen-shortdrama-cli/issues/47)

交付分支：`prep/issue-72-release-0.3.1`

## 背景

发版准备基线是 `origin/main@697f773b74069663caa44f9eaf027f12e8235218`。公开可得的
`0.0.2-beta` 仍调用旧 `/models`、`*-generations`、`generation-tasks`、`scripts*` 与
`seedance-assets/*` 路径，不能验收 v0.3 服务。

仓库已经存在 `v0.3.1` tag，固定指向历史提交
`dc66e288b110b1d0fa708ec86ef9f4503e389b1e`；对应 GitHub Release 仍是 Draft。移动这个 tag
会破坏不可变发布身份，也会让现有 Draft 的来源失真。

## 决策

不移动、不删除 `v0.3.1`。把当前主干的 package、运行时、`uv.lock`、随包 Skill manifest、
版本断言与火山构建脚本一起推进到 `0.3.2`。最终 `v0.3.2` tag 只能创建在本 PR 合并后的
精确 `main` SHA；发版人读回该 SHA 后，必须从受保护 `main` 手动 dispatch release workflow，
同时提交 `tag` 与完整 40 位 `main_commit`。

workflow 不接受 tag push 自动触发：tag 不能提供用于验证自身的 workflow/provenance 代码。
首个 `provenance` job 在 `release` environment 保护下固定 dispatch 时的受保护 `main` 提交，
校验 tag、授权 SHA 与该提交的祖先关系，输出唯一 `release_sha`；build/stage/security/publish
全部消费该 SHA；stage 与 publish 在写 GitHub Release 的同一 step 通过 API 重读 tag，
并受同一个 `release` environment 审批。

`CHANGELOG.md` 的首个版本、Skill manifest、`pyproject.toml`、`shortdrama_cli.__version__`
与 release tag 进入同一 `release.py validate` 门，避免下一次只改其中一处。

## 服务端合同对齐

现行真源是 `docs/v030-command-api-matrix.md`。静态核对确认：

- 所有生产命令经 `server_api/` 调用当前 `/api/v1` 路由；
- 动态 ID 逐 path segment 编码；
- 响应必须符合 `{ok:true,data:{...}}`；
- 目的地只接受内置 `prod|test|dev` 环境名，不恢复任意 URL；
- 发行命令面不再调用 beta 路由；
- 付费生成继续执行估价 → 人工确认 → 提交，没有 `--yes` 或自动付费重试。

本次不增加服务端 shim。真实部署若仍缺单一路径，必须另有调用证据、独立卡和退役条件。

## 自动门

当前 release workflow：

1. 只允许从受保护 `main` 手动触发，校验完整 `main_commit` 与 tag 指向完全相同；
2. 把该提交冻结为单一 `release_sha`，五平台 build、stage、security 与 publish 不再重解可变 ref；
3. 校验 tag、package、运行时、Skill manifest 与 changelog 版本；
4. 构建五个平台产物；
5. 扫描源码与解包后的应用；
6. 从实际 staged artifacts 生成 `checksums.txt` 与 `manifest.json`；
7. 执行打包后的 Linux x64 CLI，并确认随包 Skill 存在；
8. publish 前重读 tag，只有仍指向冻结 SHA 且 release/security gate 都成功才发布。

火山构建脚本默认 tag 与 Python 下限同步为 `v0.3.2` / Python 3.11，不再默认构建退役 beta。

## 仍需人工回执

本 PR 不创建 tag、不 publish、不部署、不调用付费模型。授权发版人仍需：

- 确认 `v*` tag ruleset 禁止 force-update/删除，且仅授权发版人可创建 release tag；
- 读回合并后的精确 `main` SHA，并在该提交创建 `v0.3.2`；
- 确认 GitHub `release` environment 仅允许受保护 `main`，并配置授权发版人审批；
- 从 `main` 手动触发 workflow，输入 `v0.3.2` 与上一步完整 40 位 SHA；
- 在 Test 受信环境完成 `doctor`、登录及最小只读 v0.3 命令矩阵；
- 确认真实 release workflow 的 `publish` job 执行且成功；
- 按排期运行独立 zero-guidance workflow；
- 将跨系统延期项明确记为 deferred，不得写成 pass。

#47 的真 PostgreSQL 付费红线仍是 deferred：责任线为 col；恢复条件是 main#288 后出现可从 CI
安全访问的 Test PostgreSQL。届时 schema 由 main 仓 migration runner 创建，验证入口沿用
`tests/generation-quotes-db.test.ts`，不能用 mock 或生产库代替。在条件出现前它不阻塞 CLI
自有确定性门，但必须保留为未完成证据。

## 后果

- `v0.3.1` 保持历史事实，不发生 tag rewrite。
- 普通用户从 `0.0.2-beta` 直接迁移到 `0.3.2`；当前源码使用者无需兼容层。
- Issue #72 只有在真实 publish 与 Test 只读冒烟回贴后才能关闭；合并本准备 PR 不等于已发布。
