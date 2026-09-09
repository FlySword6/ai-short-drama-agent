# Pi HTTP Wrapper 收编与运行合同

状态：`implemented_pending_host_validation`

Owner：DC

代码目录：`pi-http-wrapper/`

基线：`integration/v011@3bf1f3c`

## 1. 来源与版本归属

2026-07-21 已从 `root@101.126.45.91:/root/pi-http-wrapper` 只读收编：

- `server.py`：SHA-256 `2ff23d8068e4dc1c8023b922b97fd0f923e1c139dbe1b611dc0f809530404b60`；
- `client.py`：SHA-256 `444137c01c7b075c939c353552c5f930099dfe76b97c661545db24e6a9a7b716`；
- `pi-chat.py`：SHA-256 `10cbcf5fad3ed745c167e298ca27567282a9febeef902db0720859e34fa96ac8`。

原目录不是 Git 仓库，也没有可核实的作者标头。DC 提供吴济平为原维护人；因此提交保留
`Original-maintainer: 吴济平`，但作者归属标为 `unverified`。原样代码位于
`pi-http-wrapper/upstream/original/`，适配代码另行提交。没有收编 `.api_key`、环境变量、日志或凭据。

## 2. 运行边界

- 主仓 `Agent.streamFn` 是唯一产品接入点；
- 业务工具始终由主仓本地执行并审计，wrapper 只负责让 Pi 发出工具调用并等待结果；
- 主仓 PostgreSQL 中的对话历史是唯一事实源。wrapper 在一轮完成后销毁 `pi --no-session`
  进程，不保存长期会话；
- 只有等待 `toolResult` 的短暂期间保留内存态，同一时刻只处理一轮；并发新轮返回 409；
- 等待工具结果超过配置时限会终止该 Pi 进程并释放轮次，不会永久占住 runtime；
- 停止 Pi 时同步清除 busy 与活动轮次；每次启动分配新的 reader generation，已停止进程的
  stdout reader 即使延迟退出也不能改变新进程的 running/busy 状态；
- 每个新轮生成不可复用的随机 `turnNonce`，通过 0600 context 仅交给该轮 Pi extension；内部
  tool callback 必须同时匹配 `turnNonce` 与 `conversationId`。完成、stop 或 abort 会撤销该
  nonce，旧进程的延迟 callback 返回 409，且不会进入 bridge 或产出陈旧 tool call；
- Pi 内建编码工具在产品运行时关闭，只加载 allowlist 中已启用的 skill；
- wrapper 不创建生成报价或任务，不替用户触发任何付费生成。

## 3. 请求合同

入口：

- `POST /pi/prompt/sync`，兼容别名 `/prompt/sync`；
- `POST /pi/prompt`，兼容别名 `/prompt`，返回 SSE。

请求体：

```json
{
  "conversationId": "conv-123",
  "system": "产品侧系统提示词",
  "messages": [{"role": "user", "content": "查找雨夜巷口资产"}],
  "tools": [{
    "name": "search_assets",
    "description": "检索资产",
    "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}}
  }],
  "toolResults": []
}
```

- 新一轮必须有至少一条 `user` 消息；`conversationId` 可省略，由 wrapper 生成并返回；
- 旧客户端的 `message: string` 继续兼容，但主仓只使用 `messages`；
- 工具续推理只允许提交同一 `conversationId` 和完整的 `toolResults`；不可同时改
  `system`、`messages` 或 `tools`；
- `toolCallId` 必须与当前悬挂调用精确匹配。错会话、未知、缺失或重复 ID 均返回 409，
  不会重新发送用户消息或重放工具。

## 4. sync 响应合同

```json
{
  "requestId": "req-123",
  "conversationId": "conv-123",
  "status": "completed",
  "text": "已找到资产",
  "thinking": null,
  "toolCalls": [],
  "toolResults": [],
  "messages": [],
  "usage": {
    "status": "reported",
    "inputTokens": 120,
    "outputTokens": 40,
    "totalTokens": 160,
    "cost": null,
    "costKnown": false
  }
}
```

