# WorkBuddy 远程接入 ECS Pi Agent 操作手册（复现）

> 目标：从远程（workbuddy 侧 / 任意 HTTP 客户端）通过 API 接入 ECS 上的 pi agent，
> 驱动其执行 shortdrama-cli 能力盘点清单，并完成逐项测试。
> 本文所有路径、端口、鉴权、返回格式均于 2026-08-06 13:5x（UTC+8）在 ECS 上实测验证。

---

## 一、接入拓扑（先看懂这条链）

```
远程客户端 / workbuddy（zhongwen-shortdrama 主仓 RemotePiProvider）
   │  HTTPS（自签证书，-k）
   ▼
ECS 边缘 nginx :8443（唯一对外入口，IP 白名单见 §2.2）
   ├── /api/*  ──────────────► admin-service :8000（Python FastAPI，无 basic auth，自带鉴权）
   │      ├── /instances/*       每用户 pi 进程管理（start/stop/status）
   │      ├── /chat  /events     SSE 流式（自动拉起 + 推 prompt + 收事件）
   │      ├── /prompt /steer /abort /bash
   │      ├── /pi/prompt/sync    workbuddy 主仓专用同步推理端点（Bearer PI_SYNC_TOKEN）
   │      ├── /pi/chat           OpenAI 兼容同步端点（Bearer PI_SYNC_TOKEN）
   │      └── /api/auth/*        shortdrama 会话登录/状态/续期（租户级 HOME 隔离）
   └── /user-006/ /user-007/ /user-008/  ► pi-web 面板 :8506~8508（basic auth，人工浏览用，非 API 路径）

admin-service 启动的 pi 实例（每用户一个，串行 RPC 子进程）：
   <用户工作目录>/agent-a/{user}/run-pi.sh  →  exec pi --mode rpc --no-session
      ├── 注入 PI_USER_ID / SHORTDRAMA_PROFILE / PI_ROLE / PI_PROJECT_ID
      ├── PATH 优先用户 bin/（角色 wrapper shortdrama-cli，白名单拦截）
      └── cwd = <用户工作目录>/agent-a/{user}/workspace
```

**三种接入方式对比**

| 方式 | 路径 | 用途 |
|------|------|------|
| A. workbuddy 主仓 | `POST /api/pi/prompt/sync`、`/api/pi/chat`（Bearer token） | 产品正式链路：主仓把 LLM 推理 offload 到 ECS，工具执行留在主仓本地 |
| B. 直接驱动 agent | `POST /api/chat`（SSE）、`/api/prompt`、`/api/bash`（X-Agent-Id/X-User-Id） | 试点测试：让 ECS 上 pi agent 自己跑 CLI/工具，全流程可观测 |
| C. 人工面板 | `https://host:8443/user-006/`（basic auth） | pi-web 网页 UI，人工确认产物/看会话 |

> 复现能力清单推荐 **方式 B**：agent 直接在主仓工具链上执行 shortdrama-cli，便于逐条对照清单；
> 若只验证「workbuddy 接入本身」，用 **方式 A** 的最小 ping。

---

## 二、远程网络接入

### 2.1 基本信息

| 项 | 值 |
|----|-----|
| 公网地址 | `<ECS公网地址>`（ECS；业务 API 为另一台 `<业务API地址>`） |
| 接入端口 | `8443`（HTTPS，nginx，自签证书 tls.crt/tls.key 位于 <配置目录>/pi-web/） |
| 证书 | 自签 → 客户端必须 `-k` / `verify=False` / 加载 tls.crt 作 CA |
| 端口 80 | nginx HTTP（仅跳转，不承载 API） |

### 2.2 防火墙（nft，实测生效）

`<配置目录>/pi-web/s53-piweb.nft` 仅放行 8443：

```text
loopback             → 8443 放行
<白名单IP-A>       → 8443 放行（已在用，计数器 ~105 万包）
<白名单IP-B>       → 8443 放行（未产生流量，注意）
其余                 → 8443 drop
```

> ⚠️ 远程可达性：若你的出口 IP 不在上述白名单，先加 nft 规则
> （`nft insert rule inet s53_piweb input ip saddr <YOUR_IP> tcp dport 8443 accept`）再测。
> ⚠️ admin-service :8000 绑定 0.0.0.0 且未被 nft 限制，理论上公网可达——但**不要直连**，
> 一律走 nginx :8443（云安全组若已放行 8000，建议关闭，只留 8443）。

