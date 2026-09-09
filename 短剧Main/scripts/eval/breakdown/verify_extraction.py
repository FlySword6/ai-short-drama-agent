#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "pdfplumber==0.11.7",
#     "python-docx==1.2.0",
# ]
# ///
"""证明 extract_episodes.py 既没丢字也没造字。

单纯眼看几段不算验过。这里做的是全量往返比对:把源文件按同一套规则抽出的
「所有可见非空白字符」,和切集后各集正文里的「所有可见非空白字符」逐字符对齐,
差一个就报出上下文。空白不参与比对——折行合并本来就会改空白。

允许被丢弃的东西只有这几类,写死在下面,新增一类必须改代码:
  idb   页码行、集标记行、场次编号、分页续接标记 (MORE)、水印 FlareFlow
  bdlw  文档标题、集标记行
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import docx  # noqa: E402
from extract_episodes import (  # noqa: E402
    EPISODE_MARKER_RE,
    PAGE_NUMBER_RE,
    PDF_TRANSITION_MIN_INDENT,
    SCENE_NUMBERED_RE,
    normalize_inline,
    parse_docx,
    parse_pdf,
    pdf_lines,
)

from paths import source_file

PDF = source_file("BREAKDOWN_EVAL_SOURCE_IDB")
DOCX = source_file("BREAKDOWN_EVAL_SOURCE_BDLW")


def squash(text: str) -> str:
    return re.sub(r"\s+", "", text)


def source_chars_pdf() -> str:
    parts = []
    for indent, raw, _ in pdf_lines(PDF):
        text = normalize_inline(raw)
        if indent >= PDF_TRANSITION_MIN_INDENT and PAGE_NUMBER_RE.match(text):
            continue
        if indent == 12 and EPISODE_MARKER_RE.match(text):
            continue
        if indent == 35 and text == "(MORE)":
            continue
        if indent == 7:
            match = SCENE_NUMBERED_RE.match(text)
            if match and match.group(1) == match.group(3):
                text = match.group(2)
        parts.append(text)
    return squash("".join(parts))


def source_chars_docx() -> str:
    parts = []
    for paragraph in docx.Document(str(DOCX)).paragraphs:
        text = normalize_inline(paragraph.text)
        if not text:
            continue
        if paragraph.style.name == "Title":
            continue
        if paragraph.style.name.startswith("Heading") and EPISODE_MARKER_RE.match(text):
            continue
        parts.append(text)
    return squash("".join(parts))


def parsed_chars(episodes) -> str:
    return squash("".join(e.text for ep in episodes for e in ep.elements))


def compare(label: str, want: str, got: str) -> bool:
    if want == got:
        print(f"  {label}: OK  {len(want)} 个可见字符逐字对齐")
        return True
    limit = min(len(want), len(got))
    at = next((i for i in range(limit) if want[i] != got[i]), limit)
    print(f"  {label}: FAIL  源 {len(want)} / 切出 {len(got)},首个分歧在第 {at} 字符")
    print(f"    源  …{want[max(0, at - 60):at + 60]}…")
    print(f"    切  …{got[max(0, at - 60):at + 60]}…")
    return False


def main() -> int:
    ok = True
    print("往返完整性(源可见字符 == 各集正文可见字符):")
    ok &= compare("idb ", source_chars_pdf(), parsed_chars(parse_pdf(PDF)))
    ok &= compare("bdlw", source_chars_docx(), parsed_chars(parse_docx(DOCX)))

    print("水印残留:")
    body = "".join(
        e.text for ep in parse_pdf(PDF) for e in ep.elements
    )
    hits = body.count("FlareFlow") + body.count("Flare Flow")
    print(f"  idb : 'FlareFlow' 命中 {hits} 次" + ("" if hits == 0 else "  ← 没洗干净"))
    ok &= hits == 0
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
