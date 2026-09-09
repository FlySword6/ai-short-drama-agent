# 部署后只读冒烟闸（L3）

> 本文是四层生产验收标准里的第三层。立于 2026-08-22，总监审过转正。
> 上位依据：`docs/planning/delivery-workflow.md`「部署巡看环境面，不认『发版了』只认『配置生效了』」。
> 姊妹文档：`docs/operations/product-e2e-reporting.md`（付费产品 E2E，与本闸互不覆盖）。

## 这道闸回答一个问题

部署完成之后、宣布"发版成功"之前，在目标环境上做一次**零写入、零付费**的核对：

> **跑起来的，是不是我打算部署的那个 commit？**

它不验业务功能（那是 L4），不验回归（那是 L1）。只验制品身份与最基本的存活鉴权。

`scripts/release-smoke.sh` 一条命令跑完四条断言：

| # | 断言 | 不过的表现 |
|---|---|---|
| 1 | `GET {base}/api/v1/health` 返回 2xx | curl `--fail` 非零退出 |
| 2 | 响应体含 `"status":"ok"` | `health endpoint did not return status=ok` |
| 3 | 响应体有 `sha` 字段；**给了 `SHORTDRAMA_EXPECTED_SHA` 时必须逐字相等** | `commit sha mismatch: expected X, health reports Y` |
| 4 | 未认证 `GET {base}/api/v1/auth/me` 返回 **401** | `expected unauthenticated /api/v1/auth/me to return 401, got NNN` |

四条全过才打印 `release smoke passed: health is reachable and private API requires login` 并 exit 0。

第 4 条守住一件容易被忽略的事：**反向代理可从公网到达时，私有 API 仍然必须要求登录**。在生产 80 端口尚未跳转 443 之前（`#318`），这条断言的价值比平时更高。

---

## 铁律一：`SHORTDRAMA_EXPECTED_SHA` 必须给

**不给这个环境变量，这道闸就是纸糊的。** 这不是推论，是实测。

在测试站上跑同一个脚本、对同一个部署，只差一个环境变量：

```
# 跑法 A：不设 SHORTDRAMA_EXPECTED_SHA
$ bash scripts/release-smoke.sh https://shortdrama-main-test.col.com
{"ok":true,"data":{"status":"ok","app_name":"Shortdrama Test","version":"0.3.0","sha":"unknown"}}
WARNING: image carries no commit sha (built without GIT_SHA); not traceable to a commit
release smoke passed: health is reachable and private API requires login
exit=0                          ← 放行

# 跑法 B：设了 SHORTDRAMA_EXPECTED_SHA
$ SHORTDRAMA_EXPECTED_SHA=508dfee9325d05a07c546cebd86b0d4ca0184ead \
    bash scripts/release-smoke.sh https://shortdrama-main-test.col.com
{"ok":true,"data":{"status":"ok","app_name":"Shortdrama Test","version":"0.3.0","sha":"unknown"}}
commit sha mismatch: expected 508dfee9…, health reports unknown
exit=1                          ← 拦下
```

同一个**完全无法追溯到任何 commit** 的部署，A 放行、B 拦下。脚本注释写得很清楚，这个宽容是刻意的——"本地构建拿不到 sha 是合法的（显示 unknown），所以未给期望值时只告警不失败"。这个宽容对本地开发是对的，**对发布闸是致命的**。

测试站 `sha=unknown` 这个偏差之所以能存活到被专门排查才发现（`#457`，归 test 线，并入 `#288`/D6），跟这个默认宽容脱不了关系。

**所以：作为本闸执行时，`SHORTDRAMA_EXPECTED_SHA` 必填。没填 = 这一趟不算跑过。**

---

## 铁律二：期望值必须来自独立来源

`SHORTDRAMA_EXPECTED_SHA` 填什么，取决于你在验哪件事。**两种用法语义不同，不能混。**

### 用法一 · 发布后核对（发版值守）

填**本次发布的目标 commit**（D 系列流程里 D0 裁定的那个 SHA）。验的是"部署的就是我要发的"。

```bash
export SHORTDRAMA_EXPECTED_SHA=<本次发布的完整 commit sha>
bash scripts/release-smoke.sh https://<目标环境域名>
```

### 用法二 · 日常巡检核对（巡视线）