### 2.3 认证分层

| 层 | 位置 | 机制 | 凭据 |
|----|------|------|------|
| TLS | nginx | 自签证书 | `-k` 跳过校验 |
| basic auth | `/user-XXX/` pi-web 面板 | `auth_basic` | `/etc/nginx/.htpasswd.pi`（per-user 路由用）；根 `/` 用 `/etc/nginx/pi-web.htpasswd` |
| API 鉴权 | `/api/*` 走 admin-service | `auth_basic off`，admin-service 自带 | 见下方两种 token |

`/api/*` 两类鉴权（实测 401 行为）：
- `/api/pi/prompt/sync`、`/api/pi/chat`：`Authorization: Bearer <PI_SYNC_TOKEN>`
  （server.py 默认 `PI_SYNC_TOKEN=<PI_SYNC_TOKEN>`，进程环境未覆盖，实测生效；生产应改为受管 secret）
- `/api/auth/*`：无需 token（用户名密码走 body / CLI stdin）
- 其余 `/api/instances/*`、`/api/chat`、`/api/bash` 等：**当前无 token 校验**，仅靠
  `X-Agent-Id`/`X-User-Id` 头路由 → 仅限受信网络/内网使用，公网暴露前必须加鉴权

### 2.4 连通性自检（远程首测命令）

```bash
# 1. TLS + 路由通（返回 JSON 即通）
curl -sk "https://<ECS公网地址>:8443/api/auth/status?user_id=user-006" --max-time 10

# 2. 全实例健康（应见 4 个 ready 实例）
curl -sk https://<ECS公网地址>:8443/health --max-time 10

# 3. workbuddy 链路最小验证（走 /api/ 前缀）
curl -sk https://<ECS公网地址>:8443/pi/prompt/sync \
  -X POST -H "Authorization: Bearer <PI_SYNC_TOKEN>" -H "Content-Type: application/json" \
  -d '{"prompt":"ping"}' --max-time 60
# 期望: {"status":"done","text":"pong 🏓 — CLI 在线...","conversationId":"","usage":{...}}

# 4. 直驱 agent 最小验证（SSE）
curl -skN https://<ECS公网地址>:8443/chat \
  -X POST -H "Content-Type: application/json" \
  -H "X-Agent-Id: agent-a" -H "X-User-Id: user-006" \
  -d '{"message":"只回复：ok"}' --max-time 60
# 期望: 一串 SSE 事件，结尾 event: agent_settled / done
```

> 注意：curl 直连 127.0.0.1:8443 且不带 `Host: <ECS公网地址>` 会命中默认 server
> （无 /api/ 路由，返回 Empty reply）。远程访问天然带正确 Host，不受影响；本机测试加 `-H "Host: <ECS公网地址>"`。

---

## 三、API 速查（全部端点，实测）

### 3.1 实例与健康

| 方法/路径 | Body / 头 | 说明 |
|-----------|-----------|------|
| `GET /health` | — | 实例状态汇总（status/pid/uptime/error） |
| `GET /instances` | — | 全部被跟踪实例 |
| `POST /instances/start` | `{"agent_id":"agent-a","user_id":"user-006"}` | 启动 pi RPC 进程 |
| `POST /instances/stop` | 头 `X-Agent-Id`,`X-User-Id` | 停止 |
| `POST /instances/stop-all` | — | 全停 |
| `GET /users` / `GET /api/users` | — | 磁盘租户 + 已自举用户 |
| `POST /api/users/auto-provision` | `{"role":"art\|writer\|director","project_id":"drama-001"}` | 自动创建新角色用户（nginx/pi-web/pi 全链路） |
| `GET/DELETE /api/users/{user_id}` | — | 查/删用户 |

### 3.2 会话认证（shortdrama 业务 API 的 24h token）

