# 环境治理规范:dev / test / prod(v0.2.0 主线标准)

状态:v1 草案(2026-07-25,Fable 架构)。本规范以 v0.2.0 为唯一标准,收敛当前
乱象(单实例双 schema、账号不存在、密钥命名混乱)。变更需 DC 确认。

## 0. 现状一句话

火山只有 1 个 RDS 实例(名 `shortdrama-dev`),库 `shortdrama` 里塞了两套不同
数据模型:`common`(团队旧系统的活数据,2071 资产)和 `prod`(我们 v0.2.0 的空
迁移)。没有独立生产实例。凭据/命名/权限都没规范,测试站因此连不上库。本规范定
标准 + 收敛动作。

## 1. 三环境定义

| 环境 | 用途 | 实例 | 库 | schema | 应用账号 | 入口 |
| --- | --- | --- | --- | --- | --- | --- |
| **dev** | 开发者本地/联调,数据可弃 | 本地 PG 或共享 dev 库 | shortdrama | v0.2.0 主线 schema | migrator/本地账号 | localhost |
| **test** | 集成测试/预发,全流程验收 | shortdrama-dev(过渡沿用) | shortdrama | v0.2.0 主线 schema | shortdrama_test | shortdrama-main-test.col.com |
| **prod** | 生产 | 见下方 2026-08-12 更正 | shortdrama | v0.2.0 主线 schema | shortdrama_prod | `http://101.126.6.208/` |

> **2026-08-12 更正(DC 口述)**:prod 的 Web 入口已开,地址 `http://101.126.6.208/`——裸 IP、
> 明文 HTTP、无 TLS。本行原写「未开 / 入口待定」,已过期。
>
> **只更正入口这一件事。** 「prod 是否已有独立 RDS 实例」本次没有核实,§0 关于「没有独立
> 生产实例」的描述保持原样待查——入口开了不等于铁律已满足,别拿这条更正当实例问题的结论。
>
> 明文 HTTP 意味着生产登录密码与 bearer token 明文过公网。CLI 侧的处置见
> `zhongwen-shortdrama-cli` 的 ADR 0001:受信端点清单允许显式标注 HTTP,但每次连接
> 都往 stderr 打警告,上 TLS 后一并删除。

> **2026-08-12 补:上 TLS 已排期。** 上一段原写「尚未排期」,已过期。
>
> 摸底结论是不用申请证书:ALB 的 443 监听器和 DigiCert `*.col.com` 通配证书都已就位
> (有效期至 2027-02-07),`deploy/k8s/overlays/prod` 里也已有 443 的 ingress 与证书 ID。
> 缺的只是一条解析记录——已实测 `curl --resolve shortdrama.col.com:443:101.126.6.208`
> 严格校验返回 200,域名一解析过来 HTTPS 立刻可用。
>
> 人工步骤走 `scripts/ops/enable-prod-tls.sh`(七步交互脚本),**第一步是接入备案闸门**:
> 火山引擎会阻断未完成接入备案的域名解析,跳过它去加解析记录会把域名打死。
> 代码侧收尾见 issue #318。
>
> 在 80 跳 443 上线之前,本表 prod 那行的入口地址仍然是明文 `http://101.126.6.208/`,
> 不要提前改成 https。

铁律:**生产必须独立实例**,不与 dev/test 共实例。dev/test 过渡期可共实例,但
必须不同 schema/库 + 不同账号。

## 2. 命名规范

- **实例**:`shortdrama-{dev|test|prod}`。
- **库**:主库统一 `shortdrama`。
- **schema**:表达数据域,**禁止与环境名耦合**。v0.2.0 主线 schema 定名 **`app`**
  (2026-07-25 定,DC 授权 Fable 拍板)。理由:原空壳叫 `prod` 会让人误以为在动
  生产;它当时是空的,改名成本几乎为零,越晚数据越多越贵。旧 `prod` schema 保留
  不删(避免破坏性操作),标记废弃,合流收尾时再清。一个 schema 一套数据模型,
  登记在册。
- **账号**:`shortdrama_{app|test|prod|migrator|readonly}`,用途单一、最小权限。
- **KMS 密钥**:`shortdrama/{env}/{purpose}`,如 `shortdrama/test/postgres`、
  `shortdrama/test/admin`、`shortdrama/prod/postgres`。当前
  `postgreSQL-dev`/`shortdrama-pwd-dev`/`shortdrama/production` 混用,收敛。

## 3. 账户-权限矩阵

