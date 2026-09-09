# 安全轮询与最终回报

1. 从提交响应读取 `task_id` 和当前 `status`。
2. 若为 `submitted`/处理中，调用：

```bash
shortdrama-cli task get TASK_ID \
  --wait \
  --json
```

3. 终态为 `succeeded` 时，读取响应中的真实结果 URL；不要自行拼 URL。
4. 当前 `task download` 尚未接入真实业务 API，不要调用。
5. 最终回报示例：

```text
任务已完成（真实业务 API）。
项目：proj_...
任务：task_...
状态：succeeded
结果：https://...
本地下载：当前 CLI 版本尚未提供真实下载能力。
```

若响应没有真实结果 URL，报告“服务端未返回可交付结果”，不要自行拼接链接。