| 方法/路径 | Body | 说明 |
|-----------|------|------|
| `GET /api/auth/status?user_id=user-006` | — | 租户会话状态（读该租户独立 HOME 的 default.json） |
| `POST /api/auth/refresh` | `{"user_id":"user-006"}` | 用 refreshToken 续期（实测：user-006 成功，user-007/008 失败=refreshToken 也已过期） |
| `POST /api/auth/login` | `{"user_id":"...","username":"...","password":"..."}` | 登录；密码经 CLI stdin 传给 shortdrama-cli，不进 argv |

判定：`authenticated:true` 即业务 API 可用；false 时先 refresh，refresh 失败再 login。

### 3.3 直驱 agent（复现清单主用）

| 方法/路径 | Body | 说明 |
|-----------|------|------|
| `POST /chat` | `{"message":"...","images":[...]}` | **SSE 流式**：未启动自动拉起 → prompt → 逐事件输出，`agent_settled`/`done` 结束。推荐 |
| `POST /prompt` | `{"message":"..."}` | 仅投递 ack，需另开 `GET /events` 收流（两连接时序易错，测试少用） |
| `GET /events` | 头 `X-Agent-Id`,`X-User-Id` | SSE 订阅（`agent_settled` 后自动断流） |
| `POST /steer` | `{"message":"..."}` | 打断/插入指令 |
| `POST /abort` | 头 | 中止当前回合 |
| `POST /bash` | `{"command":"echo hi"}` | **在用户 workspace 直接执行 shell**（不经 agent 判断，复现清单最快的探针） |
| `GET /doc/p3` | — | 平台演进与测试文档（P3 21 步） |
| `GET /dashboard` | — | 三角色用户状态仪表盘 HTML |

### 3.4 workbuddy 主仓同步端点（RemotePiProvider 协议）

`POST /api/pi/prompt/sync`（需 `Authorization: Bearer <PI_SYNC_TOKEN>`）

```json
{ "prompt": "...", "conversationId": "可选", "toolResults": "可选[{toolCallId,content,isError}]", "images": "可选" }
```

返回（同步轮询聚合，最长 5 分钟）：

```json
{ "status": "done|requires_tool|timeout",
  "text": "...", "thinking": "...",
  "toolCalls": [{"id","name","arguments","result"}],
  "conversationId": "...", "usage": {"input","output","cacheRead"} }
```

`POST /api/pi/chat`（OpenAI 兼容）

```json
{ "system": "...", "messages": [{"role":"user","content":"..."}],
  "tools": [...], "toolResults": [...], "conversationId": "..." }
```

> ⚠️ 这两个端点硬编码 `agent-a`/`user-006`（PI_SYNC_AGENT_ID/PI_SYNC_USER_ID 默认值），
> 若要复现编剧/导演角色，请改用 3.3 的方式 B 并显式传 `X-User-Id`。

---

## 四、用 API 复现能力清单的完整测试流程

> 前提：远程已通（§2.4 自检通过）。以下全部命令可从任意机器执行。
> 记 `BASE=https://<ECS公网地址>:8443`。

### 第 0 步：会话就绪（必做，24h 会过期）

```bash
# 三个角色租户逐一看状态
for u in user-006 user-007 user-008; do
  curl -sk "$BASE/api/auth/status?user_id=$u"; echo
done

# user-006 实测 refresh 可续；user-007/008 需 login（密码不落盘、走 stdin）
curl -sk -X POST "$BASE/api/auth/refresh" -H "Content-Type: application/json" -d '{"user_id":"user-006"}'
curl -sk -X POST "$BASE/api/auth/login"   -H "Content-Type: application/json" \
  -d '{"user_id":"user-007","username":"<测试账号>","password":"<PASSWORD>"}'
```

> 判定基准（沿用清单）：401=认证失效；4xx=认证已通、参数/端点问题；500=服务端内部错误。

### 第 1 步：环境自检（直接 /bash 探针，不消耗 LLM 额度）

```bash
curl -sk "$BASE/bash" -X POST -H "Content-Type: application/json" \
  -H "X-Agent-Id: agent-a" -H "X-User-Id: user-006" \
  -d '{"command":"readlink -f $(which shortdrama-cli); shortdrama-cli --version; env | grep -c SHORTDRAMA; curl -s -o /dev/null -w %{http_code} http://<业务API地址>/docs"}'
# 期望: <CLI配置目录>/.shortdrama/bin/shortdrama-cli（或用户 bin/ 内 wrapper）、0.0.2-beta、无 SHORTDRAMA 环境变量、200
```

