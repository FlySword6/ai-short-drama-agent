"""评测数据的位置。

剧本正文是版权件,不进仓库——仓库里只留金标(带 sha256 与行号锚点)。
正文目录由 BREAKDOWN_EVAL_DATA_ROOT 指定,谁跑谁给,不在代码里写死某台机器的路径。
"""
import os
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parents[3]
GOLD_DIR = REPO_DIR / "eval" / "breakdown" / "gold"


def data_root() -> Path:
    value = os.environ.get("BREAKDOWN_EVAL_DATA_ROOT")
    if not value:
        raise SystemExit(
            "没给剧本正文目录。正文是版权件不进仓库,请设 BREAKDOWN_EVAL_DATA_ROOT 指向 breakdown-eval 目录。"
        )
    path = Path(value).expanduser()
    if not path.is_dir():
        raise SystemExit(f"BREAKDOWN_EVAL_DATA_ROOT 指向的目录不存在:{path}")
    return path


def source_file(env_name: str) -> Path:
    value = os.environ.get(env_name)
    if not value:
        raise SystemExit(f"没给原始剧本文件。请设 {env_name} 指向源文件。")
    path = Path(value).expanduser()
    if not path.is_file():
        raise SystemExit(f"{env_name} 指向的文件不存在:{path}")
    return path
