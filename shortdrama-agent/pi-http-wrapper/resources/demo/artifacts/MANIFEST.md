# 生产流程产物清单（The Exiled She-Wolf 被驱逐的狼女）

项目: b56af6b1-7720-4705-a33b-32dcc1d9a968 | 剧本: a73f249a-0f28-44cb-b236-bea9369fec1f

| 步骤 | 环节 | 命令 | 产物 | 生产路径 |
|---|---|---|---|---|
| 1 | 建项目 | project create | project_id=b56af6b1-... | 云端 Main API；本地脚本 scripts/episode-001.md |
| 2 | 剧本导入+拆解 | script analyze / breakdown-assets | script_id=a73f249a-...；2角色2场景2道具3分镜 | 云端（deepseek-v3.2）；本地 artifacts/step2-*.json |
| 3 | 查模型 | model search | image: Seedream 5.0 Pro/Lite；video: Seedance 2.0/Lite；audio: 无 | 云端 /models |
| 4 | 生图 | create image x3 | 3 张分镜图 URL（resultTosUrl） | 云端 TOS；本地 images/shot1-3.jpg |
| 5 | 生视频 | create video | 任务 be54d573-... 失败（安全校验拒绝"可能含真人"） | 云端 provider 侧失败，无产物 |
| 6 | TTS | create audio | 未执行：服务端无启用 audio 模型 | — |

URL 清单: artifacts/step5-image-urls.json