### 第 2 步：查询类 8 项（✅ 真实可用，逐个驱动 agent 执行）

用 `/chat` 发一条 prompt，让 agent 自己跑命令并回报关键字段（skill 会约束它加 `--json`）：

```bash
cat > /tmp/q.txt <<'EOF'
请逐条执行以下 shortdrama-cli 命令并把每条的结果状态（HTTP 码/关键字段）整理成表格：
1. shortdrama-cli auth status --json
2. shortdrama-cli project list --json
3. shortdrama-cli project info --project 55555555-5555-4555-8555-555555555555 --json
4. shortdrama-cli model search --type image --json
5. shortdrama-cli model search --type video --json
6. shortdrama-cli model search --type audio --json
7. shortdrama-cli create image --project 55555555-5555-4555-8555-555555555555 --scene-id scene-test-1 --model "Seedream 5.0 Pro" --dry-run --json
8. shortdrama-cli asset search --query "测试" --limit 3 --json
只汇报结果，不要猜测。json.loads 报错时用 python3 -c "import json;json.loads(open('/dev/stdin').read(), strict=False)" 清洗。
EOF
curl -skN "$BASE/chat" -X POST -H "Content-Type: application/json" \
  -H "X-Agent-Id: agent-a" -H "X-User-Id: user-006" \
  -d "$(python3 -c 'import json,sys;print(json.dumps({"message":open("/tmp/q.txt").read()}))')" \
  --max-time 600 | tee /tmp/step2-sse.log | grep -E "^event: (agent_settled|done)|text_delta" | tail -5
```

**逐项期望**（与清单对齐）：

| 命令 | 期望 |
|------|------|
| auth status | authenticated:true（第 0 步没做则 false） |
| project list | 20 个项目 |
| project info | active |
| model search --type image | Seedream 5.0 Pro / Lite |
| model search --type video | Seedance 2.0 / 2.0 Lite |
| model search --type audio | **空列表**（服务端未注册音频模型，非故障） |
| create image --dry-run | 校验通过、预估 2 积分、不产生内容 |
| asset search | 返回 asset_id/name/source_file_url；⚠️ 输出含裸换行，机器消费须 strict=False |

### 第 3 步：坏点与 caveat 复现（❌ 两项 + ⚠️ 一项，全部可复现）

```bash
# 3.1 坏点：task list → 500（服务端 /api/generation-tasks 内部异常，与参数无关）
curl -sk "$BASE/bash" -X POST -H "Content-Type: application/json" \
  -H "X-Agent-Id: agent-a" -H "X-User-Id: user-006" \
  -d '{"command":"shortdrama-cli --debug task list --json; echo EXIT=$?"}'

# 3.2 坏点：model get → 404（CLI 写死旧端点 /api/tool_spec/list，契约过时，责任在 CLI）
curl -sk "$BASE/bash" -X POST -H "Content-Type: application/json" \
  -H "X-Agent-Id: agent-a" -H "X-User-Id: user-006" \
  -d '{"command":"shortdrama-cli model get \"Seedream 5.0 Pro\" --json; echo EXIT=$?"}'

# 3.3 caveat：script list → 接口 200 但 CLI 输出层转义损坏（\␊ 非法转义）
curl -sk "$BASE/bash" -X POST -H "Content-Type: application/json" \
  -H "X-Agent-Id: agent-a" -H "X-User-Id: user-006" \
  -d '{"command":"shortdrama-cli script list --project 55555555-5555-4555-8555-555555555555 --json 2>/dev/null | python3 -c \"import json,sys; json.loads(sys.stdin.read())\"; echo EXIT=$?"}'
# 期望：EXIT=1（json.loads 失败）；同源 curl 解析正常 → 定位为 CLI 输出层 bug
```

### 第 4 步：角色管控复现（三角色白名单，实测生效）