填**清单侧声称的那个 commit**。验的是"运行的就是清单声称的"，专抓配置漂移。

有集群权限时，从线上 Deployment 注解取：

```bash
EXPECTED=$(kubectl -n <namespace> get deployment shortdrama \
  -o jsonpath='{.metadata.annotations.shortdrama\.zhongwen\.com/release-commit}')
SHORTDRAMA_EXPECTED_SHA="$EXPECTED" bash scripts/release-smoke.sh https://<目标环境域名>
```

无集群权限时，从仓库清单取（`deploy/k8s/base/deployment.yaml` 的 `release-commit` 注解；prod overlay 不覆盖镜像，继承 base）。这条路径同时服务于 `#381`「仓库为真源」的方向。

> **绝不允许**拿 health 自己报的 sha 当期望值回填——那是自证循环，等于没验。
>
> **也绝不允许**用 `APP_VERSION` 或 health 里的 `version` 字段代替 sha。`deploy/k8s/README.md` 记着前车之鉴：`APP_VERSION` 是 ConfigMap 里的人工值，和镜像里 `package.json` 的真实版本长期不一致，**health 报的版本号因此不可信**。`sha` 来自镜像内的 `GIT_SHA`，随制品走、清单侧改不动，这正是它唯一的价值。

---

## 铁律三：本机跑必须用 `--resolve` 钉 IP

本机存在活跃的本地代理 DNS 拦截（fake-ip）。同一个域名，两种查法结果不同：

```
$ dig +short shortdrama.col.com          # 本机解析
198.18.0.208                              ← fake-ip 段，不是真实地址

$ curl -sS -H 'accept: application/dns-json' \
    'https://1.1.1.1/dns-query?name=shortdrama.col.com&type=A'   # DoH 绕开本机
101.126.6.208                             ← 真实公网地址
```

两个地址末段相同、只差前缀，肉眼极易看漏。脚本本身**不验证"我连到的是不是我以为的那台机器"**，它只看返回内容——所以从本机跑必须先钉 IP。

标准动作（不改脚本，用临时 `CURL_HOME`，不污染全局 `~/.curlrc`）：

```bash
# 1. 用 DoH 查到真实 IP（不要用本机 dig 的结果）
# 2. 写一份临时 curlrc
mkdir -p /tmp/smoke-curlhome
printf 'resolve = "<域名>:443:<真实IP>"\n' > /tmp/smoke-curlhome/.curlrc

# 3. 带着 CURL_HOME 跑
CURL_HOME=/tmp/smoke-curlhome \
SHORTDRAMA_EXPECTED_SHA=<期望 sha> \
bash scripts/release-smoke.sh https://<域名>

# 4. 用完删掉
rm -rf /tmp/smoke-curlhome
```

这条路径本身经过变异验证：把 `resolve` 故意钉到 `127.0.0.1`，脚本立刻 `curl: (7) Failed to connect ... exit=7`，证明 `--resolve` 确实被采纳、不是被忽略。

替代方案：在集群内起一次性 Pod 跑，天然绕开本机解析。

**另：base_url 一律写 `https://`。** 脚本不强制 HTTPS，传 `http://` 它照样跑；在 80 未跳 443 之前，规程侧把这条堵死。

---

## 什么时候跑

插进现有流程，不另造节奏：

| 触发点 | 谁跑 | 用法 |
|---|---|---|
| 每次部署完成后，宣布发版成功之前 | 发版值守 | 用法一 |
| 每次回滚完成后 | 发版值守 | 用法一（填回滚到的那个 commit） |
| 每日巡检的环境面那一巡 | 巡视线 | 用法二 |

---

## 不过怎么办

**exit 非零 = 这次部署不算成功。** 不许"再跑一次看看"，不许人眼看响应体判断"其实还行"。

1. **先记录，再动手。** 把脚本完整输出（含那行 `expected … reports …`）贴进本次发布对应的 issue。
2. **判断是哪一类失败**：
   - 断言 1/2 不过 = 服务没起来或不健康 → 回滚。
   - 断言 3 不过 = 制品身份对不上 → **最严重的一类**，说明"你以为部署的"和"实际在跑的"不是一个东西。回滚，并单独立卡查成因。
   - 断言 4 不过 = 鉴权被绕过 → **按安全事故处理**，立即停手、报安全合规席并抄总监，不自行修复。
