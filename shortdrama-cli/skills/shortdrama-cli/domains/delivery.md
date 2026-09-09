# 交付

先 `delivery manifest --episode-id ID` 查看交付清单；实际导出后使用 `delivery record --episode-id ID` 留下交付事实，再用 `delivery history --episode-id ID` 查交付记录。媒体下载使用 `delivery download --media-id ID --output PATH`，CSV 使用 `delivery csv --episode-id ID --output PATH`。文件成功写入不等于已经人工验收。