`status` 只有：

- `completed`：本轮结束，wrapper 已销毁 Pi 会话；
- `requires_tool`：返回一个或多个 `{id,name,arguments}`，Pi 暂停等待主仓结果。

模型没有报告用量时，`usage.status=unknown`，token 和 cost 全为 `null`；未知成本绝不写成 0。

## 5. SSE 合同

只允许下列事件，不透传 Pi 内部原始事件：

| event | data |
| --- | --- |
| `meta` | `{type,requestId,conversationId}` |
| `text_delta` | `{type,delta}` |
| `thinking_delta` | `{type,delta}` |
| `tool_call` | `{type,toolCall:{id,name,arguments}}` |
| `usage` | `{type,usage}`，字段与 sync 相同 |
| `done` | `{type,status,conversationId}` |
| `error` | `{type,code,message,requestId,retryable}` |

遇到工具调用时，当前 HTTP 流依次发 `tool_call`、`done(status=requires_tool)` 后关闭。
主仓完成本地工具执行并落库，再用同一 `conversationId` 和 `toolResults` 续请求。

## 6. 错误与降级

- 401：Bearer 缺失或无效；
- 422：请求字段或类型不符合合同；
- 409：`runtime_busy`、`invalid_continuation`、`conversation_mismatch`、
  `unknown_tool_call` 或 `missing_tool_result`；
- 503：Pi runtime 不可用；
- SSE 已发送响应头后，以 `error` 事件报告并关闭。

主仓不得对 401/403/409/422 或协议错误静默降级。只有网络错误或 503，且尚未产生
`text_delta`/`tool_call` 等业务可见事件时，才可把整轮切到 Ark；一旦出现业务可见事件，
整轮锁定 remote，避免重复文本或重复副作用。

## 7. 技能、安全与审计

- `GET /pi/skills`、`POST /pi/skills/{id}/enable|disable`；
- 只枚举 `~/.agents/skills/*/SKILL.md` 和 `~/.workbuddy/skills/*/SKILL.md`；
- 启停只写 wrapper state，不修改 skill 源文件；运行中修改返回 409 并回滚状态；
- 外部鉴权只读 `PI_WRAPPER_BEARER_TOKENS`，支持多 token 轮换；
- Pi 扩展回调使用独立 `PI_WRAPPER_INTERNAL_TOKEN`；
- `.api_key` 和 `PI_WRAPPER_API_KEY_FILE` 直接拒绝启动；
- wrapper 审计只记录 token 截断指纹、请求 ID、端点、结果和计数，不记提示词、参数、
  工具结果或 token；产品侧审计继续写主仓 `agent_messages`，不另建第二事实表。

## 8. 服务化与回滚

`deploy/pi-http-wrapper.service` 以 `piwrapper` 非 root 用户运行，根文件系统只读，只开放
`/var/lib/pi-http-wrapper` 与 `/var/log/pi-http-wrapper`。环境文件由 KMS/受管 secret 投递到
`/etc/shortdrama/pi-http-wrapper.env`（0600）。默认只监听 `127.0.0.1:8787`；如需跨主机，
仅在私网安全组内改 `PI_WRAPPER_HOST=0.0.0.0`，不得直接暴露公网。

安装脚本会把原 root 服务下两个 allowlist 根中的 skill 首次复制到 `piwrapper` 管理目录，
遇到符号链接会跳过，已有同名目录不会覆盖。后续 skill 更新直接交付管理目录，不再依赖 `/root`。

回滚：停止服务，把 `/opt/shortdrama/pi-http-wrapper/current` 指回上一 release，重启服务。
不得恢复旧 `.api_key`。

## 9. 当前验证边界

已用 Python 3.12 假 Pi manager 验证协议、工具暂停/续推理、会话错配、未知工具 ID、稳定 SSE、
显式未知用量、认证、审计和技能 allowlist。尚未在原 ECS 上安装 systemd，也未调用真实模型，
因此真实 Pi 0.80.7 的端到端流式行为仍是部署前验证门。