3. **回滚**（`deploy/k8s/README.md` 已有的锚，本文不新增）：

   ```bash
   kubectl -n <namespace> rollout undo deployment/shortdrama --to-revision=<previous>
   kubectl -n <namespace> rollout status deployment/shortdrama --timeout=10m
   ```

   回滚完成后**必须再跑一次本闸**（用法一，填回滚到的 commit），否则不算回滚成功。

> **回滚的边界，不得逾越**：镜像回滚**不撤销数据库 migration**；禁止手工删除 RDS 数据或修改 `schema_migrations`。数据层的回退是另一件事，需要单独授权与方案。

---

## 报告落哪、谁看

沿用 `product-e2e-reporting.md` 的既有约定，不另起一套：

- 输出贴进本次发布对应的 issue（发布场景）或当日巡检记录（巡检场景）。
- 红项直连报总监；**聊天通知不能由文件落盘代替**。
- 报告里写明：跑的时间、目标环境、`SHORTDRAMA_EXPECTED_SHA` 的值**与它的来源**（本次发布目标 / 清单注解 / 仓库清单）、脚本完整输出、exit code。
- 脚本只打印 health 响应体与断言结论，天然不含密码、token、连接串；贴之前仍要扫一眼。

---

## 授权口径

**公网匿名只读 GET 不属于「动生产」。** 判据两条，两者皆否才成立：

1. 是否走特权通道（集群凭据、管理接口、内网旁路）；
2. 是否产生任何变更（写入、扣费、状态迁移）。

本闸的三个请求全部是公网匿名 GET，两条皆否，因此**常规执行不需要 DC 指名授权**。

**但是**：凡走集群凭据（如用法二里的 `kubectl` 取值）或产生任何写入的操作，仍按生产动作走 DC 指名授权，不因本闸的口径而放宽。

---

## 这道闸不管什么

- **不管业务功能是否可用**——那是 L4，判据是 `docs/design/full-flow-screenplay.md` 的 17 步剧本。
- **不管回归是否绿**——那是 L1。
- **不管付费生成链路**——本闸零付费。付费冒烟受 `product-e2e-reporting.md` 那条红线管（禁止无人值守 cron），与本闸互不覆盖、互不替代。
- **不管配置内容是否正确**——那是 `#381`「仓库为真源」四步在做的事。本闸只回答"跑的是哪个 commit"，不回答"配置对不对"。

---

## 首次执行记录

生产环境首跑，2026-08-22，按本文铁律三的标准动作执行：

```
$ CURL_HOME=/tmp/smoke-curlhome \
  SHORTDRAMA_EXPECTED_SHA=508dfee9325d05a07c546cebd86b0d4ca0184ead \
  bash scripts/release-smoke.sh https://shortdrama.col.com
{"ok":true,"data":{"status":"ok","app_name":"Shortdrama Prod","version":"0.3.0","sha":"508dfee9325d05a07c546cebd86b0d4ca0184ead"}}
commit sha verified: 508dfee9325d05a07c546cebd86b0d4ca0184ead
release smoke passed: health is reachable and private API requires login
exit=0
```

四条断言全过。期望值取自仓库 `deploy/k8s/base/deployment.yaml` 的 `release-commit` 注解（prod overlay 不覆盖镜像，继承 base），属独立来源，非自证。

**这一趟证明的是"闸能用"，不是"生产是新的"**——`508dfee9` 提交于 2026-08-09，落后当时的 `origin/dev` HEAD 233 个提交。生产版本落后属 `#288` 战役范围，不是本闸能解决的问题；本闸的价值恰恰是让这件事有一条可复现的命令能查出来。

---

## 已知限制

- 本闸只覆盖 health 与鉴权两个面，不构成对生产可用性的完整判断。
- 脚本不验证连接对端身份，靠铁律三的 `--resolve` 在规程侧兜住；从集群内跑则不需要。
- 用法二的 `kubectl` 取值命令抄自 `deploy/k8s/README.md`，未经执行验证（出具时无集群权限，`#381` 同款 403 阻塞）。
- 未评估火山持续交付（VCD）侧是否已有等价检查。若已有，本闸可能与之重复，需持有控制台权限的人核一次。