| 账号 | 环境 | 权限 | 用途 |
| --- | --- | --- | --- |
| shortdrama_test | test | 读写主线 schema | 应用运行时 |
| shortdrama_prod | prod | 读写主线 schema | 生产运行时(prod 开时) |
| **migrator**(建议新建) | 各 | DDL(建表/迁移) | 仅迁移时用,不进应用运行配置 |
| **readonly** ✅ 已建 | 各 | 仅 SELECT(实测 33/33 表可读、写权限 0/33) | 排查/看板/ETL plan 与画像 |
| admin | 实例 | Super | 仅 DBA 手动运维,禁入任何应用配置 |

现存 socialkb_owner/reader、colapi_app/col_temp_app 属其它业务线(社媒 KB、col
api),不纳入短剧平台运行配置。

## 4. 凭据规范

- **唯一真源 = KMS**。`.env`/环境变量只做镜像;轮换时 KMS 与镜像同步更新。
- 密钥值不写入代码、文档、日志、memory。
- 应用运行账号最小权限;DDL 走独立 migrator;superuser 绝不进应用配置。

### 4.1 待办:dev/test 库密码轮换(2026-07-25 定)

2026-07-25 排障过程中,`postgreSQL-dev` 的密码值因掩码写错被打印进了本地会话
日志(DC 自己的 KMS、自己的终端,未外泄)。处置决定:**轮换,但排在解登录与
全流程验通之后**——轮换会打断现有连接,叠在故障修复上会让因果混淆。顺序:

1. 解登录(要用当前密码)→ 2. 全流程验通 → 3. 轮换密码 → 4. 顺手把密钥名
   收敛成 `shortdrama/test/postgres`(见 §2)→ 5. 同步 configmap/secret 引用并重启

轮换属高影响动作,执行前单独向 DC 确认时间窗。

### 4.2 本机 dev 容器库口令:唯一真源(2026-07-28 DC 拍板)

- 本机 `shortdrama-dev-db-1`(localhost:5432)的 `shortdrama` 角色口令,**唯一真源 = 工作区根 `/Users/user/Workspace/02_AI工具开发/.env` 的 `POSTGRES_PASSWORD`**(DC:「以后能别改了,在这个 workdir 的 .env 固定下」)。
- 各 worktree 的 `.env` 从根同步该键;容器重建(尤其 `down -v`)后口令漂移时,以根 .env 为准 `ALTER ROLE` 对齐,**不改根 .env 迁就容器**。
- 该值以引号包裹存放,应用端 `parseCompatibleEnv` 会剥首尾引号——**shell 侧提取必须同样剥引号**(2026-07-28 实踩:带引号原文被当口令写库,导致应用侧 28 字符与库内 30 字符不一致)。
- **凭据操作规程**(2026-07-25 与 2026-07-28 两次同型事故后固化):①含凭据命令的 stderr 一律重定向进文件,不回显;②向 psql 传敏感值走 stdin + dollar-quoting,禁止 shell 多层引号拼接(07-28 一次转义错误使口令约 2/3 字符经 psql 错误回显进会话记录;涉事口令属本机 dev 容器,暴露面=本地会话,已报 DC,是否轮换由 DC 定);③容器内取单值用 `docker exec sh -c 'printf %s "$VAR"'`,禁止整读 env。

## 5. 关系约束

- **环境隔离**:见 §1 铁律。
- **开发与测试环境不做错误降级**（DC 2026-07-29）：外部依赖连通性、配置或运行错误
  必须暴露为真实错误；不得为了让页面“看起来能用”而新加 `try/catch`、静默吞错或伪造成功。
  生产环境上线前才按已批准的服务连续性方案增加明确、可观测的兜底。排障必须先修通实例、
  网络或配置本身，不能把“暂时没再触发”写成“已修复”。
- **迁移纪律**:应用不自动迁移;迁移用 migrator 账号显式跑;部署验收看
  `/api/v1/ready` 返回 200(不看 /health,它是纯静态存活探针)。
- **schema 登记制**:当前库内 schema 用途——`common`(他们旧数据,**冻结**为合流
  迁移源)、v0.2.0 主线 schema(运行)、`agentkit_social_kb`(社媒 KB,林夕线)、
  `public`(空,勿用)。
- **白名单**:本机直连仅限 dev/test 实例;家宽 IP 会漂,变更即更新
  (当前 `fable-kimi-local-20260725` / acl-2b8f...);**生产不开公网直连**。

## 6. 当前实况 → 规范差距与收敛动作

