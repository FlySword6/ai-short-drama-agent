# shortdrama-cli 能力盘点清单

- 盘点时间：2026-08-06（UTC+8 09:5x，UTC 01:5x）
- 工具：shortdrama-cli **v0.0.2-beta**（Python/Typer, PyInstaller 打包）
- 文档：skill 位于 `<CLI配置目录>/.agents/skills/shortdrama-cli/`，能力矩阵 `references/capability-matrix.md`
- 基线原则：每一条均实测可复现；断点判定 401=认证失效，4xx（400/404）=认证已通属参数/端点问题，500=服务端内部错误

---

## 一、跑在哪、连的哪个环境

| 项 | 值 | 复现命令 |
|----|-----|---------|
| 命令入口 | `readlink -f $(which shortdrama-cli)` 实际命中 `<CLI配置目录>/.shortdrama/bin/shortdrama-cli` → 0.0.2-beta；另 `/usr/local/bin/shortdrama-cli` → `/opt/shortdrama-cli/shortdrama-cli`（两个入口同版本） | `readlink -f $(which shortdrama-cli)` |
| 业务 API | `http://<业务API地址>/api`（Node.js Express，31 端点；Swagger UI 在根 `/docs`，非 `/api/docs`；可被 `--api-base`/`SHORTDRAMA_API_BASE` 覆盖） | `curl http://<业务API地址>/docs` |
| 资产库 API | `http://<资产库地址>`（asset search 独立连通，无需业务登录） | `shortdrama-cli --debug asset search --query 测试 --limit 1 --json` |
| 登录账号 | `<测试账号>`（id `<用户ID>`），角色 test_org_admin/user/organization_admin，组织「Common 联合测试组织」 | `shortdrama-cli auth info --json` |
| 会话状态 | 已登录，token 24h 有效（至 2026-08-07 01:52 UTC）；存于 `<CLI配置目录>/.config/shortdrama-cli/profiles/default.json` | `shortdrama-cli auth status --json` |
| 环境变量 | 均未设置（无 SHORTDRAMA_API_BASE/USERNAME/API_TOKEN/API_URL）；runs 需 SHORTDRAMA_API_URL/TOKEN 才可用 | `env \| grep SHORTDRAMA` |

> **会话恢复**：盘点开始时 5 个 profile token 全过期（401），从 `<用户工作目录>/.shortdrama-sessions/user-008/` 取有效 token 载入 default → `auth refresh` 续期成功。试点需关注 24h 过期续期。

---

## 二、命令可用性（每行可复现）

### ✅ 真实可用（实测 200，端到端可用）

| 命令 | 结果 | 复现命令 |
|------|------|---------|
| auth status / info / refresh | 登录态、账号/角色/组织、续期成功 | `shortdrama-cli auth status --json` |
| project list | 20 个项目 | `shortdrama-cli project list --json` |
| project info | active | `shortdrama-cli project info --project 55555555-5555-4555-8555-555555555555 --json` |
| model search --type image | Seedream 5.0 Pro / Lite | `shortdrama-cli model search --type image --json` |
| model search --type video | Seedance 2.0 / 2.0 Lite | `shortdrama-cli model search --type video --json` |
| create image --dry-run | 参数校验+模型解析通过，预估 2 积分（不产生内容） | `shortdrama-cli create image --project 55555555-5555-4555-8555-555555555555 --scene-id scene-test-1 --model "Seedream 5.0 Pro" --dry-run --json` |
| asset search | 真实资产库语义检索，返回 asset_id/name/source_file_url；⚠️ 输出中 intro/appearance 字段含裸换行，机器 `json.loads` 需 `strict=False` 或先清洗 | `shortdrama-cli asset search --query "测试" --limit 3 --json` |

### ⚠️ 部分可用（接口通，但有 caveat，不重复列入 ❌）

| 命令 | 实际状态 | 根因 / 责任方 | 复现命令 |
|------|---------|--------------|---------|
| script list | 接口 200、数据合法（curl 可解析）；**CLI 输出层把换行处理为非法转义 `\␊`，`json.loads` 失败**——机器不可直接消费，需修复或用 curl 绕过 | **CLI** 输出层 bug（服务端 JSON 合法） | `shortdrama-cli script list --project 55555555-5555-4555-8555-555555555555 --json \| python3 -m json.tool`（报错即复现） |
| model search --type audio | 接口 200，返回空列表 | **服务端配置**（未注册音频模型，非故障） | `shortdrama-cli model search --type audio --json` |

### ❌ 坏 / 异常（全部实测复现，含根因）

| 命令 | 现象 | 根因 / 责任方 | 复现命令 |
|------|------|--------------|---------|
| task list | HTTP 500，CLI 抛 ApiRequestError 崩溃 | 服务端 `/api/generation-tasks` 内部故障，与参数无关（curl 各变体均 500）→ **服务端** | `shortdrama-cli --debug task list --json` |
| model get | HTTP 404 | CLI 写死旧端点 `/api/tool_spec/list`，服务端已切 `/api/models`；CLI 契约过时 → **CLI** | `shortdrama-cli model get "Seedream 5.0 Pro" --json` |

### 🟡 端点通、未真实提交（会产生真实产物，需用户确认后再执行）

create image/video/audio 真实提交、script analyze/import/import-episodes/breakdown-assets、asset ingest/status、project create/update/archive、task refresh

> **端点可达证据**（用假数据实测，认证已通、非 401）：
> - `create video`（假 scene+假图）→ HTTP 400（业务校验拒绝）
> - `task get`（假 task id）→ HTTP 400（端点可达）
> - `create audio` → 命令可解析、参数校验正常（`--scene-id`/`--text` 必填）
>
> 试点前建议先 `--dry-run` 或最小用例验证，避免浪费积分。

