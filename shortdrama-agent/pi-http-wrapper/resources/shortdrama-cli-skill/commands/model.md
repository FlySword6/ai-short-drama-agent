# 模型查询与 Schema

`model` 命令只读取业务服务端暴露的模型列表与 tool spec 数据，用于选择模型和查看
生成参数 Schema。`model search` 通过 `/models` 按展示名和模型类型查询；
`model get` 再读取 supportModels 与 tool spec 解析完整 Schema。不要用 CLI 直连模型厂商、
AgentKit、数据库或第三方 SDK。

## 检索候选模型

按关键词检索模型名或模型 key；默认输出 JSON，便于后续自动化读取 `matches[]`：

```bash
shortdrama-cli model search qwen \
  --json
```

限定模型类型时使用 `--type`。

```bash
shortdrama-cli model search --type image qwen --json
shortdrama-cli model search --type video --json
shortdrama-cli model search --type audio --json
```

`--type` 只接受 `text`、`image`、`video`、`audio`。不要使用 `script`、`storyboard`
或 `custom`。

输出中的 `modelName` 来自服务端 `/models` 返回项的 `displayName`。生成和编辑命令的
`--model` 优先填这个 `modelName`，不要优先填 `model` 标识。

## 获取完整 Schema

用户已确认具体模型，或需要查看模型参数、默认值、可选枚举、规则和 modeType 时，使用：

```bash
shortdrama-cli model get MODEL \
  --json
```

模型展示名含空格时可以作为一个参数传入；自动化流程给生成或编辑命令传 `--model`
时，应优先使用 `modelName`。

```bash
shortdrama-cli model get "Seedance 2.0 VIP" --json
```

常用字段：

```bash
shortdrama-cli model get MODEL --json | jq '.schema.properties'
shortdrama-cli model get MODEL --json | jq '.schema.config.settings'
shortdrama-cli model get MODEL --json | jq '.schema.rules'
shortdrama-cli model get MODEL --json | jq '.schema.properties.modeType.items'
```

## 编排规则

先 `model search`，再让用户确认模型；确认后使用 `model get` 查看 Schema。不要根据模型名
自行猜测支持的参数、输入模态或连线数量。

`schema.properties` 用于参数控件和默认值；`schema.config.settings` 与
`schema.config.advancedSettings` 用于设置区展示；`schema.rules` 用于判断是否允许生成；
`schema.properties.modeType.items` 用于判断当前输入模态下的媒体数量上下限。

`rules: []` 表示显式无约束；缺少 `rules` 字段才表示客户端可按生成器类型套用默认规则。

如果 `model get` 因模型名匹配多个 `model` 失败，回到 `model search` 展示候选项，并请用户
选择唯一 `model`。

## 边界

`model` 命令只做查询，不提交生成任务。真正创建图片、视频或音频任务仍走
`create image`、`create video`、`create audio`。

不要把 `model search` 的候选结果当作模型可用性最终承诺；提交生成前仍以业务服务端创建任务
返回为准。
