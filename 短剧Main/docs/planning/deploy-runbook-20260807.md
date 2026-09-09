# 部署执行单 · 08-07 收工前那一次

> 对应 `goal-monday-20260810.md` §五 的最硬节点:**08-07 收工前功能收口 + 部署测试环境,G1/G2 至少通**。
> 立于 2026-08-06 傍晚,**提前写是因为这一次必须一次成功**——8 月 5 日那次「旧程序不认新数据库」就是临场改配置踩的雷。

---

## 一、这次部署只改一件配置,但它和新镜像必须同时上

| 配置 | 线上现值 | 要改成 | 为什么 |
|---|---|---|---|
| `MILVUS_COLLECTION_ASSET_ENTITY` | `asset_entity_vectors` | **`asset_entity_vectors_v2`** | 新代码里是硬校验(`src/config/env.ts:270-274`),值对不上**启动期直接抛错**,服务起不来 |

**其余配置一项都不用动。** 公司网关六项(地址/密钥/模型清单/拆解/起草/翻译)线上齐全——我 8 月 6 日一度报「三项缺失」,那是**查的时候用错了键名**(查 `ARK_` 开头,实际是 `COL_` 开头),已更正。

**顺序不可颠倒**:改配置和换镜像要在**同一次操作**里完成。先改配置会让旧镜像起不来(旧代码要旧值),先换镜像会让新代码撞上旧值——两种顺序都会造成一次故障窗口。

## 二、前置检查(不满足就不要开始)

```bash
cd /Users/user/Workspace/02_AI工具开发/.worktrees/v011-integration
git fetch origin dev && git log --oneline -1 origin/dev     # 确认要发的水位
bash scripts/lines/check-lines.sh                            # 四条线是否都已收口
gh pr list --repo col-shortdrama/zhongwen-shortdrama-main --state open   # 该合的都合了没
```

判据三条,缺一条就先补:
1. **四条线的 PR 都已合进 dev**(至少 G1/G2 相关的必须合);
2. **GitHub 上 dev 的检查是绿的**——特别是 `verify-postgres`(那 14 个数据库测试只在 push 到 dev 时跑,本机门禁已不跑它们);
3. 本地 `npm run test:node` 绿。

## 三、执行步骤

### 第 0 步 · 清 Docker 悬空卷(2026-08-06 夜实测踩到,不清必失败)

**第一次试构建直接失败**,报 `E: You don't have enough free space in /var/cache/apt/archives/`。

**根因不是网络也不是宿主机磁盘**(宿主机当时还有 36GB):是 **Docker 虚拟机内部塞满**——查出 **2426 个卷,其中 2425 个悬空**,清掉回收 **124GB**。来源是几周里数据库测试反复起 postgres 容器,**每跑一次留一个卷**。

```bash
docker volume ls -qf dangling=true | wc -l     # 先看有多少
docker volume prune -f                          # 清掉(两千多个要跑几分钟)
docker builder prune -f                         # 顺手清构建缓存
```

**这不是一次性问题**——只要还在本机跑数据库测试,卷就会继续攒。每次构建前先跑一遍。

### 第 1 步 · 构建镜像

```bash
cd /Users/user/Workspace/02_AI工具开发/zhongwen-shortdrama-main
git fetch origin dev && git checkout -B release/20260807 origin/dev
SHORTDRAMA_ENV_FILE=.env ./scripts/release-amd64.sh build v0.4.0-$(git rev-parse --short HEAD)
```

**已知的坑(交接书记过)**:本机构建常被代理掐断 Docker Hub。底座换 `--build-arg BOOTSTRAP_IMAGE=docker.m.daocloud.io/library/python:3.11-slim`;Node 官方站慢时用 `docker/node-dist/` 里的离线包。

### 第 2 步 · 推镜像

镜像仓是 `shortdrama-prod-cn-beijing.cr.volces.com/shortdrama/main`(**不是 app**)。推完记下完整 tag。

### 第 3 步 · 改配置 + 换镜像(一次完成)

```bash
export KUBECONFIG=~/.kube/shortdrama-public.yaml    # 公网那把;test.yaml 是内网,本机必然超时
NS=shortdrama                                        # ← 每条命令都要带,不带会报 Forbidden 像权限被收

# 改配置与换镜像合成一次 patch,避免出现两个中间态
kubectl -n $NS set env deploy/shortdrama-main MILVUS_COLLECTION_ASSET_ENTITY=asset_entity_vectors_v2
kubectl -n $NS set image deploy/shortdrama-main <容器名>=<新镜像tag>
kubectl -n $NS rollout status deploy/shortdrama-main --timeout=300s
```

**容器名先查**:`kubectl -n shortdrama get deploy shortdrama-main -o jsonpath='{.spec.template.spec.containers[0].name}'`

### 第 4 步 · 起不来怎么办(先想好再动手)

```bash
kubectl -n shortdrama rollout undo deploy/shortdrama-main     # 回滚镜像
kubectl -n shortdrama set env deploy/shortdrama-main MILVUS_COLLECTION_ASSET_ENTITY=asset_entity_vectors   # 配置也要跟着回
```

**两样必须一起回**,只回一样会留下配置与镜像不匹配的坏状态。

回滚后**先看日志再重试**,不要盲目重来:
```bash
kubectl -n shortdrama logs deploy/shortdrama-main --tail=80
```

### 第 5 步 · 重建资产向量(换集合名的必做动作)

换了集合名之后,**新集合里没有旧数据**——表现是"资产都在,但搜不到"。必须重建:

```bash
npx tsx scripts/rebuild-asset-vectors.mts              # 先 dry-run 看要处理多少条
npx tsx scripts/rebuild-asset-vectors.mts --apply      # 确认无误再真跑
```

脚本说明里记着一件事:v2 集合原有的 476 条向量用的是**我们无权调用的嵌入接入点**,所以要用自己的 Doubao 嵌入模型重建。**这一步会真实调用嵌入接口,有成本**,属于已授权范围内的必要动作,跑完记花费。

### 第 6 步 · 逐门验证(这才是部署成功的判据)

**部署完不等于成功。** 按 goal 的硬门逐条验,验完把结果写进 `outputs/`:

| 门 | 怎么验 |
|---|---|
| 服务活着 | `curl -s -o /dev/null -w "%{http_code}" https://shortdrama-main-test.col.com/` = 200 |
| 搜索可用 | 资产库检索能返回结果(验证第 5 步重建成功) |
| **G1** | 后台开号 → 新账号能登录 |
| **G2** | 新建项目选 9:16 + 清晰度 → 查项目接口,画幅和两个清晰度字段都有值 |
| G4 G5 | 粘剧本 → 拆解 → 分镜落库 |

**G1/G2 是今晚这次部署的最低要求**,goal 里写死的。其余门等对应功能合进来后再验。

## 四、这次部署不做的事

- **不动数据库结构**——迁移由应用启动时自己跑,不手工执行;
- **不改任何其他环境变量**——只改集合名那一个;
- **不趁机清理旧数据**;
- **不在没看日志的情况下重试第二次**。

## 五、留痕

部署完成后:
1. 把镜像 tag、配置改动、重建条数、逐门验证结果写进 `outputs/deploy-20260807.md`;
2. `orchestration.md` 追加一行;
3. 向产品负责人报**能验哪几道门**,不报镜像号和门禁数字。