```bash
# 美术(user-006) 调导演命令 → 应 BLOCKED + exit 1
curl -sk "$BASE/bash" -X POST -H "Content-Type: application/json" \
  -H "X-Agent-Id: agent-a" -H "X-User-Id: user-006" \
  -d '{"command":"shortdrama-cli create video --project p1 --image x --prompt t; echo EXIT=$?"}'
# 期望输出: BLOCKED: art role cannot use 'create video' / EXIT=1

# 导演(user-008) 调编剧命令 → 应 BLOCKED
curl -sk "$BASE/bash" -X POST -H "Content-Type: application/json" \
  -H "X-Agent-Id: agent-a" -H "X-User-Id: user-008" \
  -d '{"command":"shortdrama-cli script import --file /nonexistent.md; echo EXIT=$?"}'
```

> 验证要点：查询命令三角色全放行；写操作按角色白名单拦截；
> 白名单里放行了坏点（model get/task list）与 mock 命令（scene/render/subtitle 等），这些照清单归位，不当作交付证据。

### 第 5 步：产物下载验证（实测：wrapper 层生效，admin-service SSE 层休眠）

**生效的机制**（wrapper 层，实测）：用户 `bin/shortdrama-cli` 对 `task get` 做了单次执行 + 下载——
先 flock 执行真实 CLI，若 `--json` 输出命中 `url/result_url/output_url/download_url`（且非 mock 前缀），
自动 curl 到 `<用户工作目录>/agent-a/{user}/outputs/` 并打印 `[P3] 检测到产物 URL...`。

```bash
# 用真实 task id 走一次（清单里 task get 假 id 是 400，无 URL 不会下载；需真实任务才有产物）
curl -sk "$BASE/bash" -X POST -H "Content-Type: application/json" \
  -H "X-Agent-Id: agent-a" -H "X-User-Id: user-006" \
  -d '{"command":"shortdrama-cli task get <REAL_TASK_ID> --json"}'
ls <用户工作目录>/agent-a/user-006/outputs/   # 服务器上看
```

**休眠机制**（admin-service `_download_task_outputs`，当前 server.log 零触发）：只扫描 SSE 事件类型
`tool_result/tool_output/bash_result`，而 pi RPC 实际事件类型是 `tool_execution_*`，类型不匹配——
属双保险设计中的第二道，当前不生效，别依赖它验证。

> 注：user-006/outputs 目录已存在一个历史产物 `gufeng_girl_lantern.mp4`，可作目录可写性参照。

### 第 6 步：提交类命令（端点可达证据，不真提交）

清单里 create video（假 scene+假图 → 400）、task get（假 id → 400）、create audio（参数校验通过）均为
「认证已通」证据。试点建议全部用 `--dry-run` 或假数据验证端点可达，**避免消耗积分**：
create image/video/audio 真提交、script analyze/import、asset ingest 等，须用户确认后再执行。

---

## 五、测试注意事项（坑位清单，全部实测）

1. **会话 24h 过期**：token 有效期 86400s。第 0 步先 status，false → refresh，失败 → login。
   试点期间每轮测试前先续期，避免把「401」误判为端点坏。
2. **`--debug` 会隐藏 query 参数**：排查请求时看到脱敏 URL 是正常的，别误判参数丢失。
3. **script list 输出转义 bug**：机器消费必须 `python3 -c "json.loads(..., strict=False)"` 或先清洗换行；
   不能用 `json.tool` 直判「坏」——接口本身 200。
4. **task list 500 / model get 404**：两个硬坏点，复现即可，归因分别是「服务端路由内部异常」与
   「CLI 契约过时」，都不是试点可以修掉的（修 CLI 需走 zhongwen-shortdrama 代码仓）。
5. **mock 命令**：scene 全组 / edit image / subtitle / render 全组 / result / breakdown / pipeline 等
   只出假回执，**不能作为试点交付依据**。role 白名单放行了它们，别被「没报错」误导。
6. **生图/生视频消耗积分**：提交类先 `--dry-run`；预估积分（2 积分/张）来自 create image 干跑实测。
7. **SSE 协议**：`/chat` 一个连接完成 订阅→prompt→事件流→断流；`agent_settled` 后服务端发 `done` 并断开。
   `tool_execution_update` 的 partialResult 是累积输出（可覆盖式渲染）；事件带 `_session_key` 便于按用户区分。
8. **agent 串行**：每个用户只有 1 个 pi 进程且单队列。一个用户同时发两个 /chat 会互相阻塞/覆盖，
   测试按用户串行。instance `agent_busy:true` 表示在跑。
