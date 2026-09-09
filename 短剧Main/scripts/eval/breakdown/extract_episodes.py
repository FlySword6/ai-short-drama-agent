#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "pdfplumber==0.11.7",
#     "python-docx==1.2.0",
# ]
# ///
"""拆解评测基准 · 取材段:把两部真实剧本切成逐集正文 + 确定性事实。

整段不问模型。所有输出都由源文件的版式几何算出来,同一份输入重跑必须逐字节相同。

────────────────────────────────────────────────────────────────────────
一、为什么用这两个库
────────────────────────────────────────────────────────────────────────
pdfplumber  PDF 正文压着一层 45° 水印,水印字符和正文字符在同一个文本层里,
            纯文本抽取会把水印字母粘进单词中间(实测 "is tied to" 被污染成
            "is tied tol")。需要按字符级 font/size 过滤后再排版抽取,
            这是 pdfplumber 的 page.filter() + extract_text(layout=True)
            能做而通用 PDF 转文本做不到的事。
python-docx docx 的元素类型(对白 / 动作)只靠段落对齐方式区分,必须读到
            paragraph_format.alignment,不能只取文字。

────────────────────────────────────────────────────────────────────────
二、切分规则(可复跑)
────────────────────────────────────────────────────────────────────────
剧本 A · idb = "I Died Before You Learned to Love Me"(PDF,40 页,20 集)

  A1 去水印:丢弃字号 >= 20pt 的字符。正文实测 11.99–12.0pt(CIDFont+F1/F2),
     水印实测 70.16pt(SimHei,matrix 0.87/0.87 即 45° 旋转)。两者不重叠。
  A2 排版抽取:extract_text(layout=True) 保留左缩进——这份 PDF 是标准好莱坞
     版式导出件,缩进列位就是元素类型,不需要猜。实测全篇缩进只有下列取值:
        7  场次标记行(行首行尾各一个场号,中间是场景标题)
       12  集标记行 EPISODE N
       15  动作
       25  对白
       29/30 括号提示(30 是括号提示的折行)
       35  角色名
       >=55  转场标记 / 页码
     碰到未登记的缩进直接报错退出,防止版式漂移被静默吃掉。
  A3 丢弃:页码行(缩进 >=55 且形如 "12.")、分页续接标记 "(MORE)"。
  A4 集边界:缩进 12 且匹配 ^EPISODE\\s*(\\d+)$ 的行。该行之后到下一个集标记
     之前为本集正文。(第 5 集原文写作 "EPISODE5",无空格,故 \\s* 而非 \\s+。)

剧本 B · bdlw = "霸道狼王爱上离异带球跑的我"(DOCX,602 段,10 集)

  B1 集边界:样式为 Heading 1 且匹配 ^EPISODE\\s*(\\d+)。样式为 Title 的
     文档标题丢弃。
  B2 元素类型看段落对齐:CENTER = 对白块(角色名/括号提示/台词),
     其余(LEFT / 未设置)= 场次标记行或动作。实测 80 个 CENTER 连续段落块,
     首行 100% 匹配角色名式样,零例外。
  B3 CENTER 块内部用状态机分角色名与台词——不能只看"全大写",因为台词本身
     可能全大写(EP1 的 "NO!!!")。规则:块首行 = 角色名;("...") = 括号提示;
     角色名或括号提示之后 = 台词;台词之后若匹配角色名式样则是新角色名,
     否则算台词续行。
  B4 场次标记行:非 CENTER 且匹配 ^(INT|EXT|I/E)[. ]。

────────────────────────────────────────────────────────────────────────
三、统一输出版式
────────────────────────────────────────────────────────────────────────
两部剧输出同一套缩进,取自剧本 A 自己的几何(减掉 15 列页边距),
即标准好莱坞版式:场次/动作/转场顶格,台词缩进 10,括号提示 14,角色名 20。
折行合并规则:相邻同类型行之间没有空行就并成一个元素(PDF 的动作和对白是
硬折行,docx 是完整段落,合并后两边的"段落"口径才一致)。

────────────────────────────────────────────────────────────────────────
四、挑集规则(可复跑,不用随机数)
────────────────────────────────────────────────────────────────────────
每部剧等间隔取 PICK_PER_SCRIPT 集:step = 总集数 // PICK_PER_SCRIPT,
取第 1, 1+step, 1+2*step, ... 集。idb(20 集,step=4)→ 1/5/9/13/17;
bdlw(10 集,step=2)→ 1/3/5/7/9。换语言重写这条规则也能得到同一批。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

import docx
import pdfplumber

# ── 常量 ────────────────────────────────────────────────────────────────

WATERMARK_MIN_SIZE_PT = 20.0  # 正文 12pt / 水印 70pt,20 落在无字符的空档里

PDF_INDENT_KIND = {
    7: "scene_heading",
    12: "episode_marker",
    15: "action",
    25: "dialogue",
    29: "parenthetical",
    30: "parenthetical",
    35: "cue",
}
PDF_TRANSITION_MIN_INDENT = 55

# 输出版式:剧本 A 的实测缩进减去 15 列页边距
EMIT_INDENT = {
    "scene_heading": 0,
    "action": 0,
    "transition": 0,
    "dialogue": 10,
    "parenthetical": 14,
    "cue": 20,
}

EPISODE_MARKER_RE = re.compile(r"^EPISODE\s*(\d+)\b")
PAGE_NUMBER_RE = re.compile(r"^\d+\.$")
SCENE_NUMBERED_RE = re.compile(r"^(\d+)\s+(.*?)\s+(\d+)$")
SCENE_HEADING_RE = re.compile(r"^(INT|EXT|I/E|INT\.?/EXT)[.\s]", re.IGNORECASE)
PARENTHETICAL_RE = re.compile(r"^\(.*\)$")

# 角色名式样:全大写主体 + 可选的 (CONT'D)/(V.O.) 之类播出提示。
# 用它判定"这一行长得像角色名",而不是用它单独断定"这一行就是角色名"。
CUE_RE = re.compile(
    r"^[A-Z][A-Z0-9 .,'’\-/&!#]*"
    r"(?:\s*\((?:CONT[’']D|V\.?O\.?|O\.?S\.?|O\.?C\.?|MORE|PRELAP|FILTERED)\))?$"
)
CUE_SUFFIX_RE = re.compile(
    r"\s*\((?:CONT[’']D|V\.?O\.?|O\.?S\.?|O\.?C\.?|MORE|PRELAP|FILTERED)\)\s*$",
    re.IGNORECASE,
)
# 只装了播出提示的括号行。它属于角色名,不是表演提示——见 bind_cue_extensions。
CUE_EXTENSION_ONLY_RE = re.compile(
    r"^\(\s*(?:CONT[’']D|V\.?O\.?|O\.?S\.?|O\.?C\.?|PRELAP|FILTERED)\s*\)$",
    re.IGNORECASE,
)
# 名字两端不该带的字符。原文有零星录入残渣(idb EP15 写成 "RICHARD（ (O.S.)"),
# 不清掉的话同一个人会被算成两个,金标里的召回分母就是错的。
NAME_TRIM_CHARS = " （）()[]{}【】.,:;、·-—"

PICK_PER_SCRIPT = 5


# ── 数据结构 ────────────────────────────────────────────────────────────


@dataclass
class Element:
    kind: str
    text: str


@dataclass
class Episode:
    number: int
    elements: list[Element] = field(default_factory=list)


def bind_cue_extensions(elements: list[Element]) -> list[Element]:
    """把独立成行的 (V.O.)/(CONT'D)/(O.S.) 并回角色名那一行。

    这类括号只跟角色名走,不是表演提示,所以它前面那行必定是角色名。
    需要这条是因为 bdlw EP4 把角色名写成了首字母大写的 "Elara" 再换行写
    "(V.O.)"——只按"全大写"识别角色名会把它当成台词漏掉。实测 bdlw 出现 3 次、
    idb 出现 0 次,而 idb 里紧跟台词的括号全是真表演提示,不会被这条误伤。
    """
    out: list[Element] = []
    for element in elements:
        if (
            element.kind == "parenthetical"
            and CUE_EXTENSION_ONLY_RE.match(element.text)
            and out
        ):
            out[-1] = Element("cue", f"{out[-1].text} {element.text}")
            continue
        out.append(element)
    return out


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalize_inline(text: str) -> str:
    # docx 里大量 U+00A0;PDF 抽取偶有 U+200B。统一成普通空格再压缩,
    # 否则同一个角色名会因为不可见字符被算成两个人。
    text = text.replace(" ", " ").replace("​", "")
    return re.sub(r"[ \t]+", " ", text).strip()


# ── 剧本 A:PDF ─────────────────────────────────────────────────────────


def pdf_lines(pdf_path: Path) -> list[tuple[int, str, bool]]:
    """→ [(左缩进, 行文本, 该行之前是否有空行)]"""
    out: list[tuple[int, str, bool]] = []
    pending_blank = False
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            clean = page.filter(
                lambda obj: obj["object_type"] != "char"
                or obj["size"] < WATERMARK_MIN_SIZE_PT
            )
            for raw in (clean.extract_text(layout=True) or "").split("\n"):
                if not raw.strip():
                    pending_blank = True
                    continue
                out.append((len(raw) - len(raw.lstrip()), raw.rstrip(), pending_blank))
                pending_blank = False
            # 翻页本身就是元素边界,不让跨页的两块正文粘在一起
            pending_blank = True
    return out


def parse_pdf(pdf_path: Path) -> list[Episode]:
    episodes: list[Episode] = []
    current: Episode | None = None
    prev_kind: str | None = None
    front_matter: list[str] = []

    for indent, raw, had_blank in pdf_lines(pdf_path):
        text = normalize_inline(raw)

        if indent >= PDF_TRANSITION_MIN_INDENT:
            if PAGE_NUMBER_RE.match(text):
                prev_kind = None
                continue
            kind = "transition"
        elif indent in PDF_INDENT_KIND:
            kind = PDF_INDENT_KIND[indent]
        else:
            raise SystemExit(
                f"[idb] 未登记的缩进 {indent}:{text!r}\n"
                "版式漂移了,先核对切分规则再重跑,不要放行。"
            )

        if kind == "episode_marker":
            match = EPISODE_MARKER_RE.match(text)
            if not match:
                raise SystemExit(f"[idb] 集标记行解析失败:{text!r}")
            current = Episode(number=int(match.group(1)))
            episodes.append(current)
            prev_kind = None
            continue

        if current is None:
            front_matter.append(text)
            continue

        if kind == "cue":
            if text == "(MORE)":  # 分页续接标记,不是角色名
                prev_kind = None
                continue
            # 场号 / 角色名 / 场次标记永远各自成元素,不参与折行合并
            current.elements.append(Element(kind, text))
            prev_kind = kind
            continue

        if kind == "scene_heading":
            match = SCENE_NUMBERED_RE.match(text)
            if match and match.group(1) == match.group(3):
                text = match.group(2)
            current.elements.append(Element(kind, text))
            prev_kind = kind
            continue

        if kind == prev_kind and not had_blank and current.elements:
            current.elements[-1].text += " " + text
        else:
            current.elements.append(Element(kind, text))
        prev_kind = kind

    if any(front_matter):
        raise SystemExit(f"[idb] 第一个集标记之前有正文,规则不成立:{front_matter[:3]}")
    for episode in episodes:
        episode.elements = bind_cue_extensions(episode.elements)
    return episodes


# ── 剧本 B:DOCX ────────────────────────────────────────────────────────


def parse_docx(docx_path: Path) -> list[Episode]:
    document = docx.Document(str(docx_path))
    episodes: list[Episode] = []
    current: Episode | None = None
    centered_run: list[str] = []

    def flush_centered() -> None:
        """CENTER 连续块 → 角色名 / 括号提示 / 台词。

        全大写不能单独当角色名的判据(台词也可能全大写),所以按位置走状态机。
        """
        nonlocal centered_run
        if not centered_run or current is None:
            centered_run = []
            return
        expect = "cue"
        for text in centered_run:
            if expect == "cue":
                kind = "cue"
            elif PARENTHETICAL_RE.match(text):
                kind = "parenthetical"
            elif expect == "dialogue_or_cue" and CUE_RE.match(text):
                kind = "cue"
            else:
                kind = "dialogue"
            current.elements.append(Element(kind, text))
            expect = "dialogue" if kind in ("cue", "parenthetical") else "dialogue_or_cue"
        centered_run = []

    for paragraph in document.paragraphs:
        text = normalize_inline(paragraph.text)
        style = paragraph.style.name
        alignment = paragraph.paragraph_format.alignment
        is_centered = getattr(alignment, "value", alignment) == 1

        if not text:
            continue
        if style == "Title":
            flush_centered()
            continue
        if style.startswith("Heading"):
            flush_centered()
            match = EPISODE_MARKER_RE.match(text)
            if not match:
                raise SystemExit(f"[bdlw] 标题不是集标记:{text!r}")
            current = Episode(number=int(match.group(1)))
            episodes.append(current)
            continue
        if current is None:
            raise SystemExit(f"[bdlw] 第一个集标记之前有正文:{text!r}")

        if is_centered:
            centered_run.append(text)
            continue

        flush_centered()
        kind = "scene_heading" if SCENE_HEADING_RE.match(text) else "action"
        current.elements.append(Element(kind, text))

    flush_centered()
    for episode in episodes:
        episode.elements = bind_cue_extensions(episode.elements)
    return episodes


# ── 事实统计 ────────────────────────────────────────────────────────────


def render_episode(episode: Episode) -> str:
    blocks = [" " * EMIT_INDENT[e.kind] + e.text for e in episode.elements]
    return "\n\n".join(blocks) + "\n"


def speakers_from_cue(cue: str) -> list[str]:
    base = CUE_SUFFIX_RE.sub("", cue).strip()
    # "RICHARD / EMILY" 是同台词双角色,两个人都开口了,各记一次
    names = (part.strip(NAME_TRIM_CHARS).upper() for part in base.split("/"))
    return [name for name in names if name]


def episode_facts(episode: Episode, text: str, rel_path: str | None) -> dict:
    kinds: dict[str, int] = {}
    for element in episode.elements:
        kinds[element.kind] = kinds.get(element.kind, 0) + 1

    cue_lines = [e.text for e in episode.elements if e.kind == "cue"]
    speaker_counts: dict[str, int] = {}
    for cue in cue_lines:
        for name in speakers_from_cue(cue):
            speaker_counts[name] = speaker_counts.get(name, 0) + 1

    dialogue = " ".join(e.text for e in episode.elements if e.kind == "dialogue")
    body = "".join(e.text for e in episode.elements)

    return {
        "episode": episode.number,
        "text_file": rel_path,
        "text_sha256": sha256_text(text) if rel_path else None,
        "chars": len(text),
        "chars_no_whitespace": len("".join(text.split())),
        "chars_body_only": len(body),
        "words": len(re.findall(r"[A-Za-z’']+", body)),
        "cjk_chars": sum(
            1 for ch in body if unicodedata.category(ch) == "Lo" and ord(ch) > 0x2E80
        ),
        "paragraphs": len(episode.elements),
        "elements_by_kind": dict(sorted(kinds.items())),
        "scene_heading_lines": [
            e.text for e in episode.elements if e.kind == "scene_heading"
        ],
        "speakers": sorted(speaker_counts),
        "speaker_cue_counts": dict(sorted(speaker_counts.items())),
        "cue_lines": cue_lines,
        "dialogue_chars": len(dialogue),
    }


def pick(total: int) -> list[int]:
    step = max(1, total // PICK_PER_SCRIPT)
    return [1 + i * step for i in range(PICK_PER_SCRIPT) if 1 + i * step <= total]


# ── 主流程 ──────────────────────────────────────────────────────────────

SCRIPTS = [
    {
        "id": "idb",
        "title": "I Died Before You Learned to Love Me",
        "source_name": "I Died Before You Learned to Love Me【EP1-20】.pdf",
        "parser": "pdfplumber==0.11.7",
        "parse": parse_pdf,
    },
    {
        "id": "bdlw",
        "title": "霸道狼王爱上离异带球跑的我",
        "source_name": "正文 霸道狼王爱上离异带球跑的我.docx",
        "parse": parse_docx,
        "parser": "python-docx==1.2.0",
    },
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", type=Path, required=True, help="本机数据区根目录")
    ap.add_argument(
        "--source",
        action="append",
        required=True,
        metavar="ID=PATH",
        help="剧本源文件,可重复:idb=<pdf> bdlw=<docx>",
    )
    args = ap.parse_args()

    sources = dict(item.split("=", 1) for item in args.source)
    out_dir: Path = args.data_dir / "breakdown-eval"
    episodes_dir = out_dir / "episodes"
    episodes_dir.mkdir(parents=True, exist_ok=True)

    report: dict = {
        "schema": "breakdown-eval/episode-facts/v1",
        "generated_by": "scripts/eval/breakdown/extract_episodes.py",
        "determinism": "同一输入重跑逐字节相同;故意不写时间戳,便于 diff 校验",
        "selection_rule": {
            "kind": "fixed-stride",
            "formula": "step = total // 5; episodes = [1, 1+step, 1+2*step, ...][:5]",
            "why": "不用随机数,换人换语言重算都是同一批,轮次之间才可比",
        },
        "split_rules": {
            "idb": "去 >=20pt 水印字符 → layout 抽取 → 缩进 12 且 ^EPISODE\\s*(\\d+)$ 为集边界",
            "bdlw": "Heading 1 且 ^EPISODE\\s*(\\d+) 为集边界",
        },
        "emit_layout_indent": EMIT_INDENT,
        "scripts": [],
    }

    for spec in SCRIPTS:
        source_path = Path(sources[spec["id"]]).expanduser().resolve()
        episodes = spec["parse"](source_path)
        numbers = [e.number for e in episodes]
        if numbers != list(range(1, len(numbers) + 1)):
            raise SystemExit(f"[{spec['id']}] 集号不连续:{numbers}")

        chosen = set(pick(len(episodes)))
        facts = []
        for episode in episodes:
            text = render_episode(episode)
            rel = None
            if episode.number in chosen:
                name = f"ep-{spec['id']}-{episode.number:02d}.txt"
                (episodes_dir / name).write_text(text, encoding="utf-8")
                rel = f"episodes/{name}"
            facts.append(episode_facts(episode, text, rel))

        report["scripts"].append(
            {
                "id": spec["id"],
                "title": spec["title"],
                "source_file": spec["source_name"],
                "source_sha256": sha256_file(source_path),
                "source_bytes": source_path.stat().st_size,
                "parser": spec["parser"],
                "episode_count": len(episodes),
                "selected_episodes": sorted(chosen),
                "episodes": facts,
            }
        )

    (out_dir / "facts.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {out_dir / 'facts.json'}")
    for script in report["scripts"]:
        print(
            f"  {script['id']}: {script['episode_count']} eps, "
            f"selected {script['selected_episodes']}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
