# 维护命令

## doctor

当前只用于检查本地 CLI 环境：

```bash
shortdrama-cli doctor --check all --json
shortdrama-cli doctor fix --check all --yes --json
```

`doctor` 返回 ok 不能证明真实网络、FFmpeg 或业务 API 可用；仍应执行目标命令的只读检查。

## config

当前用于读取本地 CLI 配置：

```bash
shortdrama-cli config get --json
shortdrama-cli config get active_project --json
shortdrama-cli config set output_dir ./runs --json
shortdrama-cli config reset --yes --json
```

CLI 会拒绝名称包含 key/token/secret 的配置项。不要尝试绕过。

## runs

同步本地 `run-manifest.json` 或查询远程 run：

```bash
shortdrama-cli runs sync --out ./runs/episode-001 --api-url "$SHORTDRAMA_RUNS_API_URL" --token "$SHORTDRAMA_API_TOKEN"
shortdrama-cli runs status RUN_ID --api-url "$SHORTDRAMA_RUNS_API_URL" --token "$SHORTDRAMA_API_TOKEN"
```

`runs` 使用兼容 API client，和 `--api-base` 的 Main API 命令不是同一参数面；以 `runs <subcommand> --help` 为准。
