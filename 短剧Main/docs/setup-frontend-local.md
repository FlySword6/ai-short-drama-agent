# 前端本机开发环境(实测验证版)

> 给丽芬和任何做前端的同事。2026-07-29 在干净检出上完整实跑验证:Vite 起得来、接口代理正常、能登录、页面能改能热更新。
>
> **安全提醒(重要)**:**不要用任何人给你的 `.env` 文件。** 本机做前端开发不需要 `.env`、
> 不需要 Docker、不需要数据库、不需要任何证书。有人给你 `.env` 请直接拒绝并告诉 DC——
> 之前流传的一份模板里连的是生产数据库,拿它「跑本地」会直接连上线上库。

## 你的开发方式

代码在你自己电脑上改,浏览器立刻看到效果(热更新);**数据和接口走测试环境**,所以你看到的是真实数据、真实交互,不用自己搭后端。

## 一次性准备(只做一遍)

1. **装 Node.js 22 或更高**:https://nodejs.org 下载 LTS 安装。装完终端里 `node -v` 应显示 v22 以上。
2. **装 Git**:https://git-scm.com/downloads,装完 `git -v` 有版本号即可。
3. **拿仓库权限**:把你的 GitHub 用户名发给 DC,加进 `col-shortdrama` 组织。
4. **拉代码**(终端里执行,放哪个目录随你):

```bash
git clone https://github.com/col-shortdrama/zhongwen-shortdrama-main.git
cd zhongwen-shortdrama-main
```

代码默认就在 `dev` 分支(日常开发分支),不用切。

## 每天开工(三条命令)

```bash
git pull
cd frontend/shortdrama-rag-demo
npm install
```

然后启动(macOS / Linux):

```bash
SHORTDRAMA_DEV_API=https://shortdrama-main-test.col.com npm run dev
```

Windows(PowerShell):

```powershell
$env:SHORTDRAMA_DEV_API="https://shortdrama-main-test.col.com"; npm run dev
```

**必须是 `https://`。** 测试环境入口只开了 443,写成 `http://` 连不上,现象是页面能开、数据全空。

浏览器打开它提示的地址(一般 http://localhost:5173)。登录账号找 DC 要。

**每次开工只需要这一条启动命令。** `npm install` 只在第一次或 `git pull` 带来依赖变化时需要。

## 本机端口约定(2026-08-03 治理)

- **5173** = Vite dev server(前端热更新),`/api` 由它代理到本机后端;
- **8000** = 本机唯一正式 API(容器栈或 dist 生产态后端;不设 `SHORTDRAMA_DEV_API` 时代理默认就是 8000);
- **8080** = 历史 tsx watch 后端默认端口,已退役,不再是代理默认;只有当你自己显式在 8080 起了后端,才用 `SHORTDRAMA_DEV_API=http://localhost:8080` 指过去。

## 你改代码的地方

前端源码全在 `frontend/shortdrama-rag-demo/src/`:

| 想改什么 | 去哪 |
| --- | --- |
| 颜色、字号、间距等设计变量 | `src/tokens.css`、`src/oriental.css` |
| 通用组件(按钮、弹窗、卡片) | `src/ui.tsx`、`src/components/` |
| 某个具体页面 | `src/pages/`(项目页、工作台、资产中心等按文件名找) |
| 全局外壳与导航 | `src/app.tsx` |

保存即生效,浏览器自动刷新,不用重启。

## 三件要知道的事

1. **你看到的是测试环境的真实数据**——页面上的新建、提交、删除都会真写进测试环境。看和调样式随便玩,**删除类操作手下留情**,那是大家共用的验收数据。
2. **只改前端不会影响别人**——你的改动在你自己电脑上,推分支之前谁也看不到。
3. **图片视频加载不出来时**先确认启动命令里的地址没打错(写成 `http://`、少了协议头或域名错了,页面都能开但列表全空)。

## 改完怎么交

- **只提意见**:截图 + 一句话说清「哪个页面、哪里不对、期望什么样」,发飞书。
- **改了代码**:推自己的分支,我们来验收合并:

```bash
git checkout -b lifen/这次改的主题
git add -A
git commit -m "样式:一句话说明改了什么"
git push -u origin lifen/这次改的主题
```

推完飞书说一声。**不要直接往 `dev` 或 `test` 分支推。**

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `npm install` 很慢或报网络错 | `npm config set registry https://registry.npmmirror.com` 后重试 |
| 5173 端口被占 | `npm run dev -- --port 5174`,浏览器开 5174 |
| 页面开了但数据全空 | 启动命令里的 `SHORTDRAMA_DEV_API` 地址不对。最常见是写成了 `http://`——测试环境只开 443,必须 `https://`;核对后重启 |
| 有人让你配 `.env` / 装 Docker / 找证书 | **不需要,拒绝**,前端开发用不上,见文首安全提醒 |
| 登录不上 | 账号找 DC;测试环境注册要邀请码,别自己注册 |
| `node -v` 低于 22 | 重装 Node LTS(旧版本起不来,会报奇怪的语法错) |

## 需要完整后端环境时(暂时别走)

如果将来你要连自己的本地后端(改接口联调),那条路目前有已知断点正在修,修完会另出一份指引。
现阶段前端开发用不到它。
