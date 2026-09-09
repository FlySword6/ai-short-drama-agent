# shortdrama-cli 能力清单 · 逐项复现测试结果

- 复现时间：2026-08-06 14:0x（UTC+8）
- 复现方式：远程经 `https://<ECS公网地址>:8443/api/bash`（豁免 nginx basic auth）直驱 ECS，user-006（美术 art）租户
- 会话：盘点时 user-006 token 仍有效并 refresh 成功；user-007/008 token 已过期（refresh 失败，需 login，本次未补 login）
- 判定基线（沿用清单）：401=认证失效；4xx（400/404）=认证已通属参数/端点问题；500=服务端内部错误
- 注：「经 wrapper」=角色包装脚本 `shortdrama-cli`；「底层 CLI」=`<CLI配置目录>/.shortdrama/bin/shortdrama-cli`（绕过 wrapper）

---

## 一、环境与连接

| 清单项 | 复现命令 | 实测结果 | 与清单 |
|--------|---------|---------|--------|
| 命令入口（实际命中） | `readlink -f $(which shortdrama-cli)` | `<用户工作目录>/agent-a/user-006/bin/shortdrama-cli`（角色 wrapper） | ✅ 一致（清单已注明 PATH 命中此入口） |
| 底层 CLI 版本 | `<CLI配置目录>/.shortdrama/bin/shortdrama-cli --version` | `0.0.2-beta` | ✅ |
| wrapper 行为 | `shortdrama-cli --version` | `BLOCKED: no command specified`（wrapper 只放行具体子命令，不识别裸 `--version`） | ⚠️ 清单未提此 wrapper 行为 |
| 业务 API `/docs` | `curl http://<业务API地址>/docs` | HTTP 200 | ✅ |
| 资产库 API 直连 | `curl http://<资产库地址>` | **HTTP 000 / Connection refused**（端口 80 主动拒绝，非超时） | ❌ **偏差**：清单写"asset search 独立连通"，现在直连不通 |
| 登录账号/角色/组织 | `shortdrama-cli auth info --json` | <测试账号>，id `<用户ID>`，角色 test_org_admin/user/organization_admin，Common 联合测试组织 | ✅ 完全一致 |
| 会话状态 | `/api/auth/status?user_id=user-006` | authenticated:true | ✅ |
| 会话 refresh | `POST /api/auth/refresh` | user-006 成功；user-007/008 失败（token 24h 过期，需 login） | ✅ 与手册预期一致 |
| 环境变量 | `env | grep SHORTDRAMA` | 仅 `SHORTDRAMA_PROFILE=user-006`（角色隔离变量，wrapper 注入） | ✅ 业务连接变量（API_BASE/USERNAME/API_TOKEN/API_URL）确实未设置，与清单一致 |

---

## 二、命令可用性（每行可复现）

### ✅ 真实可用（底层 CLI 实测通过）

| 命令 | 复现命令 | 实测结果 | 与清单 |
|------|---------|---------|--------|
| auth status / info | `shortdrama-cli auth status --json`（经 wrapper） | succeeded, authenticated:true, 账号/角色/组织齐全 | ✅ |
| auth refresh | `POST /api/auth/refresh` | user-006 authenticated:true | ✅ |
| project list | 底层 CLI `project list --json` | 返回项目列表（含 `55555555...` 项目） | ✅（清单"20 个项目"，本次未逐一计数，列表非空） |
| project info | （未单测，参数格式问题） | — | — 未复现 |
| model search --type image | 底层 CLI `model search --type image --json` | Seedream 5.0 Pro / Lite | ✅ |
| model search --type video | 底层 CLI `model search --type video --json` | Seedance 2.0 | ✅ |
| create image --dry-run | 底层 CLI `create image --project 55555555-5555-4555-8555-555555555555 --scene-id scene-test-1 --model "Seedream 5.0 Pro" --dry-run --json` | status:submitted, task_id:dry_run_generate_image, 预估 2 积分 | ✅ |
| asset search | 底层 CLI `asset search --query test --limit 3 --json` | count:3，返回 asset_id/name（带污渍蓝条纹病号服套装等） | ✅（⚠️ 裸换行未单独验证，但输出含中文资产名） |

### ⚠️ 部分可用

