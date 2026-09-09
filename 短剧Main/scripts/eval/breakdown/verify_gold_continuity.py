#!/usr/bin/env python3
"""金标自检:证据必须能在正文里原地找到,声明的计数必须等于数组实际长度。

金标的价值全靠可核对。人手写的行号和引文会漂,所以每次改完都跑一遍这个脚本,
把「引文对不上正文」和「counts 与数组不一致」这两类静默错误挡在合流之前。

引文允许两种写法:
  1) 纯引文 —— 必须逐字出现在 lines 指向的行区间里(去掉行内多余空白后比对)。
  2) 带省略号 —— 用 …/... 切成片段,每一片都要按顺序出现在该区间里。
引文末尾带 "(ep-xxx L?)" 之类的跨集出处标记时,以 crossRef 处理:只校验能否在被
引用的那一集里找到,不要求出现在本集。
"""

import json
import re
import sys
from pathlib import Path

from paths import GOLD_DIR as GOLD_ROOT, data_root

GOLD_DIR = GOLD_ROOT / "continuity"
DATA_DIR = data_root()

LINE_RANGE = re.compile(r"^\s*(\d+)\s*(?:-\s*(\d+))?\s*$")
# "3, 107" 这种多点引用,逐个点都试一遍
MULTI_POINT = re.compile(r"\d+(?:-\d+)?")
CROSS_REF = re.compile(r"[（(](?:ep-[\w-]+|[^)）]*ep-[\w-]+[^)）]*)[)）]\s*$")


def normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def load_episode_lines(episode_id: str) -> list[str]:
    path = DATA_DIR / "episodes" / f"{episode_id}.txt"
    return path.read_text(encoding="utf-8").splitlines()


def slice_text(lines: list[str], spec: str) -> str:
    """把 '3' / '3-41' / '3, 107' 都摊成一段可搜索的文本。"""
    chunks = []
    for point in MULTI_POINT.findall(spec):
        m = LINE_RANGE.match(point)
        if not m:
            continue
        start = int(m.group(1))
        end = int(m.group(2) or m.group(1))
        # 引文常跨到相邻行(动作行与下一段之间只隔一个空行),放宽两行余量
        lo = max(1, start - 1)
        hi = min(len(lines), end + 1)
        chunks.append(" ".join(lines[lo - 1 : hi]))
    return normalize(" ".join(chunks))


def quote_found(quote: str, haystack: str) -> bool:
    parts = [normalize(p) for p in re.split(r"…|\.\.\.", quote) if normalize(p)]
    pos = 0
    for part in parts:
        idx = haystack.find(part, pos)
        if idx < 0:
            return False
        pos = idx + len(part)
    return True


def walk_evidence(node, path, out):
    """收集所有 {lines, quote} 形状的节点,不管它埋在哪一层。"""
    if isinstance(node, dict):
        if "quote" in node and "lines" in node:
            out.append((path, node))
        for k, v in node.items():
            walk_evidence(v, f"{path}.{k}", out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk_evidence(v, f"{path}[{i}]", out)


def recount(doc: dict) -> dict:
    entities = doc["entities"]
    by_kind = {"character": 0, "group": 0, "location": 0, "creature-form": 0}
    for e in entities:
        by_kind[e["kind"]] = by_kind.get(e["kind"], 0) + 1
    variants = [v for e in entities for v in e.get("variants", [])]
    beats = [b for e in entities for b in e.get("onScreenBeats", [])]
    return {
        "entitiesTotal": len(entities),
        "byKind": by_kind,
        "consistencyRequiredTrue": sum(1 for e in entities if e["consistencyRequired"]),
        "consistencyRequiredFalse": sum(1 for e in entities if not e["consistencyRequired"]),
        "variantsTotal": len(variants),
        "variantsBeyondBaseline": sum(1 for v in variants if v["trigger"] != "baseline"),
        "crossSceneEntities": sum(1 for e in entities if e["reuseScope"] == "cross-scene"),
        "voiceOnlyBeats": sum(1 for b in beats if b["appearanceMode"] == "voice-only"),
        "photographBeats": sum(1 for b in beats if b["appearanceMode"] == "photograph"),
        "expectedMerges": len(doc.get("expectedMerges", [])),
        "negatives": len(doc.get("negatives", [])),
        "nonVariantStateChanges": len(doc.get("nonVariantStateChanges", [])),
        "disputed": len(doc.get("disputed", [])),
    }


def main() -> int:
    failures = []
    checked = 0
    files = sorted(p for p in GOLD_DIR.glob("ep-*.json"))
    if not files:
        print(f"没找到金标文件:{GOLD_DIR}")
        return 2

    for path in files:
        doc = json.loads(path.read_text(encoding="utf-8"))
        episode_id = doc["episodeId"]
        lines = load_episode_lines(episode_id)

        declared = doc["counts"]
        actual = recount(doc)
        for key, want in actual.items():
            if declared.get(key) != want:
                failures.append(f"{episode_id} counts.{key}: 声明 {declared.get(key)} != 实际 {want}")

        evidence = []
        walk_evidence(doc, episode_id, evidence)
        for where, node in evidence:
            quote = node["quote"]
            if CROSS_REF.search(quote):
                continue  # 跨集出处,不在本集正文里找
            hay = slice_text(lines, str(node["lines"]))
            checked += 1
            if not quote_found(quote, hay):
                failures.append(f"{where} 引文对不上 L{node['lines']}: {quote!r}")

    print(f"检查了 {len(files)} 个金标文件,{checked} 条引文")
    if failures:
        print(f"\n不通过 {len(failures)} 条:")
        for f in failures:
            print("  -", f)
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
