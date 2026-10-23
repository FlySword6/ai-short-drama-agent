<div align="center">

<h1>OHAO</h1>

<p><strong>从一页剧本，到可推敲的每一个镜头。</strong></p>

<p>Shortdrama Agent Lab · 中文短剧创作工作台与 Agent 实验项目</p>

<p>
  <img src="https://img.shields.io/badge/status-early_preview-F59E0B?style=flat-square" alt="Early Preview">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="React">
  <img src="https://img.shields.io/badge/Three.js-111827?style=flat-square&logo=threedotjs&logoColor=white" alt="Three.js">
  <img src="https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL">
</p>

<p>
  <a href="#先看一眼">产品演示</a> ·
  <a href="#本地体验">快速开始</a> ·
  <a href="shortdrama-agent-lab/README.md">完整指南</a> ·
  <a href="shortdrama-agent-lab/docs/总体设计.md">产品路线图</a>
</p>

</div>

把剧本、分镜和 3D 机位预演放到一张工作台上。OHAO 希望让短剧创作中的每一次镜头决定，都有原文依据、有画面参考，也有可以继续修改的空间。

本仓库当前的产品入口是 **[shortdrama-agent-lab/](shortdrama-agent-lab/README.md)**。它正在独立构建从中文小说或单集剧本到真人拟真短剧的生产流程；当前可体验逐章小说拆解与校对、资产引用、图片候选生成与人工采用、电影工作台、示例分镜编辑、手工白模和一键自动制片。

## 先看一眼

[![OHAO 动态演示：电影工作台、示例分镜与 3D 导演台](shortdrama-agent-lab/docs/media/product-tour.gif)](shortdrama-agent-lab/docs/media/product-tour.mp4?raw=true)

<p align="center">
  <a href="shortdrama-agent-lab/docs/media/product-tour.mp4?raw=true">查看 / 下载 MP4 演示</a>
  <br>
  <sub>真实前端录制 · 手写分镜样例 · 手工白模练习场景</sub>
</p>

演示展示当前可操作的界面与浏览器内白模，不包含模型自动生成或完整成片生产。

<details>
<summary>展开查看工作台与导演台截图</summary>

**电影工作台**

![OHAO 电影工作台](shortdrama-agent-lab/docs/media/workspace.png)

**3D 导演台**

![OHAO 3D 白模导演台](shortdrama-agent-lab/docs/media/director.png)

</details>

## 三种方式，推敲一个镜头

### 01 · 对照原文，修改分镜

粘贴或导入 TXT 保存剧本；用内置手写样例体验原文与对白对照，调整画面设计、景别、运镜和预计时长。每行代表一个连续镜头，手工修改有标记，前端草稿可以保存并导出 JSON。导入新剧本不会自动替换样例分镜。

### 02 · 在浏览器里，摆出你的机位

进入 3D 导演台，调整人物体型、姿势、站位、焦段与光照，导入本地 GLB，用白模验证空间关系。支持场景保存、JSON 导入导出，以及 PNG、机位宫格、深度图和短 WebM 运镜预览。

### 03 · 让拆解、检查和采用有迹可循

「真实项目」已接入本地后端和 PostgreSQL：保存剧本版本，通过 Pi Agent Core 提取事实，查看程序检查，采用事实，再生成并采用分镜候选。原文引用、设计建议与采用决定分别记录。

## 本地体验

准备 **Node.js ≥ 22.19** 和 npm，即可先体验前端；无需数据库或模型账号。