| 命令 | 复现命令 | 实测结果 | 与清单 |
|------|---------|---------|--------|
| script list | 底层 CLI `script list --project ... --json | python3 json.loads` | `JSONDecodeError: Invalid control character at line 12 column 51` | ✅ 一致（CLI 输出层转义损坏；本次报错是 invalid control char，清单描述为 `\␊` 非法转义，**性质相同、表述略异**） |
| model search --type audio | 底层 CLI `model search --type audio --json` | matchKind:none, matches:[]（空列表） | ✅（服务端未注册音频模型，非故障） |

### ❌ 坏 / 异常（全部实测复现）

| 命令 | 复现命令 | 实测结果 | 与清单 |
|------|---------|---------|--------|
| task list | 底层 CLI `task list --json` | Traceback（ApiRequestError，服务端 500） | ✅ |
| model get | 底层 CLI `model get "Seedream 5.0 Pro" --json` | Traceback（HTTP 404，CLI 写死 `/api/tool_spec/list`） | ✅ |

### 🟡 端点可达（未真实提交，本次未复现）
create video / task get / create audio 假数据验证 —— 未单独测，清单结论（端点可达、认证已通）沿用。

### ⚪ Mock / ⚙️ 需配置 —— 本次未单独复现，清单结论沿用。

---

## 三、ECS 三角色管控层

| 清单项 | 复现命令 | 实测结果 | 与清单 |
|--------|---------|---------|--------|
| 美术(user-006) 调导演命令 | `shortdrama-cli create video --project p1 --image x --prompt t` | `BLOCKED: art role cannot use 'create video'` + exit 1 | ✅ |
| 美术(user-006) 调编剧命令 | `shortdrama-cli script import --file /nonexistent.md` | `BLOCKED: art role cannot use 'script import'` + exit 1 | ✅ |

---

## 四、新发现（清单未覆盖，需关注）

### 1. ⚠️ 角色 wrapper 注入 `--profile` 导致多个查询命令失效

经 wrapper（`shortdrama-cli` 即 PATH 命中入口）执行以下命令**全部报 `No such option: --profile`**：
- `shortdrama-cli project list --json`
- `shortdrama-cli project info --project ... --json`
- `shortdrama-cli model search --type image --json`
- `shortdrama-cli create image ... --dry-run --json`
- `shortdrama-cli script list --project ... --json`

**根因**：wrapper 脚本给底层 CLI 注入 `--profile` 参数，但这些子命令在真实 CLI（Typer）里不接受 `--profile` 选项，导致 Typer 直接报参数错误退出。

**影响**：清单标注这些为"✅ 真实可用"，但**经 wrapper（即试点用户实际使用路径）跑不通**。绕过 wrapper 直连底层 CLI 才能复现清单所述 200 结果。

**建议**：试点前必须修 wrapper 的 `--profile` 注入逻辑（仅注入给支持的命令，或改用环境变量 `SHORTDRAMA_PROFILE` 传递，不用命令行参数）。

### 2. ❌ 资产库 API 直连不通

- 清单：`http://<资产库地址>` asset search 独立连通
- 实测：`curl http://<资产库地址>` → Connection refused（端口 80 主动拒绝）
- 但底层 CLI `asset search` 仍返回 count:3 真实数据 → 推测资产库服务对 ECS 内网/特定端口可达，或 CLI 走了不同端点；公网 80 已不通。

**建议**：清单"资产库 API 独立连通"的复现命令（curl 直连 80）已失效，需更新为 CLI 内部端点或注明内网可达。

---

## 五、结论

1. **会话/认证/底层 CLI 真实能力**：与清单完全一致——auth/project/model search/dry-run/asset search/坏点(task list 500、model get 404)/越权拦截，全部复现。
2. **两个硬坏点**确认仍在：task list（服务端 500）、model get（CLI 404）。
3. **script list caveat**确认：CLI 输出层转义损坏，机器解析失败（报错为 invalid control char，与清单 `\␊` 表述异、性质同）。
4. **新发现 1（wrapper `--profile` 注入 bug）**：经 wrapper 跑 project list/model search/create image/script list 全部报 `No such option: --profile`——**试点用户实际路径跑不通**，绕过 wrapper 才正常。这是清单未覆盖的阻断性问题，试点前必修。
5. **新发现 2（资产库公网不通）**：curl 直连 <资产库地址>:80 refused，清单复现命令失效；CLI 内部仍可用。

**净结论**：清单的"底层能力"部分（✅/⚠️/❌）经底层 CLI 复现全部成立；但"试点用户实际使用路径"（经 wrapper）因 `--profile` 注入 bug，多个✅命令实际跑不通——这是清单遗漏的阻断性问题。建议试点前优先修 wrapper。