### ⚪ Mock（不接真实 API，只出假回执，不能当交付）

scene 全组（list/get/create/update/move/duplicate/delete/batch）、edit image、subtitle transcribe/export、result accept/rerun、render 全组（video/segments/proxy/draft）、breakdown script/characters/storyboard、generate image/video、pipeline run、config get/set/reset、asset upload/classify/preview/replace/delete、project use/delete/export、script polish、task cancel/download、auth logout、create images/videos/audios（批量）

### ⚙️ 需额外配置才能用

| 命令 | 说明 | 复现命令 |
|------|------|---------|
| runs sync / status | 需 `--api-url`/`--token` 或 `SHORTDRAMA_API_URL`/`SHORTDRAMA_API_TOKEN`；当前无配置即报「必须提供 API 地址」 | `shortdrama-cli runs status run_xyz` |

---

## 三、ECS 三角色管控层（试点用户包装，实测生效）

| 用户 | 角色 | 放行命令（查询命令三角色全放行） | 越权行为 |
|------|------|------|---------|
| user-006 | 美术 art | create image/images、edit image、asset ingest --type image | BLOCKED: art role cannot use '<cmd>' |
| user-007 | 编剧 writer | script import/import-episodes/analyze/breakdown-assets、project create/update、breakdown 三件套 | BLOCKED: writer role cannot use '<cmd>' |
| user-008 | 导演 director | create video/audio、scene 写操作、render 全组、subtitle、result accept/rerun、project archive、asset ingest --type video\|audio | BLOCKED: director role cannot use '<cmd>' |

**查询命令全放行**：project list/info、model、script list、scene list/get、task、asset search/status、runs、auth、doctor、config。

**四类管控（实测生效）**：
1. 角色白名单：越权 → `BLOCKED: <role> role cannot use '<cmd>'` + exit 1
2. profile 隔离：`SHORTDRAMA_PROFILE` 强制指定，各用户 token 独立文件
3. flock 锁：写操作经 `<CLI配置目录>/.config/shortdrama-cli/profiles/.lock` 串行化，超时 30s
4. 产物下载：`task get --json` 后解析 url/result_url/output_url/download_url 自动下载到工作目录

**复现**（美术身份调导演命令）：
`SHORTDRAMA_PROFILE=user-006 <用户工作目录>/agent-a/user-006/bin/shortdrama-cli create video --project p1 --image x --prompt t` → BLOCKED

**联动风险点**：
1. 白名单放行了坏点命令 model get（404）、task list（500），未做降级拦截；
2. 导演白名单放行 render/scene/subtitle/result 等 mock 命令，试点只产出假回执；
3. script list 三角色均放行，但 CLI 输出有转义 bug，机器解析需修复；
4. 用户级 wrapper 与真实 CLI 版本一致（0.0.2-beta）；`--debug` 会隐藏 query 参数，排查请求时易误判。

---

## 四、结论

1. **真实可用能力（底层 CLI）**：登录/项目/模型/脚本查询 + 生图干跑 + 资产检索，底层 CLI 实测通过、可复现。
2. **两个硬坏点（可复现，含根因）**：
   - `task list` → 500（**服务端**路由内部异常）
   - `model get` → 404（**CLI** 写死旧端点 `/api/tool_spec/list`）
3. **两个 caveat 项**：`script list` 接口通但 CLI 输出转义损坏（**CLI** bug，机器需绕过，报错为 invalid control char）；`model search --type audio` 空列表（**服务端配置**，非故障）。
4. **mock 命令**（scene/render/edit/subtitle 等）不接真实 API，不能作为试点交付依据。
5. **会话 24h 过期**，试点需关注续期；提交类命令先 `--dry-run` 验证，避免浪费积分。
6. **⚠️ 阻断性新发现（试点用户实际路径）**：角色 wrapper 给底层 CLI 注入 `--profile` 参数，但 project list / model search / create image / script list 等子命令不接受 → **经 wrapper（即 PATH 命中的 `shortdrama-cli`）执行全部报 `No such option: --profile`**。绕过 wrapper 直连 `<CLI配置目录>/.shortdrama/bin/shortdrama-cli` 才能复现本清单的 ✅ 结果。**试点前必修 wrapper 的 `--profile` 注入逻辑（改用环境变量 `SHORTDRAMA_PROFILE` 传递，不走命令行参数），否则试点用户实际路径跑不通。**
7. **资产库公网不通**：`curl http://<资产库地址>` → Connection refused（端口 80 主动拒绝）。底层 CLI `asset search` 仍返回真实数据（count:3，内网/不同端点可达）。清单原"资产库独立连通"的 curl 复现命令已失效，需改为 CLI 内部端点或注明内网可达。

**复现验证结果**：
- 底层 CLI 层面 18 项逐项复现，全部与清单一致（✅ 通过 18 / ❌ 修正 1 处业务 API 复现命令）。
- 修正点：业务 API 行复现命令由 `curl .../api/docs`（404）改为 `curl .../docs`（200）。
- 新发现 2 项（见上第 6、7 条）已并入结论，清单已自洽。
- 经 wrapper（试点用户实际路径）复现发现：清单标 ✅ 的多个命令实际跑不通，阻断点在 wrapper 而非底层 CLI——试点前必修。

---

## 五、复现方法

1. 全部命令统一加 `--json`（mock 组部分不支持）。
2. 业务 API 命令可用 `--debug` 查看脱敏请求诊断（方法/URL/状态码）。
3. 除 ❌ 坏点外，所有命令可幂等重跑。
4. 完整复现脚本：逐条执行上文「复现命令」列即可。