```sh
git clone https://github.com/K80Tom/frame-shortdrama-agent.git frame
cd frame/shortdrama-agent-lab
npm --prefix web ci
npm --prefix web run dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)，浏览示例分镜，或直接进入 [3D 导演台](http://127.0.0.1:5173/#/director)。

示例草稿和白模场景保存在当前浏览器中，可通过页面导出留存。浏览器内渲染与视频录制需要 WebGL 和 MediaRecorder 支持。

想运行真实项目与模型链路？继续阅读 **[完整启动指南](shortdrama-agent-lab/README.md#启动真实项目与文字链路)**：需要本地 PostgreSQL、后端及服务端模型连接。通用、小说/剧本拆解、生图和生视频连接可分别配置并切换；地址和密钥只保存在本机后端，每次付费文字调用或图片候选生成都需显式确认可能计费。

## 当前做到哪里

OHAO 处于 **Early Preview**。下面区分了已经落地的能力与后续建设方向：

| 当前可用 | 仍在推进 |
| --- | --- |
| 本地电影工作台、示例分镜编辑与草稿导出 | 真实项目中的完整编辑、候选比较与按场重做 |
| 手工 3D 白模、机位预演与浏览器渲染导出 | Agent 自动摆场与下游媒体生成衔接 |
| 事实拆解、程序校验、分镜候选与人工采用的代码链路 | 真实付费模型输出质量验收与语义质检 |
| PostgreSQL 保存项目、小说版本、资产候选、制片聚合与执行记录 | 分布式调度、对象存储、CDN 与多用户权限 |
| 人物/场景/道具资产库、结构化视觉简报、图片候选与人工接受/拒绝 | 面向人物一致性、表演与剧情语义的自动视觉质检 |
| 一键自动制片：剧本拆解、资产补全、分镜、按需 3D 约束、多视频候选、技术复核、返修、FFmpeg 合成与交付 | 独立配音、口型同步、音效、配乐与字幕制作 |

全流程自动制片已经在 `shortdrama-agent-lab` 内独立实现，支持持久化节点进度、预算授权、断点恢复、候选选择、技术复核和成片交付。真实模型运行仍需在本机配置对应连接并明确授权可能产生的费用；当前视频复核聚焦格式、时长、比例、分辨率和音轨等技术指标，3D 导演台以白模数据生成提示词约束。

完整目标是约 1–2 分钟、竖屏 9:16、中文对白的真人拟真短剧，以及可继续编辑的项目。具体阶段与验收标准见 [总体设计](shortdrama-agent-lab/docs/总体设计.md)。

## 找到你需要的入口

| 你想做什么 | 入口 |
| --- | --- |
| 了解产品、完整启动与路线图 | [OHAO 项目 README](shortdrama-agent-lab/README.md) |
| 了解工作台操作与本地保存 | [前端说明](shortdrama-agent-lab/web/README.md) |
| 配置后端、数据库与迁移 | [本地开发](shortdrama-agent-lab/docs/本地开发.md) |
| 配置模型连接、用途选择与调用限制 | [独立模型配置](shortdrama-agent-lab/docs/独立模型配置.md) · [模型接入](shortdrama-agent-lab/docs/模型接入.md) |
| 看设计、架构与数据约定 | [总体设计](shortdrama-agent-lab/docs/总体设计.md) · [技术架构](shortdrama-agent-lab/docs/技术架构.md) · [数据结构](shortdrama-agent-lab/docs/数据结构-v0.1.md) |
| 反馈问题或提出想法 | [GitHub Issues](https://github.com/K80Tom/frame-shortdrama-agent/issues) |

## 仓库导航：产品与历史参考

**默认开发、运行与阅读入口均为 `shortdrama-agent-lab/`。** 其他同级内容用于历史阅读、方法提炼与来源核对，不是 OHAO 的运行依赖。

| 路径 | 定位 |
| --- | --- |
| **[`shortdrama-agent-lab/`](shortdrama-agent-lab/README.md)** | **当前独立产品，包含工作台、后端、测试与设计文档。** |
| `短剧Main/` | 旧平台源码参考；已授权的 3D 导演台模块已独立迁入新项目。 |
| `shortdrama-agent/` | 旧 Agent 实现与规则参考。 |
| `shortdrama-cli/` | 旧命令行方案参考。 |
| `zhongwen-shortdrama-agent` | 空占位文件，并非文件夹或可运行项目。 |
| 根目录《短剧智能体-源码分析与 MVP 建议》 | 历史调研材料；当前产品设计以新项目 `docs/` 为准。 |

启动 OHAO 无需安装或运行历史参考项目，也不依赖旧平台的 Main API、数据库、账号或部署配置。

## 来源与许可

3D 导演台和所用组件的来源、适配与许可记录见 [第三方代码说明](shortdrama-agent-lab/web/THIRD_PARTY_NOTICES.md)。项目尚未声明统一开源许可证；使用与分发时请核对各代码、样例和素材的来源与许可。

---

<div align="center">
  <p><strong>让创作从可看见的镜头开始。</strong></p>
  <p><a href="shortdrama-agent-lab/README.md">进入 OHAO 完整指南 →</a></p>
</div>
