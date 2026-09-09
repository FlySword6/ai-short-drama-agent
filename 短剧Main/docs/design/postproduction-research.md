# v0.3.0 后期流程技术调研(v1,2026-07-26,S28 包)

调研包:`outputs/kimi-goal-s28-postproduction-research-20260726.md`。执行:s28 包(Kimi);架构与验收:Fable。
性质:**技术调研,不是实现**。文中数据模型与接入点均为草案,落代码前需 Fable 裁定为合同。
外部事实均标注一手来源与检索日期(2026-07-26);事实与推断在第九节分列,未验证项单列。

阅读前提:`docs/design/version-plan.md`(v0.3.0 主题=后期流程)、
`outputs/inspiration-impact-20260726.md` §4(Clypra 竞品判断)、
`docs/contracts/platform-ontology.md` R9/R10、`docs/contracts/v0.2.0/sound-workshop.md`、
`docs/contracts/v0.3.0/edit-submission-and-storage.md`。

---

## 一、一句话结论

**v0.3.0 后期流程 = 时间线文档单一真源(PG jsonb,双端共享 schema)+ 浏览器内 WebCodecs 帧级预览(效果白名单)+ 服务端 FFmpeg 异步渲染(复用 generation 任务生命周期)+ 成片作为 `media_results` 一员走既有审核与交付门禁。**

最大的风险**不是性能,是「预览画面 ≠ 最终成片」**——剪辑类产品最容易翻车的地方。浏览器合成器与 FFmpeg filter graph 是两套渲染实现,像素级一致不可承诺。本调研的对策是把一致性承诺收窄到可验证的三层:**布局一致、时间一致、内容一致**(第二节),并用效果白名单 + 时间戳基准 + 渲染后自动抽帧比对把风险锁死在白名单内。

---

## 二、架构分界方案(浏览器 vs 服务端)

### 2.1 分界总表

| 层 | 放哪 | 内容 |
| --- | --- | --- |
| 时间线交互 | 浏览器 | 拖拽、排序、裁剪、seek、缩略图条、吸附;React + Zustand(分域 store,可参考 Clypra `src/store/` 切分) |
| 预览解码 | 浏览器 | mediabunny 解封装(HTTP range 懒加载)+ WebCodecs 解码出 `VideoFrame`;能力探测失败降级为 `<video>` 单 clip 播放 |
| 预览合成 | 浏览器 | canvas 2D / WebGL2 按时间线文档逐帧合成:多 clip 切换、白名单转场、字幕叠加 |
| 撤销/重做 | 浏览器内存 | command 模式 + 合并窗口(Clypra `CommandJournal`:100 级、500ms coalescing),不落库 |
| 草稿/版本持久化 | 服务端 PG | 草稿自动保存(防抖)与显式版本凝固,jsonb 整存,写入时 zod 强校验(第三节) |
| 缩略图/atlas | 服务端预生成 | 素材入库或首次上时间线时按固定时间网格抽帧,产出多档金字塔 + atlas 落 TOS(第四节) |
| 成片渲染 | 服务端 | FFmpeg 子进程,由时间线版本文档编译 filter graph;复用 generation 任务生命周期(2.3) |
| 字幕烧录 | 服务端 | `subtitles` filter(libass),ASS 由服务端从受控样式集编译(第五节) |
| 审核/交付门禁 | 服务端 | 成片= `media_results` 一员,复用 `isMediaReviewCleared` 与 `buildGatedManifest`(第六节) |

**为什么预览必须放浏览器**:我们是 Web 应用,预览的核心负载是「播放头任意跳转 + scrub」,延迟预算在 50-100ms 级,任何服务端回传帧的方案都过不去这个预算。Clypra 把解码放本地 Rust 是对的,我们的等价物是浏览器本地解码。

