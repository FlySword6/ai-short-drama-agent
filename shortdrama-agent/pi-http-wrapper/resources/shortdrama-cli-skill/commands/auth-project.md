# `auth` 与 `project`

## 登录

真实 API 登录只需要用户名（后端地址由受信端点清单决定；需要非默认环境时加 `--env <环境名>`）。密码省略时由 CLI 安全提示输入：

```bash
shortdrama-cli auth login \
  --username "$SHORTDRAMA_USERNAME" \
  --json
```

不要把密码直接写进可见脚本或对话命令。登录后使用：

```bash
shortdrama-cli auth status --json
shortdrama-cli auth info --json
shortdrama-cli auth refresh --json
shortdrama-cli auth logout --json
```

`--profile` 可隔离本地 session。后端地址通过 `--env` 或 `SHORTDRAMA_ENV` 环境名选择（prod/test/dev），由 CLI 受信端点清单决定，不接受 URL。

## 项目

```bash
shortdrama-cli project create \
  --name "项目名" \
  --description "项目说明" \
  --aspect-ratio 9:16 \
  --resolution 1080p \
  --fps 24 \
  --json

shortdrama-cli project list --json
shortdrama-cli project info --project PROJECT_ID --json
shortdrama-cli project update --project PROJECT_ID --name "新名称" --json
```

真实 Main API 当前只持久化项目 code/name/description；create 响应中的 `local_preferences` 只是分辨率、画幅、帧率和风格偏好回执。

归档会改动远端状态，必须由用户明确要求并保留确认：

```bash
shortdrama-cli project archive --project PROJECT_ID --yes --json
```

`project use`、`delete`、`export` 当前未接入真实业务 API，不要调用。