9. **每回合销毁进程**：实例虽常驻（uptime 可达数天），但每轮 agent 回合后 pi 进程保持 --no-session；
   wrapper/主仓以「产品数据库为对话真源」，每轮都重发完整历史——所以 agent 的上下文取决于你每次 prompt 携带的完整指令。
10. **鉴权边界**：`/api/*` 目前除 `/pi/*` 同步端点和 `/api/auth/*` 外无 token 校验；公网暴露前务必加鉴权。
    `<PI_SYNC_TOKEN>` 是默认值，正式环境换受管 secret。
11. **日志与排查**：
    - admin-service：`<用户工作目录>/shared/admin-service/server.log`（uvicorn 访问日志 + 下载回调）
    - pi 子进程 stderr：继承自 admin-service 进程（journald 无独立单元，直接看 server.log 或 /proc/<pid>/fd/2）
    - 实例状态：`GET /health`（status/pid/uptime/error）
    - 进程管理：`POST /instances/stop` 后 `start` 可重置卡死实例
    - 业务 API 连通：`curl http://<业务API地址>/docs`（200=业务服务正常；401=仅 token 问题）
12. **本机 vs 远程**：本机 curl 8443 要带 `Host: <ECS公网地址>`（否则命中 default server 无 /api/ 路由）。

---

## 六、速查：一次试点的最小脚本（复制即用）

```bash
BASE=https://<ECS公网地址>:8443
H=(-H "Content-Type: application/json" -H "X-Agent-Id: agent-a")

# 1) 连通
curl -sk "$BASE/health" | python3 -m json.tool | head -20

# 2) 会话
for u in user-006 user-007 user-008; do curl -sk "$BASE/api/auth/status?user_id=$u"; echo; done
curl -sk -X POST "$BASE/api/auth/refresh" -H "Content-Type: application/json" -d '{"user_id":"user-006"}'

# 3) 直驱 agent 跑清单（user-006 美术）
curl -skN "$BASE/chat" -X POST "${H[@]}" -H "X-User-Id: user-006" \
  -d "$(python3 -c 'import json;print(json.dumps({"message":open("/tmp/q.txt").read()}))')" \
  --max-time 900 | tee /tmp/sse-user-006.log | grep -E "^event: (agent_settled|done)" 

# 4) 坏点/角色探针走 /bash（省 LLM 额度）
curl -sk "$BASE/bash" -X POST "${H[@]}" -H "X-User-Id: user-006" \
  -d '{"command":"shortdrama-cli task list --json; echo EXIT=$?"}'
```

---

## 附录 A：盘点清单 ↔ 测试命令映射（18 项）

| 清单项 | 复现途径 | 期望 |
|--------|----------|------|
| 命令入口/版本 | /bash `readlink -f $(which shortdrama-cli)` | <CLI配置目录>/.shortdrama/bin/... 0.0.2-beta |
| 业务 API /docs | /bash curl <业务API地址>/docs | 200（Swagger 31 端点） |
| 资产库 API | asset search | 独立连通、无需业务登录 |
| 登录账号 | /api/auth/status（account） | <测试账号> / Common 联合测试组织 |
| 会话状态 | /api/auth/status | authenticated:true |
| auth status/info/refresh | /chat | ✅ |
| project list/info | /chat | 20 项 / active |
| model search image/video | /chat | Seedream / Seedance |
| create image --dry-run | /chat | 校验通过、预估 2 积分 |
| asset search | /chat | 语义检索、⚠️裸换行 |
| script list | /chat 或 /bash | ⚠️ 输出转义 bug（strict=False） |
| model search audio | /chat | 空列表（服务端配置） |
| task list | /bash | ❌ 500（服务端） |
| model get | /bash | ❌ 404（CLI 契约过时） |
| 三角色白名单 | /bash 越权命令 | BLOCKED: <role> role cannot use ... |
| 产物下载 | task get --json（wrapper 层自动 curl 到 outputs/） | 自动落地；admin-service SSE 层休眠不依赖 |
| 提交类端点可达 | 假数据 | 400（认证已通）非 401 |
| mock 组 | 不测或标注 | 假回执，非交付依据 |