**为什么成片必须放服务端**:ffmpeg.wasm 官方 FAQ 自述「WebAssembly is still a lot slower than native」、多线程版仅约 2 倍提速且要求 SharedArrayBuffer(需全站 COOP/COEP 隔离)、输入文件硬上限 2GB、仓库自标 experimental(一手:https://github.com/ffmpegwasm/ffmpeg.wasm 、https://ffmpegwasm.netlify.app/docs/faq ,2026-07-26)。成片是交付物,必须可重跑、可审计、与预览环境无关——只能在服务端。

### 2.2 预览与成片的一致性方案(本调研核心)

**模型:Shotstack 式「单一 JSON 真源」+ Remotion 式「同一数据源驱动两种渲染」,但不引入任何一方运行时。**
(一手:Shotstack Edit API 以 `timeline{tracks[clips]}+output` JSON 为唯一输入,同一 JSON 出 `preview` 低清与正式成片,https://shotstack.io/docs/api/ ;Remotion 以「React 组件即画面」让预览与渲染跑同一份代码,https://www.remotion.dev/docs/the-fundamentals 。均为 2026-07-26 检索。)

五条规则:

1. **时间线文档是唯一事实。** 预览渲染器与服务端 FFmpeg 编译器都从同一份版本文档出图,禁止任何一端私改参数。schema 双端共享镜像——与 `EDIT_DIMENSIONS` 双端镜像纪律同一先例(`docs/contracts/v0.3.0/edit-submission-and-storage.md` L23-25)。
2. **时间基准用整数时间戳,禁止帧号索引。** WebCodecs `VideoFrame.timestamp/duration` 以微秒计(一手:https://developer.mozilla.org/en-US/docs/Web/API/VideoFrame );FFmpeg 转码场景 input seeking 默认帧精确(`-accurate_seek`,一手:https://ffmpeg.org/ffmpeg.html )。源素材可能 VFR、起始时间戳非零(mediabunny 文档明确警告首帧时间戳可正可负,https://mediabunny.dev/guide/reading-media-files ),帧号不可移植。文档内所有时间量存整数毫秒(`*_ms`),输出恒定帧率(`fps` 进文档)。
3. **效果白名单。** v0.3.0 只承诺:clip 裁剪/拼接、xfade 小子集转场(fade/dissolve/wipe 方向系,fadeblack/fadewhite)、音量与淡入淡出(acrossfade/volume)、白名单字幕样式。预览与 FFmpeg 只实现同一参数语义的这几十种组合——**一致性风险被锁在白名单内,扩张白名单 = 重新验收一致性**。
4. **同一字体文件双端分发。** 预览用 webfont,服务端 `--enable-libass --enable-libfontconfig` + `fontsdir` 指向同一字体文件(打包进镜像)。字体版权单列待验证(第九节)。
5. **渲染后自动抽帧比对(验收手段)。** 渲染任务收尾时,对成片在若干时间点 t 抽帧,与预览在同 t 的合成结果做感知比对(pHash/SSIM 阈值);不一致标「需人工」而不阻断——自动化做质检预检是红线允许的范围(AGENTS.md §4)。

**承诺边界(写进产品文案,防翻车):** 我们承诺**布局一致**(位置/尺寸/顺序)、**时间一致**(裁剪点/转场点/字幕区间,帧级)、**内容一致**(同一段素材、同一句字幕、同一字体);**不承诺像素级一致**——浏览器合成与 libass/freetype 的抗锯齿、混合模式、字距微差客观存在,消除成本远超收益。

### 2.3 渲染任务:复用 generation 生命周期,不另起一套

**结论:复用。四条理由,前两条是硬约束:**

1. **结构硬约束**:`media_results.request_id` / `attempt_id` 为 `NOT NULL REFERENCES generation_requests/generation_attempts`(迁移 001,`migrations/001_v01_core.sql:410-411`)。成片要登记为可审核、可交付的产物,就必须有 request/attempt 行——不复用 generation 就得改这两列的零约束,动的是交付物主表。
2. **合同先例**:v0.3.0 已冻结合同拍板「EDIT 是一种生成任务,不是新流程——复用 estimate → quote confirm → submit 与全部付费红线,不另建旁路端点」(`docs/contracts/v0.3.0/edit-submission-and-storage.md` L3-4)。渲染与 EDIT 同形:都是「以既有产物为输入的新任务」。
3. **免费继承**:幂等(`request_hash` + `client_idempotency_key`,迁移 001:332-333)、预算 advisory lock 与 `budget_exceeded`、PG 行锁租约 worker(`FOR UPDATE SKIP LOCKED`,`src/modules/generation/repository.ts:748-774`)、记账(cost_entries 视图自动覆盖 generation 请求,迁移 016:380-418)、审计——另起一套这些全要重做。
4. **架构合同**:单进程单运行时、不引入消息中间件(`docs/contracts/v0.1.1/architecture.md` L66-71);generation worker 进程内 `setInterval` 轮询是既定先例,渲染 worker 照此办理。

**差异点(复用不等于无改动):**

- 渲染**不调用外部付费 provider**。phase 机简化:`created → submitting(本地编译 filter graph)→ provider_running(spawn ffmpeg) → persisting → complete`;`provider` 字段填约定值(如 `ffmpeg-local`),provider_task_id 存本地进程/作业标识。
- 报价环节语义变化:没有供应商账单,estimate = CPU/存储**成本估算**(第七节口径),confirm 仍是人点一次——「一次点击一个任务」红线逐字不变(AGENTS.md §4)。
- 渲染输入钉**不可变版本**:`timeline_version_id` + `state_sha256` 进请求参数,`request_hash` 天然覆盖「同一版本重复导出」幂等。
- 产物登记需一个小迁移:`media_results.origin_kind` CHECK 现为 `('generation','asset_media')`(迁移 012),需加 `'render'`;`shot_id` 已可空(001:412,无 NOT NULL),episode 级成片落库无障碍;`media_kind='video'` 在既有 CHECK 内(001 起,020 已扩七处含 `audio`)。

**同步等待还是异步?异步。** 每分钟 1080p 成片渲染估 10-30 秒 CPU 时间(第七节算式),一集 2-3 分钟即 0.5-1.5 分钟,同步 HTTP 必超时;且 generation 已是异步轮询范式,前端任务状态 UI 有先例。

### 2.4 Clypra 架构为什么不能直搬(备忘)

一手核实(源码 master `9837963`,2026-07-26):无 headless/CLI,全部能力经 Tauri IPC 暴露;持久化是**每工程一个 JSON 文件**(原子写 `.tmp`+rename,`src-tauri/src/commands/project.rs`),**不是 README 声称的 SQLite**;导出 = 前端 PixiJS 逐帧出 RGBA 经批量二进制 IPC 喂给 spawn 的 ffmpeg 子进程(stdin rawvideo),或满足严格条件时走「分段渲染 + ffconcat `-c:v copy`」原生路径(`src-tauri/src/commands/export.rs`、`native_export.rs`)。其「逐帧合成在 JS、编码在 ffmpeg」的总体形与我们的预览/渲染分工同构,可借鉴;其绑死桌面 GPU 与本地文件系统,不可作组件。

---

## 三、数据模型草案(时间线/轨道/片段/字幕,与 shots 的关系)

### 3.1 总形:草稿区范式,与迁移 021 同构

迁移 021 已建立平台级先例:**草稿区 jsonb 聚合 → 人工确认 → 单事务落正式表**(`script_breakdown_runs` 状态机 `queued→running→draft/failed→confirmed/discarded/superseded`,`migrations/021_script_breakdown.sql`)。时间线照搬这一范式:

```
编辑操作 → timeline_drafts(自动保存,防抖,每动一下只 UPDATE 一行)
   ↓ 人点「存版本」
timeline_versions(不可变,state_sha256)
   ↓ 人点「导出」
render 任务(generation 生命周期) → media_results(origin_kind='render') → 审核 → 交付门禁
```

**为什么不把 clip 拆成结构化行**:拖拽/裁剪是每秒钟多次的高频操作,结构化行意味着一次拖动 UPDATE 多行 + 撤销栈映射到行变更,复杂且慢;而时间线是一个强聚合,整存整取与 Clypra(project JSON)、OTIO(整体文档模型)一致。代价是 DB 层失去 FK 校验——**用纪律补:所有写入必须经服务层 zod parse + 引用存在性检查**(本项目架构边界本就禁止 HTTP 层直写 SQL,`docs/contracts/v0.1.1/architecture.md` L51-57)。这正落 R9 补充款:「关系与 jsonb 契约结构属于不变量,要受控且可自动校验」(`docs/contracts/platform-ontology.md` L89-96)——硬在校验,不在约束形式。

### 3.2 表草案(调研级,非 DDL)

**`timeline_drafts`** —— 每集一份活草稿

| 列 | 说明 |
| --- | --- |
| `episode_id` PK FK | 一集一条活动时间线,与交付单位对齐 |
| `state` jsonb | 完整时间线文档(3.3),zod 受控 |
| `base_version_id` FK 可空 | 从哪个版本分叉(空=从「上时间线」初始化) |
| `epoch` bigint | 乐观锁,等价 Clypra timelineStore 的 `epoch` 缓存失效位 |
| `updated_at` / `updated_by_user_id` | 治理字段 |

**`timeline_versions`** —— 不可变版本

| 列 | 说明 |
| --- | --- |
| `id` PK,`episode_id` FK,`version_no` int | `(episode_id, version_no)` 唯一 |
| `state` jsonb 不可变 + `state_sha256` | 与 021 `episode_script_versions`(script_text + script_sha256)同构 |
| `created_by_user_id` / `created_at` / `note` | 治理字段 |

**`subtitle_styles`** —— 字幕样式词表(与迁移 020 三张词表同构:`id/display_name/sort/active/created_by/created_at`,加 `ass_style jsonb` 受控 schema)。样式名可增(软),样式的 jsonb 形状受控(硬)——R9 的标准应用。

**不新设的表**:轨道、片段、转场、字幕 cue 全部是时间线文档内的结构(3.3),不设行表。渲染产物复用 `media_results`(仅需 `origin_kind` 加 `'render'`);渲染任务复用 `generation_requests/attempts`;交付复用 `delivery_records`(019,加记 `timeline_version_id` 与 `state_sha256` 即完整回答「哪集交了、交的哪版、谁交的、何时」)。

### 3.3 时间线文档形状(state jsonb)

```
{
  "schema_version": 1,
  "fps": 30,                          // 输出恒定帧率
  "canvas": { "width": 1080, "height": 1920 },
  "tracks": [
    { "id": "...", "kind": "video" | "audio" | "subtitle",   // 渲染协议,属系统不变量(硬)
      "index": 0, "muted": false,
      "clips": [
        { "id": "...", "media_result_id": "<uuid>",           // 硬引用:写入时查库校验
          "source": { "shot_id": "<uuid>|null" },             // 溯源,软
          "start_ms": 0, "duration_ms": 2400,                 // 时间轴位置与长度
          "in_ms": 300, "out_ms": 2700,                       // 素材内裁剪区间
          "volume": 1.0, "fade_in_ms": 0, "fade_out_ms": 0 }
      ],
      "transitions": [
        { "id": "...", "from_clip_id": "...", "to_clip_id": "...",  // 硬引用:同轨相邻才合法
          "type": "fade", "duration_ms": 500 }                      // type ∈ xfade 白名单
      ],
      "cues": [                        // 仅 subtitle 轨
        { "id": "...", "start_ms": 100, "end_ms": 2300, "text": "...",
          "style_id": "subtitle_styles.id",                          // 硬引用词表
          "source": { "line_indices": [12,13], "media_result_id": null } }  // 溯源,软
      ]
    }
  ]
}
```

模型语义借鉴 OTIO:Track 子项为 Clip/Gap/Transition;Transition 以 `in_offset/out_offset` 吃相邻 clip 媒体做叠化、**不改变轨道总长**(一手:https://opentimelineio.readthedocs.io/en/latest/tutorials/otio-timeline-structure.html )。v0.3.0 不引 OTIO 运行时,间隙在 v0.3.0 用「clip 首尾相接」约束规避(与 Clypra 原生导出资格同思路),Gap 留到多轨期。

### 3.4 与 shots 的关系:分镜是创作单位,片段是剪辑单位

- **1:N 溯源,不级联。** `clip.source.shot_id` 只是溯源;弃用/删除 shot 不动 clip,clip trim 不回写 shot。一个 shot 可被剪成多个 clip,也可整段不用。
- **「上时间线」= 人的显式动作**(R10:关系由人建立,系统绝不自动绑定,`platform-ontology.md` L97-101):从本集有已选视频主版本的 shots,按 `sort_order` 生成初始草稿——每 shot 一个 clip,时长取 `media_results.duration_seconds`(空则 `shots.duration_seconds`),音轨随视频。这个动作是「一键」但**必须是人点的一键**。
- **clip 的真正硬引用是 `media_result_id`**(FK 存在性 + `persistence_status='persisted'` + 项目归属,写入时校验)。注意:上时间线**不**要求素材已过审——剪辑是工作过程;**过审门禁在导出与交付**(第六节),与现状「未过审不设主、不交付」一致,但位置后移一级:主版本门禁管素材,导出门禁管成片。

### 3.5 版本与撤销分层(回答「不能每动一下就落正式版本」)

| 层 | 频率 | 存在哪 | 实现 |
| --- | --- | --- | --- |
| 操作(拖动/裁剪/键入) | 每秒多次 | 前端内存 | command 模式 undo/redo,500ms 合并窗口 |
| 草稿 | 防抖 1-2s 或操作停歇 | `timeline_drafts` 一行 UPDATE | epoch 乐观锁;冲突=后写加载最新再合并提示 |
| 版本 | 人点「存版本」 | `timeline_versions` 不可变行 | 从草稿凝固,sha256 |
| 发布(导出) | 人点「导出」 | render 任务 + `media_results` | 钉 version;产物进审核与交付门禁 |

---

## 四、性能方案:逐条对照 Clypra 四项

Clypra 四项在**代码层面都真实存在、机制清晰**(本节引用均为一手源码:仓库 `github.com/AIEraDev/Clypra`,master commit `9837963b4cc02763052aeabb9fdda9cd2559fd34`,2026-07-26);但其所有量化数字(90%/70%/5-10ms)**只有 README 与注释自述,无基准代码**,且 README 引用的 `PERFORMANCE-DESKTOP-ROADMAP.md` 在仓库全历史中从未存在。引用其数字时必须带这个折扣。

### 4.1 filmstrip 密度分级 L0–L3 → **可用,改造为服务端预生成金字塔**

Clypra 机制:缩略图时间戳对齐固定网格,按 zoom 选档;L0–L3 = 160×90/240×135/320×180/480×270,时间间隔 5s/1s/0.2s/0.02s 一帧(高运动加密);缩放只增删边缘 tile;解码一次全分辨率后并行降采样出全金字塔(`src-tauri/src/thumbnail_engine/pyramid.rs`、`src/lib/filmstrip/filmstripTiers.ts`)。

Web 等价:**抽帧这活放服务端**(素材入库或首次上时间线时,ffmpeg 按固定网格 `fps=1/5,1/1,5/1` 三档抽帧 + 降采样),产物落 TOS;前端按 `px_per_sec` 选档,阈值可直接抄 Clypra 起始参数(目标每缩略图 80px:`time_per_thumb = 80/px_per_sec`,`>3s→L0, >0.5s→L1, >0.05s→L2, 否则 L3`,`types.rs` L217-229)。浏览器内用 mediabunny+WebCodecs 现抽只作**降级路径**(缩略图未就绪时),不对长素材做主路径——流量与首开延迟都不可控。

### 4.2 atlas 打包 → **直接可用(Web 的经典技术)**

Clypra 机制:8×4=32 张缩略图拼一张无损 WebP atlas,`{video_id}_{density}_{index}_{tier}.webp`,`DashMap<timestamp_ms, AtlasLocation>` 定位 col/row(`atlas.rs`)。代码注释口径是「文件数减 32×」;**「IPC 降 90%」在代码中属于导出路径的批量写帧,README 张冠李戴到了 atlas 上**——引用时按「文件数减 32×」表述。

Web 等价即 sprite 雪碧图(YouTube 预览条同款):HTTP/2 多路复用下仍有确定收益——HTTP 请求数减 32×、图片解码与缓存条目减 32×、预载边界简单。有损 WebP(质量 ~80)即可,缩略图不需要无损。

### 4.3 decoder 预热 → **可用,拆成数据预热 + 解码器预热两层**

Clypra 机制:工程加载阶段批量(每 4 个并发)把解码器提前塞进池,首帧延迟自述 5-10ms vs 冷启 50-100ms(注释自述,无基准;另一处注释称冷启 20-50ms,口径不一)。

Web 等价:(a) **数据预热**——mediabunny `UrlSource` 自带「按访问模式智能预取」(一手:https://mediabunny.dev/guide/reading-media-files ),应用层再加播放头前方 N 秒与相邻 clip 关键帧区间的 range prefetch;(b) **解码器预热**——每 clip 一个 `VideoDecoder` 实例池,播放头接近时提前 `configure()` 并喂到首个关键帧后暂停;池容量 4-8 起步(Clypra 的 20 并发是桌面内存预算,浏览器标签页给不了)。**Web 侧首帧延迟没有一手基准,需自测**(第九节)。

### 4.4 GOP 内前向解码 → **直接可移植,WebCodecs 模型同构**

Clypra 机制:目标 pts 在当前解码位置之后且 ≤2s 窗口 → 不 seek,顺序前向解码(中间帧丢弃);连续前向命中 ≥3 窗口放宽到 2×;否则 `av_seek_frame(BACKWARD)` 退到目标前最近关键帧再顺序解码(`decoder.rs` L76-119, L412-460)。注意实现是「2 秒前向窗口」而非严格 GOP 边界判断——简化但有效。「seek 降 70%」仅 README 自述。

WebCodecs 语义几乎一一对应:`flush()` 之后下一个 chunk 必须是 key chunk(规范硬性,一手:https://w3c.github.io/webcodecs/ ),即 seek 本来就只能回关键帧;前向窗口逻辑照抄(2s 起步,连续命中放宽)。配合 mediabunny `getKeyPacket()` 定位关键帧,移植无障碍。

### 4.5 顺带可抄的两件

- **undo 栈**:`CommandJournal{maxSize:100, enableCoalescing:true, coalescingWindowMs:500}`——纯状态变换 command + 合并窗口(`historyStore.ts` L72-76),不是我们发明的必要性,直接照参数起步。
- **波形**:v0.3.0 不做精确音画对齐,但音频轨显示波形条成本极低——浏览器 Web Audio `decodeAudioData` 算 peak/RMS 桶(Clypra 降级路径同款,`src/lib/audio/audioWaveformGenerator.ts`),或服务端 ffmpeg 预生成随缩略图一起走。

---

## 五、字幕方案

### 5.1 字幕从哪来:三个来源,优先级递减

| 来源 | 时间轴 | 现状 |
| --- | --- | --- |
| **(a) TTS 字幕 JSON** | **字级时间戳**,最精确 | 声音工坊合同:`enable_subtitle=true` 默认开,「字级时间戳=短剧对轨关键能力,产物随附字幕 JSON 落库」,随音频产物存 `media_results` 同链(`docs/contracts/v0.2.0/sound-workshop.md` L37-42)。**JSON schema 待验证**(第九节) |
| **(b) 剧本文案行** | 无时间轴,需继承+微调 | `ScriptLine{lineIndex, text}` 只有序号与文本,不落库、可从剧本版本确定性重建(`src/modules/script-breakdown/lines.ts:13-19`);shot 候选有 `lineIndices` 关联 |
| **(c) 手动录入** | 人给 | 兜底 |

**(b) 的对齐算法(草案)**:cue 初始区间 = 所属 clip 的 `start_ms..start_ms+duration_ms`,同 clip 多行按**字数加权**切分;clip 裁剪(trim)后 cue 区间按比例重映射并 clamp 到新区间;人在字幕轨上微调。对齐质量依赖「配音时长≈镜头时长」的生产习惯,错位由人修——**自动化做草稿准备,人做交付判定**(AGENTS.md §4)。

**(d) ASR 反打**(对上传实拍素材自动转写):v0.3.0 不做,留待评估(供应商与成本未调研,第九节)。

### 5.2 烧录与样式

- **烧录在服务端**,`subtitles` filter:FFmpeg 官方文档确认其依赖 libass(`--enable-libass`),且喂 SRT/WebVTT 也会先内部转 ASS 再渲染(一手:https://ffmpeg.org/ffmpeg-filters.html#subtitles )。服务端流程:时间线 cues + `subtitle_styles.ass_style` → 编译 ASS(`[V4+ Styles]` 从样式词表出,`[Events]` 从 cues 出)→ `subtitles=...:fontsdir=<镜像内置字体目录>`。`force_style` 可作全局兜底。SRT/WebVTT→ASS 用 `ffmpeg -i in.srt out.ass` 即可,不需第三方库(本次调研实测命令成功,FFmpeg 7.1)。
- **ASS 能力面**(样式白名单从中取子集):字体/字号/颜色/描边/阴影/对齐/边距/定位(样式行 + override tags;索引:libass README → Aegisub 手册 ASS Tags,https://github.com/libass/libass 、https://aegisub.org/docs/latest/ass_tags/ )。v0.3.0 白名单建议:Fontname(受控字体集)/Fontsize/PrimaryColour/OutlineColour+Outline/Shadow/Alignment/MarginV——正好是预览侧 canvas 能 1:1 复现的子集。
- **预览**:字幕轨按 cue 时间轴用绝对定位元素 + 同一字体 webfont 渲染;样式参数与 ASS 编译器同一份 jsonb。字距/抗锯齿差异归入第二节的「不承诺像素级一致」。
- **字体**:镜像需打包中文字体文件(libass 经 fontconfig 或 `fontsdir` 发现,一手:https://ffmpeg.org/ffmpeg-filters.html#drawtext 字体段);**字体商用授权待法务确认**(候选:思源黑体 OFL——授权条款未本次核实,第九节单列)。

---

## 六、导出与门禁接入

**原则:成片必须走与素材同一道门,不开后门。**

现状(代码事实):交付门禁 = `buildGatedManifest` 逐 shot 检查「有已持久化视频主版本 + 审核放行」(`src/modules/delivery/service.ts:99-146`);放行谓词 `isMediaReviewCleared`(`accepted` 直接过,`needs_review` 仅项目策略 `automatic` 时视同过,`src/modules/reviews/mediaPolicy.ts:41-47`)是 set-primary 与 delivery 共用的唯一谓词;交付留痕 `delivery_records`(manifest_hash/media_result_ids/partial/缺失清单/操作人,迁移 019)。

接入点(草案,四处):

1. **产物登记**:render 任务产物落 `media_results`(episode 级,`shot_id=NULL`,`origin_kind='render'` 待小迁移,`media_kind='video'`)。`review_status` 按项目策略走 `initialMediaReviewStatus`——`automatic` 项目自动过(记 `auto_accepted` 留痕,019 已有机制),`pending_review` 项目必须人审。**与素材完全同一套状态机与留痕。**
2. **门禁谓词不动**:成片放行仍由 `isMediaReviewCleared` 判定;`media_review_actions` 照常留痕。审核 UI 复用 `MediaReviewService.decide`(批量、reject 必填理由,`src/modules/reviews/mediaService.ts:17-49`)。
3. **manifest 扩 episode 级项**:现 manifest 逐 shot 列媒体(`src/modules/delivery/manifest.ts:38-46`);成片交付增加 episode 级 deliverable 项(或独立「成片交付」入口),校验 = 成片 `isMediaReviewCleared` + 成片所钉 `timeline_version` 的素材审计声明(哪些 shot 的主版本进了该版本,从文档 `media_result_id` 集可机械算出)。
4. **交付留痕**:`delivery_records` 增记 `timeline_version_id` + `state_sha256`(或存进既有 `media_result_ids` 旁的元数据),回答「交的哪版」。

**导出动作本身的红线**:导出按钮 = 人点一次创建一个 render 任务(estimate→confirm→submit),禁自动提交、禁批量扩张(AGENTS.md §4);渲染不涉外部扣费,失败后的有限次自动重试不碰付费红线,重试策略留合同裁定。预算检查复用 generation advisory lock 路径,超限 402;记账走 cost_entries 视图(复用 generation 链即自动覆盖,无需改 016 视图——记账口径标为决策点,第九节)。

---

## 七、技术选型与成本估算

### 7.1 FFmpeg 调用方式:服务端子进程(推荐)

| 方案 | 结论 | 依据 |
| --- | --- | --- |
| **服务端 spawn ffmpeg** | ✅ 推荐 | 镜像内置静态构建(`--enable-libass --enable-libfontconfig --enable-libfreetype`,x264 另议);与 generation worker 同进程领任务、子进程执行,CPU 受限子进程隔离;Clypra 导出同形(spawn + stdin/filter graph,`export.rs`) |
| ffmpeg.wasm | ❌ 排除(成片) | 官方自述:比原生慢一个数量级、mt 仅 ~2×、2GB 输入上限、experimental、mt 需 COOP/COEP 全站隔离(https://ffmpegwasm.netlify.app/docs/faq ) |
| 云转码(MediaConvert/Transcoder/Shotstack) | 不采,留作峰值备案 | 价格见 7.4,比自渲染高 1-2 个数量级;数据出域;新供应商。其价值是零运维弹性,v0.3.0 单集 2-3 分钟的负载用不到 |

进程形态:v0.3.0 渲染与 API 同 Pod(generation worker 先例),ffmpeg 子进程 `nice` + CPU 限额防拖垮 API;将来负载上来可把渲染 worker 拆到独立节点组——**同一代码库,只是部署形态**,不违反「不拆第二套在线运行时」。

### 7.2 浏览器侧解码

- **demux:mediabunny**(MPL-2.0,可闭源商用;纯 TS 零依赖;`UrlSource` range 懒加载 + 智能预取;直出 `VideoDecoderConfig` 接 WebCodecs;周下载 ~155 万,活跃迭代,一手:https://github.com/Vanilagy/mediabunny 、https://mediabunny.dev/guide/reading-media-files 、npm API 快照 2026-07-18~24)。备选 mp4box.js(BSD-3,资历老但仅 ISO BMFF、range 调度要自建,https://github.com/gpac/mp4box.js )。
- **解码:WebCodecs**。支持面(caniuse 2026-07-26):Chrome/Edge 94+、Firefox 130+、Safari 16.4 部分/26.0 完整。规范明示不保证任何 codec 配置,必须运行时 `isConfigSupported()` 探测;codec 字符串注册表含 avc1/hev1/vp09/av01(一手:https://w3c.github.io/webcodecs/codec_registry.html )。**必须做能力探测 + 降级**:不支持 WebCodecs 或 codec 时,降级为 `<video>` 元素逐 clip 播放(无转场预览,转场以图标标示)——B 端内部工具可要求 Chrome/Edge,降级路径保底。
- **合成:canvas 2D 起步,白名单转场用 WebGL2**;WebGPU 仅作增强(Firefox 默认未开,caniuse 2026-07-26)。
- **不引 Remotion**:其「React 组件即画面」适合程序化动画;我们的画面主体是已生成的视频素材,拼接/叠字幕是 FFmpeg 主场;且 Remotion 服务端渲染引入 Chromium 层与企业商用许可(Cloud Rendering Units)。借鉴其单一真源思想,不引运行时(一手:https://www.remotion.dev/docs/lambda )。

### 7.3 渲染 CPU 估算(算法与假设全列)

**假设**:成片竖屏 1080×1920(像素数=1080p),30fps,CRF23;每分钟 = 30×60 = **1800 帧**。
**锚点(唯一一手实测,2026-07-26)**:Apple M4 Pro 14 核 arm64,FFmpeg 7.1,testsrc2 1080p30 单文件:x264 veryfast ≈ 540fps、medium ≈ 270fps;x265 medium ≈ 96fps。**云 x86 vCPU 未实测,保守按 1/2~1/3 折算**(待复测,第九节)。

算式:`编码耗时/分钟成片 = 1800 ÷ 实测fps`;`总渲染耗时 ≈ 编码耗时 × (1 + 滤镜开销系数)`(xfade/overlay/subtitles 估 0.2-0.5);源解码与编码流水线重叠,不单列。

| 预设 | M4 Pro 实测 | 折算云 vCPU(×1/2~1/3) | 每分钟成片耗时(含滤镜系数 1.35) |
| --- | --- | --- | --- |
| x264 veryfast | 3.3s | 7-10s | **约 10-14s** |
| x264 medium | 6.7s | 13-20s | **约 18-27s** |
| x265 medium | 18.8s | 38-56s | 约 51-76s(v0.3.0 不用) |

**结论:每分钟 1080p 成片约 10-30 秒 CPU 时间;一集 2-3 分钟成片渲染 0.5-1.5 分钟**——异步任务完全可接受,v0.3.0 不需要 GPU 实例。GPU(NVENC)仅作将来 4K/批量的备案:数据中心卡 L4/A10 等 NVENC 并发不受限、A100 无 NVENC(一手:NVIDIA 支持矩阵,https://developer.nvidia.com/video-encode-and-decode-gpu-support-matrix-new );火山可租规格待验证。

### 7.4 存储与带宽估算(算法与假设全列)

**成片存储**:假设码率 6 Mbps(1080p30 H.264 CRF23 短剧内容经验区间 4-8 Mbps,取中值——**经验假设,非实测**)。每分钟 = 6×60÷8 = **45 MB/分钟**;一集 2.5 分钟 ≈ **113 MB**。
**缩略图金字塔**:High 档 0.2s 一帧 → 300 帧/分钟,320×180 有损 WebP ≈ 8KB → ≈ 2.4 MB/分钟;加 Low/Medium 档 ≈ **3 MB/分钟素材**(atlas 只减文件数不减字节)。
**时间线/字幕 jsonb**:KB 级,忽略。
**带宽**:上传=TOS 内网(火山内网流量费待验证);下载/播放 = 45 MB/分钟×次数;预览 scrub 走源素材 range,正常编辑只触达片段窗口,按素材量的 10-30% 估(**经验假设**)。

**成本对照表(均一手官方定价页,2026-07-26):**

| 项 | 价格 | 来源 |
| --- | --- | --- |
| AWS MediaConvert Basic,1080p≤30fps AVC | $0.015/输出分钟(前 10 万归一化分钟档;HD=2×$0.0075) | https://aws.amazon.com/mediaconvert/pricing/ |
| Google Transcoder,HD | $0.030/输出分钟 | https://cloud.google.com/transcoder/pricing |
| Shotstack PAYG | $0.30/分钟(≤1080p;订阅折 $0.20) | https://shotstack.io/pricing/ |
| 自渲染(CPU) | **估 $0.001-0.01/分钟** | 算法:每分钟成片墙钟 10-30s(7.3),x264 多线程按占满 4-8 vCPU 计 → **1-3 vCPU·分钟/分钟成片**;vCPU 小时价按 $0.03-0.06 占位(**火山 ECS 价格待验证**)→ $0.0005-0.003/分钟,加 IO/存储余量取 $0.001-0.01/分钟;即 1 vCPU·h 约摊 20-60 分钟成片 |

自渲染比云服务低 1-2 个数量级,且源素材不出域;方向性结论对 vCPU 价格假设不敏感(假设错 3 倍结论不变)。**火山 TOS 存储/流量、CDN、ECS 单价全部待验证**(官方定价页为 JS 壳,静态抓取无数字,入口 https://www.volcengine.com/pricing )——月成本公式备好:存储 GB×单价 + 流出 GB×单价 + 渲染 vCPU·h×单价,价格一到即可代入。

### 7.5 编解码与许可注意点

- **H.264 内容侧**:Via LA(AVC 专利池)Title-by-Title ≤12 分钟 $0.00(一手:https://www.via-la.com/licensing-2/avc-h-264/ )——短剧单集 1-3 分钟大概率落在免费档;订阅制流媒体另有大额年费档。**是否适用于我们的交付模式,法务确认**(第九节)。
- **libx264 是 GPL**:FFmpeg 官方 legal 页点名(https://ffmpeg.org/legal.html )。服务端内部调用、不向用户分发二进制,一般不构成分发;但我们分发**容器镜像**给客户/部署方时镜像内含 libx264——镜像分发的定性**法务确认**。备案:改链 OpenH264(BSD)或仅服务端保镜像不分发。
- **HEVC**:费率(Access Advance/Via LA/Velos 三池)未核实;v0.3.0 不出 HEVC,规避整个问题。

---

## 八、分期建议

### v0.3.0 做到(MVS,全部落在本调研已验证的部件上)

1. 时间线工作台:单视频轨 + 单字幕轨(+ 视频自带音轨),裁剪/排序/删除/时长调整;「上时间线」一键初始化(人点)。
2. 转场:xfade 白名单 5-8 种(fade/dissolve/wipe 方向系/fadeblack/fadewhite),轨内相邻 clip 间。
3. 字幕:三来源(a 若 schema 验证通过 / b 文案行继承 / c 手动),白名单样式,预览 + 服务端烧录。
4. 草稿自动保存 + 显式版本;command 模式 undo/redo(前端内存)。
5. 导出:estimate→confirm→异步 render(复用 generation 生命周期),成片入 `media_results`,过审走既有交付门禁。
6. 性能:服务端缩略图金字塔 + atlas 预生成;WebCodecs 预览(前向窗口解码、解码器池预热、range 预取);`<video>` 降级路径。
7. 一致性验收:渲染后自动抽帧比对(预览 vs 成片,阈值告警不阻断)。

### 留到之后(及门槛)

| 项 | 为什么不留到 v0.3.0 | 启动门槛 |
| --- | --- | --- |
| 多视频轨/画中画/Gap | 合成与一致性白名单都要扩 | MVS 稳定后 |
| 关键帧动画/变换/滤镜 | 预览-FFmpeg 参数对齐成本陡增 | 逐效果单独验收 |
| ASR 自动字幕 | 供应商与成本未调研 | 实拍素材占比上来 |
| 精确音画对轨(TTS 字级时间戳驱动) | 依赖声音工坊产物验证 | TTS 字幕 JSON schema 验证后 |
| OTIO/EDL 互导 | 与专业软件互换的需求未证实 | 有真实客户案例 |
| WebGPU 合成、4K/HEVC 导出、GPU 渲染 | 负载未到 | 渲染队列积压证据 |
| 协作编辑(多人同时间线) | 草稿锁模型先跑稳 | RBAC(v0.3.0 另一卡)做完后 |

---

## 九、事实与推断分列;未验证项单列

### 9.1 事实(可引用,均一手)

**代码库**(本仓,2026-07-26 核):
- 交付止步于 manifest:`buildPlaybackList` = 过滤 video 按 `shotSortOrder` 排序的 URL 清单(`src/modules/delivery/manifest.ts:73-77`);门禁 `buildGatedManifest`(`service.ts:99-146`);唯一放行谓词 `isMediaReviewCleared`(`reviews/mediaPolicy.ts:41-47`)。
- generation 生命周期:status `pending|running|succeeded|failed|cancelled`,phase `created|submitting|provider_queued|provider_running|provider_succeeded|persisting|complete`(`modules/generation/types.ts:3-17`);worker 进程内轮询 + `FOR UPDATE SKIP LOCKED` 租约(`repository.ts:748-774`);幂等键/预算锁/报价 TTL 见迁移 001 与 `service.ts`。
- `media_results.shot_id` 可空、`request_id/attempt_id` NOT NULL(001:410-412);`origin_kind` CHECK `('generation','asset_media')`(012);`media_kind` CHECK 020 已扩七处含 `audio`。
- 剧本文案行无时间轴:`ScriptLine{lineIndex,text}`(`script-breakdown/lines.ts:13-19`);TTS 字幕 JSON 字级时间戳落库是合同条款(`sound-workshop.md` L37-42)。
- 全仓无任何 ffmpeg/timeline/subtitle 代码(grep 零命中,node_modules 除外)。
- EDIT 先例:「EDIT 是一种生成任务,不是新流程」(`v0.3.0/edit-submission-and-storage.md` L3-4)。

**Clypra**(源码 master `9837963`,2026-07-26):四项性能技术代码级存在,机制与参数见第四节各 permalink;持久化是 JSON 文件非 SQLite;导出两条路径;「90%/70%/5-10ms」无基准;README 与实现系统性出入(已逐条标注)。

**浏览器/API**(均 2026-07-26):WebCodecs 支持矩阵与 `isConfigSupported` 要求(w3c.github.io/webcodecs、caniuse);mediabunny/mp4box.js 能力与许可(GitHub/npm);ffmpeg.wasm 官方限制(FAQ);MSE 单播放线模型(MDN);OffscreenCanvas/WebGPU 支持面(caniuse);Shotstack JSON 真源与 Remotion 模型(官方文档);OTIO 数据模型(readthedocs)。

**FFmpeg/价格**(均 2026-07-26):concat demuxer「same streams」约束与 inpoint/outpoint 非帧精确;concat filter「segments must start at 0」;xfade 自 FFmpeg 4.3、CFR/同分辨率约束、offset/duration 语义;`-ss` 转码默认帧精确;subtitles 依赖 libass;x264 预设 M4 Pro 实测表;MediaConvert/Transcoder/Shotstack/Lambda 官方定价;Via LA AVC ≤12 分钟免费档;FFmpeg legal 页对 libx264 的 GPL 点名。

### 9.2 推断(可反驳)

- 「一致性承诺收窄到布局/时间/内容三层 + 白名单 + 抽帧比对」是本调研的方案设计,业界无现成标准答案。
- 「渲染复用 generation 生命周期」两条硬约束(结构 NOT NULL、EDIT 合同先例)是事实,但「复用」本身仍是 Fable 待裁定的架构决策;备选(放宽 media_results 两列零约束 + 独立 render 表)代价更高,不推荐。
- 成本数字:M4 Pro→云 vCPU 的 1/2~1/3 折算、6 Mbps 码率、10-30% 预览流量、vCPU 小时占位价,全是假设;方向性结论(自渲染便宜 1-2 个数量级、异步可接受)对假设不敏感。
- 「每集一条时间线、草稿 jsonb 整存」的数据模型是草案;结构化行方案被否的理由(高频写 + undo 映射)是工程判断。
- Clypra 起始参数(80px/缩略图阈值、2s 前向窗口、100 级 undo、500ms 合并)是借鉴起点,不是验证过的最优值。

### 9.3 未验证项(动手前须清,按阻塞度排序)

| # | 项 | 影响 | 验证路径 |
| --- | --- | --- | --- |
| 1 | **TTS 字幕 JSON 实际 schema**(声音工坊产物是否已落库、字段形状) | 字幕来源 (a) 成立与否 | 查 v0.2.0 声音工坊实现与一条真实 audio 产物 |
| 2 | **云 x86 机型 x264/x265 实测**(含 xfade/subtitles 滤镜负载) | 成本与渲染时长口径 | 目标 VKE/ECS 机型跑 benchmark |
| 3 | **火山 TOS 存储/流量、CDN、ECS/VCI 单价** | 月成本公式代入 | 控制台价格计算器(https://www.volcengine.com/pricing 为 JS 壳) |
| 4 | **Safari 16.4-25 / Firefox 130+ WebCodecs 剪辑负载稳定性** | 降级路径触发面 | 真机自测;MDN compat 子接口缺口本次未取得 |
| 5 | **H.264 内容侧许可适用性 + libx264 镜像分发定性 + 中文字体商用授权** | 合规 | 法务;HEVC 已用「不出」规避 |
| 6 | ASS override tags 全文(Aegisub 手册页本次未逐字抓取) | 字幕白名单边界 | https://aegisub.org/docs/latest/ass_tags/ |
| 7 | WebCodecs 首帧延迟/解码器池容量基准 | 预览性能预算 | 自测(Clypra 数字为桌面注释自述,不可移植) |
| 8 | w3.org TR 页(WebCodecs/media-source-2)正式级别 | 引用严谨性 | 本次 403,用 Editor's Draft 已足 |
| 9 | 渲染记账口径:CPU 成本以「积分」计还是仅记录入 cost_entries | 运营口径 | Fable 决策点,不阻塞调研 |

---

**S28-DONE**

---

## 十、Fable 裁决(2026-07-26)

调研把该问的都问清楚了,以下三条从「草案」升为「合同」,落代码按这个来。

### 10.1 渲染复用 generation 生命周期 —— 采纳

成片渲染**复用现有 generation 任务生命周期**(status/phase 状态机、worker
`FOR UPDATE SKIP LOCKED` 租约、幂等键、预算锁、报价 TTL),不另起一套。

理由:已有先例且是明确合同——「EDIT 是一种生成任务,不是新流程」
(`docs/contracts/v0.3.0/edit-submission-and-storage.md`)。渲染同理:它是
一次有输入、有成本、可能失败、需要重试和审计的异步任务,和生成任务是同一类东西。
另起一套意味着状态机、租约、幂等、记账全部再写一遍,还要在两套之间做对账。

调研提的备选(放宽 `media_results` 两列 NOT NULL + 独立 render 表)否决:
放宽约束是不可逆的结构性让步,为了一个可以复用的东西去松已有的完整性保证,代价与
收益不成比例。

**实现约束**:成片作为 `media_results` 的一员,必须有 `request_id`/`attempt_id`
——也就是说渲染必须先建一个 generation request。这不是负担,这正是"可重跑、可审计"
的载体。

### 10.2 渲染成本记账 —— 记 cost_entries,不计积分

服务端 CPU 渲染成本**只记录进 `cost_entries` 做成本归集**,**不计入用户可见的
积分扣减**。

理由:积分是对用户的价格承诺,和外部模型调用一一对应,用户能预期。渲染是我们自己
的机器成本,量级比模型调用低一到两个数量级(调研第七节),把它折进积分只会让报价
变得难解释,而且会诱使用户为省积分而少预览——那是反的。成本要算,但算给我们自己看。

**将来若渲染成本占比显著上升**(比如做了 4K 或长片),再单独议价,不在本档改。

### 10.3 一致性承诺 —— 采纳三层收窄

「预览画面 ≠ 最终成片」是这条流程最大的风险,调研的对策正确:不承诺像素级一致,
只承诺**布局一致、时间一致、内容一致**,并用效果白名单 + 时间戳基准 + 渲染后自动
抽帧比对把风险锁在白名单内。

**白名单是硬约束**:预览合成器实现不了的效果,不许出现在时间线上。宁可少一个转场,
不要一个"预览好看导出崩了"的效果。

## 十一、未验证项的处置

| # | 项 | 处置 |
| --- | --- | --- |
| 1 | TTS 字幕 JSON 实际 schema | **已查,结论是不成立**:声音工坊一期**尚未实现**(无对应模块,`src/` 无 `'audio'` 使用),库里没有 audio 产物。合同与迁移 020 的取值准备都在,但字幕来源 (a) 要等实现。**v0.3.0 字幕能力依赖声音工坊一期,已在版本计划里标明这条依赖。** |
| 2 | 云机型 x264/x265 实测 | 动手前必须做,排进 v0.3.0 启动第一周 |
| 3 | 火山 TOS/ECS 价格 | 我从控制台取,不阻塞设计 |
| 4 | Safari/Firefox WebCodecs 稳定性 | 真机自测,决定降级路径触发面 |
| 5 | H.264 许可 / 字体商用授权 | **走法务,不由工程判断**。HEVC 已用「不出」规避 |
| 6-8 | ASS tags 全文 / WebCodecs 基准 / w3c 页级别 | 实现期自清,不阻塞 |
| 9 | 渲染记账口径 | 见 10.2,已裁决 |