| # | 差距 | 收敛动作 | 影响面 | 依赖 DC |
| --- | --- | --- | --- | --- |
| G1 | configmap `POSTGRES_USER=shortdrama` 角色不存在 | 改 `shortdrama_test` | 改部署配置 | 是 |
| G2 | 部署引用 KMS `shortdrama/production`(连不上) | 改引 `postgreSQL-dev`(=shortdrama_test) | 改凭据引用 | 是 |
| G3 | `prod` schema 空且名误导,迁移仅到 013 | 主线 schema 定名 `app`,**全量重放 001→020**(空 schema 从头建比在误导名上补更干净),建 Day-0 admin | 跑迁移+写数据 | ✅ 已授权 |
| G4 | 双 schema 混库(common vs prod) | 冻结 common 为迁移源;v0.2.0 独立 schema 运行;数据合流见 task #15 | 架构+数据迁移 | 是 |
| G5 | 无独立生产实例 | prod 规范预留;真开时建 shortdrama-prod 独立实例 + KMS shortdrama/prod/* | 新建资源 | 是 |
| G6 | KMS 密钥命名混乱 | 收敛到 `shortdrama/{env}/{purpose}`,旧密钥标注废弃 | 建/改密钥 | 是 |
| G7 | 部署版 `/ready` 被鉴权挡(401) | ✅ **已修**(commit 2c1ab06:加入鉴权豁免+整应用级回归护栏)。根因是原测试走裸 Fastify 绕开鉴权 hook,测试全绿而线上不可达 | 改代码 | 否(bug) |
| ~~G8~~ | ~~无 migrator/readonly 专用账号~~ | **已关闭**(migrator 07-25、readonly 07-26) | — | ✅ |

## 7. 立即解登录(G1+G2+G3,DC 已授权 2026-07-25)

目标:得到「能登录、空数据」的干净 v0.2.0 测试环境,供内测。**不碰 common 数据。**

执行分两侧,**责任人不同**:

### 7.1 库侧(Fable 可执行,`ve` CLI + psql 通)

1. 用 KMS `postgreSQL-dev`(账号 `shortdrama_test`)连库
2. 建 schema `app`,**全量重放迁移 001→020**(迁移器自带 `CREATE SCHEMA IF NOT
   EXISTS` 与 advisory lock,幂等)
3. Day-0 管理员:迁移 016 通过 `shortdrama.admin_usernames` 会话设置提升配置的
   用户名,**需在跑迁移时带上 `ADMIN_USERNAMES`**

### 7.2 集群侧(Fable **不可执行**,需震宇或可用 kubeconfig)

本机 `kubectl` **无可用 context**(`config get-contexts` 返回空表,API 调用返回
HTML),因此以下三处 configmap 改动我做不了:

| 键 | 现值(错) | 应改为 | 理由 |
| --- | --- | --- | --- |
| `POSTGRES_USER` | `shortdrama` | `shortdrama_test` | 该角色在实例上不存在 |
| 密码来源 | KMS `shortdrama/production` | KMS `postgreSQL-dev` | 前者在 dev 实例上认证失败 |
| `POSTGRES_SCHEMA` | `prod` | `app` | 见 §2 定名 |

改完需重启 deployment。**验收口径:`/api/v1/ready` 返回 200**(现在这个端点已
公开可访问,见 G7),再走登录。

## 8. 合流(v0.2.0 吸收他们有用部分)

见 task #15 与盘点报告。原则:v0.2.0 是标准,吸收他们缺失于我们的有用功能,把他们
的代码/数据/库适配到本规范,合流进统一版本计划,不偏移。数据从 common(冻结源)按
表映射迁入 v0.2.0 主线 schema。

## 测试环境配置的真实来源(2026-07-29 实证,重要)

**测试集群没有 configmap**(只有 `kube-root-ca.crt`),`shortdrama-main` deployment 的 30 个环境变量
**直接写在集群里**,`envFrom` 为空。**因此改仓库 `deploy/k8s/base/configmap.yaml` 对线上零影响。**

- 实证经过:07-29 发版成功、镜像更新,但生成开关、Milvus 私网端点修复、KMS initContainer 全部未生效;
- 当前改法:`kubectl set env deploy/shortdrama-main -n shortdrama KEY=VALUE`(会触发滚动更新);
- **这是权宜之计**。治本(让 deployment 从仓库清单渲染)见 version-plan 卡 `deploy-config-governance`,归外援首批;
- **在治本完成前**:任何人改测试环境配置,必须走 kubectl,并把改动同步回仓库清单(否则下次治本时会丢)。
