# 抽卡工作台

抽卡师用 `reference-test` 调试生成策略。测试的 `mode` 可以是直接引用参考媒体（`direct_reference`），也可以是素材转提示词（`material_to_prompt`）；每条测试带 `media_kind`（`image` 或 `video`）和 `model_key`——注意是 `model_key`，服务端 `referenceTestBody` 是 strict schema，写成 `model_id` 或其它未定义字段会直接被拒；`--payload` 里只放 `prompt`、`parameters`、`reference_media_ids` 这三个可选键。CLI 不解释模型参数，也不本地推理。

## 完整动线

1. 先用 `project list` 确认项目；用 `reference-test list --project-id ...` 阅读现有测试，避免重复建卡。
2. 建测试前先从 `generation models` 的服务端返回选择受支持的 `model_key`；随后按 `reference-test create --help` 提供项目、名称、媒体类型、模式、模型键和可选 payload。四个业务字段一个不能少；这条命令不接受 `--client-idempotency-key`（strict schema 遇未知字段是 400）。
   同一测试需要调提示词、模型、参数或参考媒体时，按 `reference-test update --help` 提供同一组完整字段和乐观锁版本，不要重建测试。服务端是 PUT 整体替换不是局部更新，所以四个业务字段每次都要给全；该版本来自 `reference-test get --project-id ... --reference-test-id ...` 返回的 `version`。
3. 每次抽卡必须依次执行：
   - `generation estimate --payload ...`（抽卡工作台没有自己的估价接口）；
   - 向用户展示报价并等待人工审阅；
   - 用户明确同意后，执行 `generation confirm --quote-id ...`；
   - 再执行 `generation submit --payload ...`。提交成功仅表示已创建异步生成，记下返回的 generation request id。
   - **随即用 `queue status --generation-id ...` 轮询这个请求直到完成**，从返回里取出媒体产物的 `media_result_id`。这步不能省也不能拖：`queue list` 只打在途任务，一旦生成完成、ID 丢了就找不回来了。
   - 拿到产物后用 `reference-test result-attach --project-id ... --reference-test-id ... --generation-request-id ... --media-result-id ...` 挂进这个测试。

   不存在 `--yes`、自动确认、自动提交或一键跑批。结果仍由服务端关联生成请求和媒体产物。
4. 用 `reference-test result-list --project-id ... --reference-test-id ... [--page N --page-size N]` 横向比较同一测试的历次结果；用 `reference-test result-stream --project-id ... [--media-kind image|video --page N --page-size N]` 查看整个项目、包括其他抽卡师的结果流——结果超过服务端默认页长时靠 `--page` 翻页，否则永远只能看到第一页。选择前向用户复述测试、结果、关联媒体和采用动作。
5. 用户挑中结果后，执行 `reference-test set-default --project-id ... --reference-test-id ... --result-id ... --expected-version ...`，把这一结果的策略定为项目默认。**这里的 `--expected-version` 是默认策略记录的乐观锁版本**（首次设置传 `0`），和第 2 步参考测试记录的 version 是两份不同数据，不要从 `reference-test get` 抄过来。
   默认策略挂在 `/generation-defaults`（独立后端模块，按 `media_kind` 分开存），所以回读和直接维护都在 generation 组：先用 `generation default-get --project-id ...` 回读，再按 `generation default-update --help` 提供媒体类型、模式、服务端模型目录里的模型键、默认策略记录版本和可选参数；参数字段不是 payload。

删除前必须确认不再需要该测试：`reference-test delete --project-id ... --reference-test-id ... --expected-version ...`，这里的 `--expected-version` 同样是参考测试记录自己的 version。
