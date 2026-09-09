#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""场次/镜头边界金标的生成器与校验器(scene 维度,标注员 A)。

为什么是脚本而不是十个手写 json:

  1. 每一镜都要能翻回正文核对,但**剧本原文不进代码仓**(是别人的作品)。
     所以证据锚点存的是「第几行、行内第几列、多长」,不存原文片段。
     实测:若改存原文片段,会把两部剧 26.8% 的正文抄进 git,那是抄作品不是留证据。
     要看原文跑 `show`,渲染结果写到本机数据区,不落仓。

  2. 锚点必须真的指得中东西。生成时逐条回查 .txt:锚点要落在声明的行范围内、
     切出来的片段非空、镜头顺序与正文字符顺序一致、场内每行非空正文都被覆盖、
     场次标记行与 facts.json 一致、输入文件 sha256 与 facts.json 一致。
     任一条不过就不写出任何文件。

  3. 「这一集有多少段落级元素」这种能算的事不该由标注员拍脑袋。elementCount 由缩进版式算出,
     和判断部分分开存,给评分方一把不含判断的独立标尺 —— 它不是镜头数的上界也不是下界,见下。

判断部分(哪里切场、哪里切镜)全部来自人工阅读,规则写在 gold/scene/RUBRIC.md,
每一镜都标了触发它的规则 id,别人可以按规则逐条复核或推翻。

用法:
  build_scene_gold.py build   # 生成 eval/breakdown/gold/scene/*.json
  build_scene_gold.py check   # 只校验已生成的 json 与正文是否仍然对得上
  build_scene_gold.py show    # 把锚点渲染成带原文的人工复核稿,写到本机数据区
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from paths import GOLD_DIR, REPO_DIR, data_root

DATA_DIR = data_root()
OUT_DIR = GOLD_DIR / "scene"
REVIEW_DIR = DATA_DIR / "gold-review" / "scene"

# 缩进即元素类型,取自 facts.json 的 emit_layout_indent,不重新猜。
INDENT_DIALOGUE = 10
INDENT_PARENTHETICAL = 14
INDENT_CUE = 20

SLUGLINE_RE = re.compile(r"^(INT|EXT|I/E)[. ]")
# 转场:全大写且以冒号结尾(BACK TO PRESENT:),或已知的黑场写法。
TRANSITION_RE = re.compile(r"^[A-Z][A-Z0-9 /'’\-]*:$")


def k(
    line_start: int,
    line_end: int,
    anchor_line: int,
    anchor_col: int,
    anchor_len: int,
    framing: str,
    rule: str,
    note: str | None = None,
) -> dict:
    """一镜。行范围是这一镜管到哪;锚点是这一镜的判断依据落在正文的哪一段字。

    锚点只用 (行, 列, 长度) 三个数,不抄原文。跑 show 可以还原成可读的复核稿。
    """
    return {
        "lineStart": line_start,
        "lineEnd": line_end,
        "anchor": {"line": anchor_line, "col": anchor_col, "len": anchor_len},
        "framingIntent": framing,
        "cutTrigger": rule,
        "note": note,
    }


ANNOTATION: dict[str, dict] = {
    'ep-idb-01': {
        'script': 'idb',
        'episode': 1,
        'notes': ["L105 的 SUPER 写作「Charlotte Warren's death」,但 L3 建立的姓氏是 WHITMORE。原文自身的姓氏不一致,不影响场次边界,记在这里供身份归一维度参考。", 'S1/S3 是同一条电话戏的交叉剪辑,共用同一条场次标记行,见 disputed D1。'],
        'scenes': [
            {
                'lines': (1, 51),
                'headingLine': 1,
                'group': 'intercut-phonecall',
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(3, 3, 3, 0, 42, 'wide', 'NEW_SCENE', None),
                    k(3, 3, 3, 118, 20, 'MS', 'SCALE_CHANGE', None),
                    k(3, 3, 3, 215, 40, 'ECU', 'INSERT', None),
                    k(5, 7, 7, 10, 21, 'held', 'VO_BLOCK', None),
                    k(9, 9, 9, 18, 42, 'MS', 'NEW_SUBJECT', None),
                    k(9, 9, 9, 99, 29, 'CU', 'INSERT', None),
                    k(11, 13, 13, 10, 19, 'CU', 'SPEAKER', None),
                    k(15, 15, 15, 0, 30, 'CU', 'REACTION', None),
                    k(15, 15, 15, 45, 38, 'MS', 'ACTION_BEAT', None),
                    k(17, 19, 19, 10, 17, 'CU', 'SPEAKER', None),
                    k(21, 25, 25, 10, 20, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(27, 27, 27, 16, 21, 'CU', 'REACTION', None),
                    k(27, 27, 27, 97, 24, 'ECU', 'ACTION_BEAT', None),
                    k(29, 33, 33, 10, 3, 'CU', 'SPEAKER', None),
                    k(35, 35, 35, 0, 25, 'MS', 'ACTION_BEAT', None),
                    k(35, 35, 35, 92, 39, 'MS', 'NEW_SUBJECT', None),
                    k(37, 39, 39, 10, 30, 'CU', 'SPEAKER', None),
                    k(41, 41, 41, 0, 36, 'CU', 'REACTION', None),
                    k(41, 41, 41, 55, 33, 'insert', 'INSERT', None),
                    k(41, 41, 41, 99, 48, 'MS', 'ACTION_BEAT', None),
                    k(41, 41, 41, 168, 31, 'MS', 'NEW_SUBJECT', None),
                    k(41, 41, 41, 216, 14, 'insert', 'INSERT', None),
                    k(43, 45, 45, 14, 15, 'CU', 'SPEAKER', None),
                    k(47, 51, 47, 0, 30, 'MS', 'SPEAKER+MERGE_PREBEAT', 'RICHARD (V.O.) 从这个空间里的听筒传出,不另起镜头'),
                ],
            },
            {
                'lines': (53, 77),
                'headingLine': 53,
                'group': 'intercut-phonecall',
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(55, 55, 55, 0, 45, 'wide', 'NEW_SCENE', None),
                    k(55, 55, 55, 212, 18, 'MS', 'NEW_SUBJECT', None),
                    k(55, 55, 55, 381, 31, 'MS', 'NEW_SUBJECT', None),
                    k(57, 61, 61, 41, 33, 'CU', 'SPEAKER', None),
                    k(63, 63, 63, 20, 21, 'MS', 'SPATIAL_MOVE', None),
                    k(65, 71, 67, 10, 23, 'CU', 'SPEAKER+CONTD_MERGE', None),
                    k(73, 77, 73, 0, 30, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                ],
            },
            {
                'lines': (79, 101),
                'headingLine': 79,
                'group': 'intercut-phonecall',
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(81, 81, 81, 19, 24, 'CU', 'NEW_SCENE', None),
                    k(83, 85, 85, 69, 9, 'held', 'VO_BLOCK', None),
                    k(87, 87, 87, 0, 25, 'MS', 'ACTION_BEAT', None),
                    k(87, 87, 87, 113, 22, 'CU', 'REACTION', None),
                    k(89, 91, 91, 14, 30, 'CU', 'SPEAKER', None),
                    k(93, 93, 93, 0, 29, 'insert', 'INSERT', None),
                    k(95, 97, 97, 58, 11, 'CU', 'SPEAKER', None),
                    k(99, 99, 99, 0, 35, 'CU', 'REACTION', None),
                    k(99, 101, 99, 36, 31, 'low', 'ACTION_BEAT', 'L101 的 CUT TO BLACK 是这一镜的收尾,不单算一个镜头'),
                ],
            },
            {
                'lines': (103, 113),
                'headingLine': 103,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(105, 105, 105, 12, 39, 'wide', 'NEW_SCENE', 'SUPER 字幕叠在这一镜上,不单算一个镜头'),
                    k(105, 105, 105, 148, 30, 'insert', 'INSERT', None),
                    k(105, 105, 105, 225, 45, 'insert', 'INSERT', None),
                    k(105, 109, 109, 14, 9, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(111, 111, 111, 15, 33, 'insert', 'INSERT', '这行写在括号提示位上,但内容是动作,见 disputed D2'),
                    k(113, 113, 113, 19, 7, 'CU', 'SPEAKER', None),
                ],
            },
        ],
        'disputed': [{'id': 'D1', 'scope': 'scene', 'anchor': 'L1 / L79 两条同名场次标记行', 'readingA': '按场次标记行逐条算:仓库地下室出现两次就是两场(本文件采用)', 'readingB': '同一通电话的交叉剪辑,地下室这一头算一场被中间插了一段,全集 3 场', 'impact': '全集场数 4 vs 3;场边界召回率的分母差一条', 'lean': 'A。理由是第 4 场用的也是第 2 场那条标记行,若按 B 合并同名场,第 2/4 场也会被错并成一场,而它们中间隔了七天(L105 的 SUPER 明写)。同一套规则要在全集内自洽。'}, {'id': 'D2', 'scope': 'shot', 'anchor': 'L111 (She looks at her transparent hand.)', 'readingA': '内容是动作,需要一个手部插入镜头(本文件采用,记为 s05)', 'readingB': '它写在括号提示位上,应当只当表演提示,L105-L113 的独白合成一个镜头', 'impact': '本集镜头数 46 vs 44', 'lean': 'A,但置信度中等。这是原文版式错位,不是导演意图,两种读法都应判对。'}],
    },
    'ep-idb-05': {
        'script': 'idb',
        'episode': 5,
        'notes': ['L23 的场次标记行原文带一个多余的全角括号:INT. WARREN HOUSE ... NIGHT（(FLASHBACK)。按原样保留。', 'S2/S3 是闪回,L103 的 BACK TO PRESENT: 是闪回的收尾标记,归在 S3 的行范围里。', 'L23 写 WARREN HOUSE、L99 写 WHITMORE HOUSE,原文自身的宅名不一致。'],
        'scenes': [
            {
                'lines': (1, 21),
                'headingLine': 1,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(3, 7, 3, 31, 31, 'MS', 'NEW_SCENE+MERGE_PREBEAT', None),
                    k(9, 9, 9, 0, 42, 'MS', 'NEW_SUBJECT', None),
                    k(9, 9, 9, 76, 38, 'insert', 'INSERT', None),
                    k(11, 15, 15, 10, 8, 'CU', 'SPEAKER', None),
                    k(17, 17, 17, 0, 26, 'wide', 'ACTION_BEAT', None),
                    k(17, 21, 17, 27, 33, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                ],
            },
            {
                'lines': (23, 97),
                'headingLine': 23,
                'group': 'flashback',
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(25, 25, 25, 0, 40, 'wide', 'NEW_SCENE', None),
                    k(25, 25, 25, 41, 27, 'insert', 'INSERT', None),
                    k(25, 31, 25, 97, 50, 'MS', 'SPEAKER+MERGE_PREBEAT', None),
                    k(33, 33, 33, 51, 24, 'MS', 'SPATIAL_MOVE', None),
                    k(33, 33, 33, 110, 18, 'CU', 'REACTION', None),
                    k(33, 37, 33, 137, 22, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(39, 39, 39, 0, 28, 'MS', 'SPATIAL_MOVE', None),
                    k(41, 41, 41, 6, 39, 'MS', 'ACTION_BEAT', None),
                    k(43, 45, 45, 10, 13, 'CU', 'SPEAKER', None),
                    k(47, 49, 49, 10, 16, 'CU', 'SPEAKER', None),
                    k(51, 55, 51, 10, 27, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(57, 57, 57, 0, 23, 'wide', 'ACTION_BEAT', None),
                    k(57, 57, 57, 56, 25, 'MS', 'SPATIAL_MOVE', None),
                    k(59, 61, 61, 10, 13, 'CU', 'SPEAKER', None),
                    k(63, 67, 63, 0, 25, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(69, 69, 69, 0, 39, 'CU', 'REACTION', None),
                    k(71, 73, 73, 20, 5, 'CU', 'SPEAKER', None),
                    k(75, 77, 77, 43, 23, 'CU', 'SPEAKER', None),
                    k(79, 83, 79, 0, 28, 'MS', 'SPEAKER+MERGE_PREBEAT', None),
                    k(85, 89, 89, 10, 11, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(91, 91, 91, 8, 40, 'MS', 'ACTION_BEAT', None),
                    k(93, 95, 95, 10, 11, 'CU', 'SPEAKER', None),
                    k(97, 97, 97, 16, 20, 'MS', 'ACTION_BEAT', None),
                    k(97, 97, 97, 61, 43, 'MS', 'ACTION_BEAT', None),
                ],
            },
            {
                'lines': (99, 103),
                'headingLine': 99,
                'group': 'flashback',
                'confidence': 'medium',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(101, 101, 101, 0, 36, 'MS', 'NEW_SCENE', None),
                    k(101, 101, 101, 49, 57, 'POV', 'INSERT', None),
                    k(101, 103, 101, 183, 31, 'MS', 'ACTION_BEAT', 'L103 的 BACK TO PRESENT: 是转场标记,归这一镜收尾'),
                ],
            },
            {
                'lines': (105, 119),
                'headingLine': 105,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(107, 111, 107, 13, 31, 'MS', 'NEW_SCENE+MERGE_PREBEAT', None),
                    k(113, 119, 113, 0, 36, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                ],
            },
        ],
        'disputed': [{'id': 'D3', 'scope': 'scene', 'anchor': 'L99 EXT. WHITMORE HOUSE – DAY', 'readingA': '标记行说了算,独立一场(本文件采用),时间标注 DAY 是原文笔误', 'readingB': '它和 L23 的 NIGHT 那场是同一刻连续动作(被推出门外),应视为同场的外景延续', 'impact': '全集场数 4 vs 3;并且这场的 timeOfDay 到底是 DAY 还是 NIGHT 无法从正文判定', 'lean': 'A 判边界,但 timeOfDay 标为 unreliable。内外景切换本身在两种读法里都要切镜,分歧只在算不算一「场」。'}],
    },
    'ep-idb-09': {
        'script': 'idb',
        'episode': 9,
        'notes': ['全集一场。中间 Sabrina 出画(L41)、Richard 带队进画(L73),都只是场内进出,不构成新场。', 'GRANDMA 全程只有电话声,从不出画。'],
        'scenes': [
            {
                'lines': (1, 91),
                'headingLine': 1,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(3, 7, 3, 10, 19, 'MS', 'NEW_SCENE+MERGE_PREBEAT', None),
                    k(9, 9, 9, 38, 52, 'insert', 'INSERT', None),
                    k(9, 13, 9, 184, 22, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(15, 19, 15, 30, 23, 'MS', 'SPEAKER+MERGE_PREBEAT', None),
                    k(21, 21, 21, 12, 19, 'CU', 'NEW_SUBJECT', None),
                    k(21, 25, 21, 66, 20, 'MS', 'SPEAKER+MERGE_PREBEAT', None),
                    k(27, 33, 29, 32, 19, 'CU', 'SPEAKER', None),
                    k(35, 39, 35, 0, 12, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(41, 41, 41, 0, 25, 'MS', 'SPATIAL_MOVE', None),
                    k(41, 41, 41, 79, 22, 'insert', 'INSERT', None),
                    k(43, 45, 45, 17, 20, 'CU', 'VO_BLOCK', None),
                    k(47, 51, 47, 12, 22, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(53, 57, 53, 0, 30, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(59, 61, 61, 65, 15, 'CU', 'VO_BLOCK', None),
                    k(63, 63, 63, 0, 26, 'CU', 'REACTION', None),
                    k(63, 67, 63, 34, 22, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(69, 71, 71, 10, 6, 'CU', 'VO_BLOCK', None),
                    k(73, 73, 73, 0, 14, 'CU', 'ACTION_BEAT', None),
                    k(73, 73, 73, 15, 28, 'wide', 'SPATIAL_MOVE', None),
                    k(75, 77, 77, 17, 6, 'CU', 'SPEAKER', None),
                    k(79, 81, 81, 34, 16, 'CU', 'SPEAKER', None),
                    k(83, 85, 85, 37, 34, 'CU', 'SPEAKER', None),
                    k(87, 91, 87, 12, 19, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                ],
            },
        ],
        'disputed': [],
    },
    'ep-idb-13': {
        'script': 'idb',
        'episode': 13,
        'notes': ['全集一场,最短的一集(1136 字符)。没有边界歧义。'],
        'scenes': [
            {
                'lines': (1, 35),
                'headingLine': 1,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(3, 3, 3, 27, 39, 'wide', 'NEW_SCENE', None),
                    k(3, 3, 3, 67, 36, 'MS', 'NEW_SUBJECT', None),
                    k(3, 7, 3, 104, 33, 'MS', 'SPEAKER+MERGE_PREBEAT', None),
                    k(9, 13, 9, 15, 18, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(15, 17, 17, 10, 21, 'CU', 'SPEAKER', None),
                    k(19, 21, 21, 27, 13, 'CU', 'SPEAKER', None),
                    k(23, 23, 23, 34, 20, 'CU', 'REACTION', None),
                    k(25, 27, 27, 22, 24, 'CU', 'SPEAKER', None),
                    k(29, 33, 29, 0, 11, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(35, 35, 35, 8, 17, 'CU', 'REACTION', None),
                ],
            },
        ],
        'disputed': [],
    },
    'ep-idb-17': {
        'script': 'idb',
        'episode': 17,
        'notes': ['全集一场。场次标记行写的是 WAREHOUSE BASEMENT,和 EP1 的凶案现场同一地点,但这里是警方勘查,属于同一地点的不同时间,跨集比对时别当成同一场。', 'OFFICERS(齐声)在本集只出现一次(L39),本集内没有 OFFICER 单数的写法。'],
        'scenes': [
            {
                'lines': (1, 41),
                'headingLine': 1,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(3, 3, 3, 15, 29, 'CU', 'NEW_SCENE', None),
                    k(3, 3, 3, 45, 25, 'MS', 'ACTION_BEAT', None),
                    k(3, 7, 3, 71, 26, 'MS', 'SPEAKER+MERGE_PREBEAT', None),
                    k(9, 13, 9, 6, 20, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(15, 15, 15, 21, 35, 'wide', 'NEW_SUBJECT', None),
                    k(15, 19, 15, 70, 25, 'CU', 'VO_BLOCK+MERGE_PREBEAT', None),
                    k(21, 21, 21, 29, 24, 'CU', 'SCALE_CHANGE', None),
                    k(21, 25, 21, 95, 20, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(27, 27, 27, 17, 23, 'MS', 'NEW_SUBJECT', None),
                    k(27, 31, 27, 41, 26, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(33, 37, 33, 0, 27, 'MS', 'SPEAKER+MERGE_PREBEAT', None),
                    k(39, 41, 41, 10, 9, 'group', 'SPEAKER', None),
                ],
            },
        ],
        'disputed': [],
    },
    'ep-bdlw-01': {
        'script': 'bdlw',
        'episode': 1,
        'notes': ['全集一场。段落是作者自己敲的,所以基本是一段一镜,只有 L19/L61/L101 三处一段里含两个必须分开的机位。'],
        'scenes': [
            {
                'lines': (1, 103),
                'headingLine': 1,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(3, 3, 3, 22, 22, 'wide', 'NEW_SCENE', None),
                    k(5, 5, 5, 0, 30, 'wide', 'NEW_SUBJECT', None),
                    k(7, 7, 7, 36, 19, 'MS', 'NEW_SUBJECT', None),
                    k(9, 15, 9, 60, 28, 'MS', 'SPEAKER+MERGE_PREBEAT', None),
                    k(17, 17, 17, 0, 38, 'wide', 'REACTION', None),
                    k(19, 19, 19, 0, 24, 'CU', 'REACTION', None),
                    k(19, 19, 19, 56, 29, 'low', 'NEW_SUBJECT', None),
                    k(21, 25, 25, 91, 13, 'CU', 'SPEAKER', None),
                    k(27, 27, 27, 28, 25, 'insert', 'ACTION_BEAT', None),
                    k(29, 35, 29, 0, 21, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(37, 41, 37, 0, 21, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(43, 49, 43, 0, 15, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(51, 53, 53, 0, 40, 'MS', 'ACTION_BEAT', 'L51 的 THUD! 是这一脚的音效,不单算一个镜头'),
                    k(55, 59, 59, 10, 5, 'CU', 'SPEAKER', None),
                    k(61, 61, 61, 18, 21, 'wide', 'ACTION_BEAT', None),
                    k(61, 61, 61, 87, 37, 'insert', 'INSERT', None),
                    k(63, 63, 63, 0, 17, 'CU', 'REACTION', None),
                    k(65, 65, 65, 0, 26, 'MS', 'NEW_SUBJECT', None),
                    k(67, 67, 67, 37, 13, 'ECU', 'REACTION', None),
                    k(69, 73, 73, 45, 21, 'low', 'SPEAKER', None),
                    k(75, 75, 75, 0, 15, 'insert', 'INSERT', None),
                    k(77, 77, 77, 0, 21, 'MS', 'ACTION_BEAT', None),
                    k(79, 83, 83, 10, 13, 'CU', 'SPEAKER', None),
                    k(85, 85, 85, 41, 23, 'MS', 'ACTION_BEAT', None),
                    k(87, 93, 87, 0, 37, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(95, 95, 95, 0, 14, 'CU', 'REACTION', None),
                    k(97, 99, 99, 64, 13, 'CU', 'SPEAKER', None),
                    k(101, 101, 101, 25, 29, 'wide', 'ACTION_BEAT', None),
                    k(101, 101, 101, 71, 36, 'insert', 'INSERT', None),
                    k(103, 103, 103, 32, 28, 'CU', 'REACTION', None),
                ],
            },
        ],
        'disputed': [],
    },
    'ep-bdlw-03': {
        'script': 'bdlw',
        'episode': 3,
        'notes': ['全集一场。', 'L13「（exhales, tears hitting her eyes.）」用的是全角括号,被解析成对白行而不是括号提示。内容是表演提示,不单算镜头。', 'L91「Her eyes roll back. Her body goes limp.」写在对白块里,内容是动作。见 disputed D4。'],
        'scenes': [
            {
                'lines': (1, 103),
                'headingLine': 1,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(3, 3, 3, 0, 20, 'wide', 'NEW_SCENE', None),
                    k(5, 5, 5, 8, 14, 'CU', 'ACTION_BEAT', None),
                    k(5, 5, 5, 62, 18, 'MS', 'SCALE_CHANGE', None),
                    k(7, 7, 7, 0, 29, 'CU', 'ACTION_BEAT', None),
                    k(9, 9, 9, 7, 17, 'insert', 'INSERT', None),
                    k(11, 15, 15, 10, 15, 'CU', 'SPEAKER', None),
                    k(17, 17, 17, 30, 24, 'MS', 'ACTION_BEAT', None),
                    k(19, 19, 19, 12, 10, 'MS', 'NEW_SUBJECT', None),
                    k(21, 21, 21, 0, 23, 'MS', 'SCALE_CHANGE', None),
                    k(23, 25, 23, 17, 22, 'VFX', 'VFX', 'L25 的 SFX 心跳只有声音,不单算一个镜头'),
                    k(27, 37, 27, 0, 32, 'CU', 'VO_BLOCK+MERGE_PREBEAT', None),
                    k(39, 39, 39, 22, 22, 'CU', 'REACTION', None),
                    k(41, 43, 41, 20, 13, 'CU', 'NEW_SUBJECT', None),
                    k(45, 51, 45, 0, 24, 'MS', 'SPEAKER+MERGE_PREBEAT', None),
                    k(53, 57, 53, 52, 31, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(59, 63, 61, 15, 13, 'CU', 'SPEAKER', None),
                    k(65, 65, 65, 0, 16, 'MS', 'ACTION_BEAT', None),
                    k(67, 67, 67, 0, 17, 'CU', 'ACTION_BEAT', None),
                    k(69, 69, 69, 39, 19, 'VFX', 'VFX', None),
                    k(71, 77, 71, 13, 14, 'ECU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(79, 79, 79, 21, 18, 'CU', 'REACTION', None),
                    k(81, 89, 83, 0, 40, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(91, 91, 91, 10, 18, 'ECU', 'ACTION_BEAT', None),
                    k(93, 93, 93, 65, 25, 'MS', 'ACTION_BEAT', None),
                    k(95, 95, 95, 0, 39, 'CU', 'SCALE_CHANGE', None),
                    k(97, 103, 97, 0, 13, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                ],
            },
        ],
        'disputed': [{'id': 'D4', 'scope': 'shot', 'anchor': 'L91 Her eyes roll back. Her body goes limp.', 'readingA': '内容是动作,给一个眼神特写(本文件采用)', 'readingB': '它在对白缩进位上,解析成对白就不该有独立镜头', 'impact': '本集镜头数 26 vs 25', 'lean': 'A。这是原文版式错位;若被测系统按版式判成台词,不应算它错,建议两种读法都判对。'}],
    },
    'ep-bdlw-05': {
        'script': 'bdlw',
        'episode': 5,
        'notes': ['两场,厨房→卧室,第二条标记行写 CONTINUOUS(紧接上一场时间)。', 'L53 台词末尾粘了一个动作词「Silence.」(原文如此),不单算镜头。'],
        'scenes': [
            {
                'lines': (1, 41),
                'headingLine': 1,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(3, 3, 3, 0, 25, 'wide', 'NEW_SCENE', None),
                    k(3, 3, 3, 27, 34, 'MS', 'NEW_SUBJECT', None),
                    k(5, 5, 5, 0, 12, 'MS', 'NEW_SUBJECT', None),
                    k(7, 11, 11, 37, 20, 'CU', 'SPEAKER', None),
                    k(13, 17, 13, 22, 29, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(19, 21, 21, 10, 15, 'CU', 'SPEAKER', None),
                    k(23, 27, 27, 45, 31, 'CU', 'SPEAKER', None),
                    k(29, 33, 29, 0, 24, 'CU', 'VO_BLOCK+MERGE_PREBEAT', None),
                    k(35, 37, 37, 10, 24, 'CU', 'SPEAKER', None),
                    k(39, 41, 41, 10, 17, 'CU', 'SPEAKER', None),
                ],
            },
            {
                'lines': (43, 113),
                'headingLine': 43,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(45, 45, 45, 0, 9, 'wide', 'NEW_SCENE', None),
                    k(47, 53, 47, 16, 32, 'MS', 'SPEAKER+MERGE_PREBEAT', None),
                    k(55, 55, 55, 6, 33, 'MS', 'NEW_SUBJECT', None),
                    k(57, 57, 57, 0, 12, 'CU', 'REACTION', None),
                    k(57, 57, 57, 14, 34, 'MS', 'ACTION_BEAT', None),
                    k(59, 59, 59, 5, 15, 'VFX', 'VFX', None),
                    k(61, 61, 61, 0, 26, 'MS', 'NEW_SUBJECT', None),
                    k(61, 63, 61, 77, 38, 'CU', 'INSERT', 'L63「Pure, lethal sex appeal.」没有独立画面内容,并入这一镜'),
                    k(65, 71, 65, 27, 42, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(73, 77, 73, 8, 25, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(79, 79, 79, 0, 23, 'MS', 'ACTION_BEAT', None),
                    k(81, 81, 81, 40, 17, 'MS', 'SCALE_CHANGE', None),
                    k(81, 81, 81, 108, 35, 'insert', 'INSERT', None),
                    k(83, 87, 87, 83, 24, 'CU', 'SPEAKER', None),
                    k(89, 89, 89, 15, 33, 'CU', 'ACTION_BEAT', None),
                    k(91, 91, 91, 38, 24, 'CU', 'REACTION', None),
                    k(93, 99, 93, 10, 34, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(101, 105, 103, 15, 18, 'CU', 'SPEAKER', None),
                    k(107, 109, 109, 14, 5, 'CU', 'SPEAKER', None),
                    k(111, 113, 113, 30, 42, 'MS', 'ACTION_BEAT', 'L111 的 SFX 干呕只有声音,并入这一镜'),
                ],
            },
        ],
        'disputed': [],
    },
    'ep-bdlw-07': {
        'script': 'bdlw',
        'episode': 7,
        'notes': ['三场。第二场标记行自带 (HIGH-SPEED SEQUENCE),是一段追逐蒙太奇。', 'L103「Aaric looks out over the horizon, his jaw hardening.」写在对白缩进位上,内容是动作,并入下一句台词的镜头。'],
        'scenes': [
            {
                'lines': (1, 53),
                'headingLine': 1,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(3, 3, 3, 0, 23, 'wide', 'NEW_SCENE', None),
                    k(3, 3, 3, 65, 35, 'insert', 'INSERT', None),
                    k(5, 5, 5, 0, 25, 'MS', 'NEW_SUBJECT', None),
                    k(7, 11, 7, 0, 32, 'MS', 'SPEAKER+MERGE_PREBEAT', None),
                    k(13, 17, 17, 79, 22, 'CU', 'SPEAKER', None),
                    k(19, 23, 19, 0, 25, 'MS', 'SPEAKER+MERGE_PREBEAT', None),
                    k(25, 25, 25, 19, 20, 'MS', 'ACTION_BEAT', None),
                    k(27, 29, 29, 0, 16, 'MS', 'VFX', 'L27 的 VFX & SFX: TRANSFORMATION 是这段变身的抬头,不单算一个镜头'),
                    k(31, 31, 31, 0, 28, 'MS', 'VFX', None),
                    k(33, 33, 33, 0, 22, 'CU', 'VFX', None),
                    k(35, 35, 35, 0, 26, 'CU', 'REACTION', None),
                    k(37, 39, 37, 50, 50, 'wide', 'SCALE_CHANGE', None),
                    k(41, 41, 41, 85, 37, 'MS', 'ACTION_BEAT', None),
                    k(43, 43, 43, 0, 39, 'CU', 'INSERT', None),
                    k(45, 47, 45, 0, 16, 'CU', 'REACTION', None),
                    k(47, 47, 47, 99, 26, 'MS', 'ACTION_BEAT', None),
                    k(49, 53, 53, 20, 5, 'CU', 'SPEAKER', None),
                ],
            },
            {
                'lines': (55, 71),
                'headingLine': 55,
                'group': 'montage',
                'confidence': 'medium',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(57, 59, 59, 0, 34, 'wide', 'NEW_SCENE', 'L57 的 BOOM! 是这一镜的音效'),
                    k(61, 61, 61, 29, 24, 'tracking', 'ACTION_BEAT', None),
                    k(63, 63, 63, 21, 28, 'POV', 'ACTION_BEAT', None),
                    k(63, 63, 63, 83, 27, 'CU', 'REACTION', None),
                    k(65, 65, 65, 28, 27, 'wide', 'ACTION_BEAT', None),
                    k(67, 69, 67, 0, 35, 'CU', 'REACTION', 'L69 是对上一句的修辞补充,没有独立画面'),
                    k(71, 71, 71, 33, 18, 'CU', 'NEW_SUBJECT', None),
                    k(71, 71, 71, 78, 33, 'wide', 'SCALE_CHANGE', None),
                ],
            },
            {
                'lines': (73, 119),
                'headingLine': 73,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(75, 75, 75, 0, 27, 'wide', 'NEW_SCENE', None),
                    k(77, 77, 77, 59, 18, 'MS', 'ACTION_BEAT', None),
                    k(79, 81, 79, 0, 25, 'MS', 'ACTION_BEAT', None),
                    k(83, 83, 83, 5, 31, 'VFX', 'VFX', None),
                    k(85, 85, 85, 77, 22, 'MS', 'ACTION_BEAT', None),
                    k(87, 93, 87, 42, 17, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(95, 101, 95, 32, 27, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(103, 107, 103, 44, 17, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(109, 113, 113, 72, 19, 'CU', 'SPEAKER', None),
                    k(115, 119, 119, 79, 18, 'CU', 'SPEAKER', None),
                ],
            },
        ],
        'disputed': [{'id': 'D5', 'scope': 'shot', 'anchor': 'S2 EXT. THE DEATH FOREST(L55-71)', 'readingA': '按段落逐条给镜,再拆两处一段两机位,得 8 镜(本文件采用)', 'readingB': '标记行自称 HIGH-SPEED SEQUENCE,蒙太奇的镜数本来就可长可短,4 镜或 12 镜都说得通', 'impact': '本集镜头数 35 上下浮动 ±4', 'lean': '无强倾向。蒙太奇段落的镜数不该拿来算精确率,建议评分时把这一场标为 elastic、只判场边界不判镜数。'}],
    },
    'ep-bdlw-09': {
        'script': 'bdlw',
        'episode': 9,
        'notes': ['四场,是本测试集里场次最密的一集。', 'L99 的 SELENA (O.S.) 是画外音,画面留在 Elara 身上,不因说话人变化而切到 Selena。'],
        'scenes': [
            {
                'lines': (1, 31),
                'headingLine': 1,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(3, 9, 3, 64, 32, 'MS', 'NEW_SCENE+MERGE_PREBEAT', None),
                    k(11, 11, 11, 29, 38, 'CU', 'ACTION_BEAT', None),
                    k(13, 13, 13, 25, 34, 'CU', 'INSERT', None),
                    k(15, 15, 15, 46, 29, 'CU', 'ACTION_BEAT', None),
                    k(17, 17, 17, 13, 19, 'CU', 'REACTION', None),
                    k(19, 19, 19, 13, 19, 'CU', 'INSERT', None),
                    k(21, 21, 21, 73, 30, 'MS', 'SCALE_CHANGE', None),
                    k(23, 29, 23, 23, 50, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(31, 31, 31, 38, 31, 'CU', 'REACTION', None),
                ],
            },
            {
                'lines': (33, 39),
                'headingLine': 33,
                'group': None,
                'confidence': 'medium',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(35, 35, 35, 0, 26, 'wide', 'NEW_SCENE', None),
                    k(37, 37, 37, 0, 26, 'MS', 'ACTION_BEAT', None),
                    k(39, 39, 39, 26, 21, 'MS', 'ACTION_BEAT', None),
                ],
            },
            {
                'lines': (41, 91),
                'headingLine': 41,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(43, 43, 43, 0, 35, 'MS', 'NEW_SCENE', None),
                    k(45, 45, 45, 31, 36, 'MS', 'ACTION_BEAT', None),
                    k(47, 47, 47, 0, 16, 'CU', 'REACTION', None),
                    k(49, 55, 49, 25, 13, 'CU', 'SPEAKER+MERGE_PREBEAT', None),
                    k(57, 57, 57, 0, 47, 'MS', 'REACTION', None),
                    k(59, 59, 59, 9, 29, 'CU', 'INSERT', None),
                    k(61, 61, 61, 31, 28, 'VFX', 'VFX', None),
                    k(63, 63, 63, 31, 32, 'insert', 'INSERT', None),
                    k(65, 65, 65, 157, 16, 'wide', 'ACTION_BEAT', None),
                    k(67, 69, 69, 0, 25, 'CU', 'REACTION', 'L67 讲气味变化,没有独立画面,并入这一镜'),
                    k(71, 75, 71, 11, 12, 'MS', 'SPEAKER+MERGE_PREBEAT', None),
                    k(77, 77, 77, 0, 12, 'CU', 'REACTION', None),
                    k(79, 83, 83, 33, 22, 'CU', 'SPEAKER', None),
                    k(85, 89, 85, 15, 14, 'MS', 'SPEAKER+MERGE_PREBEAT', None),
                    k(91, 91, 91, 0, 9, 'CU', 'REACTION', None),
                    k(91, 91, 91, 43, 18, 'MS', 'SPATIAL_MOVE', None),
                ],
            },
            {
                'lines': (93, 113),
                'headingLine': 93,
                'group': None,
                'confidence': 'high',
                'boundaryRule': 'S1_SLUGLINE',
                'shots': [
                    k(95, 95, 95, 0, 45, 'tracking', 'NEW_SCENE', None),
                    k(97, 101, 97, 26, 36, 'CU', 'OS_VOICE+MERGE_PREBEAT', '说话人是 Selena,但她在画外,画面不切'),
                    k(103, 103, 103, 13, 19, 'CU', 'REACTION', None),
                    k(105, 105, 105, 0, 16, 'MS', 'ACTION_BEAT', None),
                    k(107, 107, 107, 26, 19, 'MS', 'NEW_SUBJECT', None),
                    k(109, 111, 111, 49, 26, 'CU', 'SPEAKER', None),
                    k(113, 113, 113, 65, 17, 'CU', 'REACTION', None),
                ],
            },
        ],
        'disputed': [{'id': 'D6', 'scope': 'scene', 'anchor': 'L33 EXT. THE ALPHA SUMMIT (GRAND HALL) - LATER 与 L41 INT. GRAND BANQUET HALL - CONTINUOUS', 'readingA': '两条标记行两场:L33 是车到门口的外景,L41 是进厅内景(本文件采用)', 'readingB': 'L35 的正文写的是厅内景象(Hundreds of elite Alphas ... mingle inside),说明这条标记行指的就是宴会厅,应与 L41 合成一场', 'impact': '全集场数 4 vs 3;这一场只有 3 个镜头,合并会把它们并进下一场', 'lean': 'A,置信度中等。标记行的 EXT 与正文的 inside 自相矛盾,是原文的毛病,两种读法都应判对。'}],
    },
}


def load_lines(txt_path: Path) -> list[str]:
    return txt_path.read_text(encoding="utf-8").split("\n")


def element_counts(lines: list[str]) -> dict:
    """按版式算出的段落级元素数:动作元素 + 合并 CONT'D 后的对白块。

    这是确定性的参照量,不是镜头数的上界也不是下界 —— 实测两个方向都会被穿透:
    人工标注在 idb 会高于它(PDF 硬折行把 3-5 个节拍压成一个段落,标注要拆开),
    在 bdlw 会低于它(作者的段落很碎,「动作只是下一句台词的准备」的地方要并)。
    存它是为了让评分方有一把不含判断的独立标尺,能看出系统的粒度是偏碎还是偏粗。
    """
    action = 0
    transition = 0
    cue_blocks: list[str] = []
    prev_kind = None
    for raw in lines:
        if not raw.strip():
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        body = raw.strip()
        if indent >= INDENT_CUE:
            base = re.sub(r"\s*\((?:V\.O\.|O\.S\.|O\.C\.|CONT.D)\)\s*", "", body).strip()
            is_contd = "CONT" in body and prev_kind == "cue_or_speech"
            if is_contd and cue_blocks and cue_blocks[-1] == base:
                pass  # 紧邻的同人 CONT'D 续说,不另起一个视觉单元
            else:
                cue_blocks.append(base)
            prev_kind = "cue_or_speech"
        elif indent >= INDENT_DIALOGUE:
            prev_kind = "cue_or_speech"
        else:
            if SLUGLINE_RE.match(body):
                prev_kind = "heading"
                continue
            if TRANSITION_RE.match(body) or body == "CUT TO BLACK.":
                transition += 1
                prev_kind = "transition"
                continue
            action += 1
            prev_kind = "action"
    return {
        "actionElements": action,
        "cueBlocksAfterContdMerge": len(cue_blocks),
        "transitions": transition,
        "elementCount": action + len(cue_blocks),
    }


def line_offsets(lines: list[str]) -> list[int]:
    offs, cur = [], 0
    for ln in lines:
        offs.append(cur)
        cur += len(ln) + 1
    return offs


def resolve(lines: list[str], anchor: dict) -> str:
    ln = lines[anchor["line"] - 1]
    return ln[anchor["col"] : anchor["col"] + anchor["len"]]


def build_episode(ep_id: str, spec: dict, facts: dict) -> tuple[dict, list[str]]:
    txt_path = DATA_DIR / "episodes" / f"{ep_id}.txt"
    lines = load_lines(txt_path)
    offs = line_offsets(lines)
    fact = facts[(spec["script"], spec["episode"])]

    errors: list[str] = []

    import hashlib

    actual_sha = hashlib.sha256(txt_path.read_bytes()).hexdigest()
    if actual_sha != fact["text_sha256"]:
        errors.append(f"{ep_id}: .txt 的 sha256 与 facts.json 不一致,输入变了,标注的行号不再可信")

    out_scenes = []
    prev_abs = -1
    total_shots = 0
    heading_seen: list[str] = []

    for si, sc in enumerate(spec["scenes"], start=1):
        lo, hi = sc["lines"]
        heading = lines[sc["headingLine"] - 1].strip()
        heading_seen.append(heading)
        if not SLUGLINE_RE.match(heading):
            errors.append(f"{ep_id} S{si}: 第 {sc['headingLine']} 行不是场次标记行: {heading!r}")

        shots = []
        for ki, sh in enumerate(sc["shots"], start=1):
            a, b, an = sh["lineStart"], sh["lineEnd"], sh["anchor"]
            if not (lo <= a <= b <= hi):
                errors.append(f"{ep_id} S{si}K{ki}: 行范围 {a}-{b} 不在场范围 {lo}-{hi} 内")
            if not (a <= an["line"] <= b):
                errors.append(f"{ep_id} S{si}K{ki}: 锚点第 {an['line']} 行不在这一镜的行范围 {a}-{b} 内")
            frag = resolve(lines, an)
            if len(frag) != an["len"] or not frag.strip():
                errors.append(f"{ep_id} S{si}K{ki}: 锚点 L{an['line']}:{an['col']}+{an['len']} 切不出有效正文")
            abs_pos = offs[an["line"] - 1] + an["col"]
            if abs_pos <= prev_abs:
                errors.append(f"{ep_id} S{si}K{ki}: 镜头顺序和正文顺序不一致(锚点 L{an['line']}:{an['col']})")
            prev_abs = abs_pos
            shots.append(
                {
                    "shotId": f"{ep_id}-s{si:02d}k{ki:02d}",
                    "order": ki,
                    "lineStart": a,
                    "lineEnd": b,
                    "anchor": an,
                    "framingIntent": sh["framingIntent"],
                    "cutTrigger": sh["cutTrigger"],
                    **({"note": sh["note"]} if sh["note"] else {}),
                }
            )

        # 覆盖检查:场内每一行非空正文都要落在某个镜头的行范围里(标记行除外)
        covered = set()
        for out in shots:
            covered.update(range(out["lineStart"], out["lineEnd"] + 1))
        for ln in range(lo, hi + 1):
            if not lines[ln - 1].strip() or ln == sc["headingLine"]:
                continue
            if ln not in covered:
                errors.append(f"{ep_id} S{si}: 第 {ln} 行没有被任何镜头覆盖")

        total_shots += len(shots)
        out_scenes.append(
            {
                "sceneId": f"{ep_id}-s{si:02d}",
                "order": si,
                "lineStart": lo,
                "lineEnd": hi,
                "headingLine": sc["headingLine"],
                "heading": heading,
                "intExt": heading.split(".")[0].split(" ")[0],
                "boundaryRule": sc["boundaryRule"],
                "group": sc["group"],
                "confidence": sc["confidence"],
                "shotCount": len(shots),
                "shots": shots,
            }
        )

    if heading_seen != fact["scene_heading_lines"]:
        errors.append(f"{ep_id}: 场次标记行与 facts.json 对不上")

    counts = element_counts(lines)
    doc = {
        "schema": "breakdown-eval/gold/scene/v1",
        "dimension": "scene-and-shot-boundary",
        "question": "这一集分成几场?每场大致哪几句话?每场该切成几个镜头?依据是时空是否变化、机位是否必须变。",
        "episodeId": ep_id,
        "script": spec["script"],
        "episode": spec["episode"],
        "textFile": f"episodes/{ep_id}.txt",
        "textFileBase": "zhongwen-shortdrama-local-data/breakdown-eval",
        "textSha256": fact["text_sha256"],
        "rubric": "gold/scene/RUBRIC.md",
        "rubricVersion": "scene-shot/v1",
        "anchorFormat": "anchor = {line, col, len},指向 textFile 里第 line 行(1 起)第 col 列(0 起)开始的 len 个字符。"
        "本仓不存剧本正文,跑 build_scene_gold.py show 可以在本机把锚点还原成可读复核稿。",
        "annotator": {
            "id": "scene-annotator-A",
            "kind": "llm",
            "model": "claude-opus-5",
            "independence": "只读逐集 .txt 正文标注,全程未调用平台拆解功能,未看过任何模型拆解输出",
            "crossChecked": "场次标记行与输入文件 sha256 逐条回查 facts.json;锚点由脚本回查正文,对不上就报错不出文件",
        },
        "status": "single-annotator-draft",
        "usableAs": "裁定用的其中一份独立标注,单份不构成最终真值;至少还需要一份独立标注 + 裁定",
        "counts": {
            "scenes": len(out_scenes),
            "shots": total_shots,
            **counts,
            "shotsMinusElementCount": total_shots - counts["elementCount"],
            "deterministicNote": "actionElements / cueBlocksAfterContdMerge / elementCount 由缩进版式算出,不含人工判断;"
            "scenes / shots 是人工标注。elementCount 既不是镜头数的上界也不是下界,只是一把参照标尺。",
        },
        "notes": spec["notes"],
        "scenes": out_scenes,
        "disputed": spec["disputed"],
    }
    return doc, errors


METHOD = {
    "schema": "breakdown-eval/gold/scene/method/v1",
    "dimension": "scene-and-shot-boundary",
    "question": "这一集分成几场?每场大致哪几句话?每场该切成几个镜头?判断依据是时空是否变化、机位是否必须变。",
    "annotator": {
        "id": "scene-annotator-A",
        "kind": "llm",
        "model": "claude-opus-5",
        "independence": "只读逐集正文标注,全程未调用平台拆解功能,未参考任何模型拆解结果",
        "inputSource": "zhongwen-shortdrama-local-data/breakdown-eval/episodes/*.txt",
    },
    "status": "single-annotator-draft",
    "whyNotGroundTruthYet": "一份标注就是一个人的读法。场边界这一层争议小(有场次标记行兜底),"
    "镜头数这一层争议大,必须再来一份独立标注做裁定,分歧留档后才配当真值。",
    "sceneRules": {
        "S1_SLUGLINE": "遇到场次标记行(INT./EXT./I/E. 开头)就开新场。这一层是确定性的,和 facts.json 的 scene_heading_lines 逐条对齐。",
        "S2_NO_IMPLICIT_SPLIT": "没有场次标记行的地方一律不新开场,哪怕场内有人进出、有时间流逝。"
        "本测试集 10 集里没有找到必须隐式切场的地方。",
        "S3_TRANSITION_BELONGS_TO_OUTGOING": "转场行(CUT TO BLACK. / BACK TO PRESENT:)归上一场收尾,不单算一场也不单算一镜。",
        "S4_GROUP": "闪回、交叉剪辑、蒙太奇用 group 字段标注,不改变场的条数。",
        "sameSluglineNotMerged": "同名标记行不合并。idb EP1 的客厅出现两次但中间隔了七天(L105 的 SUPER 明写),"
        "合并会错并,所以一律按标记行条数算。",
    },
    "shotRules": {
        "principle": "算的是「最少必须切几次机位」,不是导演的分镜偏好。每一镜都要能说出是哪条规则逼出来的。",
        "NEW_SCENE": "每场的第一镜。",
        "SPEAKER": "说话人换了,给一个偏向说话人的机位。一个角色名下的连续台词算一镜。",
        "CONTD_MERGE": "紧挨着的同一个人的 (CONT'D) 续说,中间没有动作,并成一镜。",
        "MERGE_PREBEAT": "某个动作段只是紧接着开口的那个人的准备/反应,且机位不变,就并进他那一镜。",
        "REACTION": "正文点名了不说话的人的反应,需要一个反应镜头。",
        "INSERT": "有一件东西必须看清(手机来电显示、照片、匕首、拉链、血迹),大景里看不清,给插入镜头。",
        "SPATIAL_MOVE": "有人进画、出画,或移到场内另一处,机位必须重新找。",
        "SCALE_CHANGE": "一个节拍需要明显不同的景别才成立(耳光、踢击、锤子落下、变身完成)。",
        "ACTION_BEAT": "一段独立的动作节拍,不属于上面任何一类的兜底。",
        "VFX": "正文写了 VFX: 的视觉特效节拍,单独一镜。",
        "VO_BLOCK": "旁白/画外独白自成一段、没有伴随动作时,单独一镜(通常是一个持续画面)。",
        "OS_VOICE": "画外音说话人换了,但画面留在听的人身上,不切镜。",
        "notAShot": [
            "括号提示(表演提示)",
            "只有声音没有画面的 SFX 行",
            "对上一句的修辞性补充(如「Pure, lethal sex appeal.」)",
            "转场行、SUPER 字幕(叠在所在镜头上)",
        ],
    },
    "evidenceContract": {
        "anchor": "每一镜带 lineStart/lineEnd(.txt 的 1 起行号)+ anchor{line,col,len}(判断依据落在正文的哪几个字)",
        "whyNotQuotes": "本仓不存剧本正文。实测若每镜存一小段原文,合计会把两部剧 26.8% 的正文抄进 git。"
        "跑 build_scene_gold.py show 可以在本机还原成带原文的复核稿,渲染结果写数据区不落仓。",
        "verified": "生成脚本逐条回查 .txt:输入 sha256 一致、锚点落在声明行范围内且切得出有效正文、"
        "镜头顺序与正文字符顺序一致、场内每行非空正文都被覆盖、场次标记行与 facts.json 一致。任一条不过就不出文件。",
        "sameLineShots": "idb 是 PDF 硬折行,一个「段落」里常含 3-5 个节拍,所以允许多个镜头共用一个行号,靠锚点列位区分。",
    },
    "scoringHints": {
        "twoLayers": "场边界和镜头数分开算。场边界基本是确定性的(标记行),镜头数是判断,别混成一个分数。",
        "sceneMetric": "场边界建议按 headingLine 集合算精确率/召回率,允许 disputed 里两种读法都判对。",
        "shotMetric": "镜头数别用精确相等判对错。建议用行号区间的重叠(IoU >= 0.5)做匹配后算精确率/召回率,"
        "再单独报一个粒度比值 系统镜数 / 标注镜数 —— 前者衡量切在不在正确的位置,后者衡量粒度偏碎还是偏粗。",
        "elementCountIsNotABound": "counts.elementCount 是版式算出的段落级元素数,不是镜头数的上下界。"
        "实测 idb-01 的人工镜数比它高 15,bdlw-03 比它低 7。拿它当第三条参照线,别当容差带边界。",
        "elasticScenes": "group=montage 的场(bdlw-07 S2)镜数本来就可长可短,建议只判场边界不判镜数。",
        "crossScriptWarning": "idb 的动作元素数被 PDF 折行合并压低了,同长度下比 bdlw 少。"
        "两部剧分开看,别跨剧本直接比镜头密度绝对值。",
        "perEpisodeFirst": "每集单独算再看分布。集长差 4.7 倍,只报一个平均值会被长集主导。",
        "disputedHandling": "disputed 里的条目建议两种读法都判对,或整条排除;不要单选一种当唯一正确答案。",
    },
}


def load_facts() -> dict:
    facts = json.loads((DATA_DIR / "facts.json").read_text(encoding="utf-8"))
    out = {}
    for sc in facts["scripts"]:
        for ep in sc["episodes"]:
            if ep["text_file"]:
                out[(sc["id"], ep["episode"])] = ep
    return out


def render_review(ep_id: str, doc: dict) -> str:
    """把锚点还原成带原文的人工复核稿。只在本机数据区落地,不进仓。"""
    lines = load_lines(DATA_DIR / "episodes" / f"{ep_id}.txt")
    buf = [f"# {ep_id} 场次/镜头边界 人工复核稿", ""]
    buf.append(f"场 {doc['counts']['scenes']} / 镜 {doc['counts']['shots']} / 段落元素 {doc['counts']['elementCount']}")
    buf.append("")
    for sc in doc["scenes"]:
        buf.append(f"## {sc['sceneId']}  L{sc['lineStart']}-{sc['lineEnd']}  {sc['heading']}")
        buf.append(f"   规则 {sc['boundaryRule']} / group {sc['group']} / 置信 {sc['confidence']}")
        for sh in sc["shots"]:
            frag = resolve(lines, sh["anchor"]).strip()
            note = f"   « {sh['note']}" if sh.get("note") else ""
            buf.append(
                f"   {sh['order']:>2}. L{sh['lineStart']}-{sh['lineEnd']:<3} "
                f"[{sh['framingIntent']:<8}] {sh['cutTrigger']:<26} {frag}{note}"
            )
        buf.append("")
    if doc["disputed"]:
        buf.append("## 存疑")
        for d in doc["disputed"]:
            buf.append(f"- {d['id']} ({d['scope']}) {d['anchor']}")
            buf.append(f"  A: {d['readingA']}")
            buf.append(f"  B: {d['readingB']}")
            buf.append(f"  影响: {d['impact']}")
            buf.append(f"  倾向: {d['lean']}")
        buf.append("")
    return "\n".join(buf)


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "build"
    facts = load_facts()
    all_errors: list[str] = []
    docs = {}
    for ep_id, spec in ANNOTATION.items():
        doc, errors = build_episode(ep_id, spec, facts)
        docs[ep_id] = doc
        all_errors.extend(errors)

    if all_errors:
        print("校验不通过,没有写出任何文件:", file=sys.stderr)
        for e in all_errors:
            print("  -", e, file=sys.stderr)
        return 1

    if mode == "check":
        for ep_id, doc in docs.items():
            on_disk = OUT_DIR / f"{ep_id}.json"
            if not on_disk.exists():
                print(f"缺文件: {on_disk}", file=sys.stderr)
                return 1
            if json.loads(on_disk.read_text(encoding="utf-8")) != doc:
                print(f"磁盘上的 {ep_id}.json 与标注表不一致", file=sys.stderr)
                return 1
        print("check 通过:锚点、顺序、覆盖、场次标记行、输入 sha256、磁盘内容全部对得上")
        return 0

    if mode == "show":
        REVIEW_DIR.mkdir(parents=True, exist_ok=True)
        for ep_id, doc in docs.items():
            (REVIEW_DIR / f"{ep_id}.txt").write_text(render_review(ep_id, doc), encoding="utf-8")
        print(f"复核稿已写到本机数据区(不进仓): {REVIEW_DIR}")
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "_method.json").write_text(
        json.dumps(METHOD, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    t_scenes = t_shots = t_elem = 0
    for ep_id, doc in docs.items():
        (OUT_DIR / f"{ep_id}.json").write_text(
            json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        c = doc["counts"]
        t_scenes += c["scenes"]
        t_shots += c["shots"]
        t_elem += c["elementCount"]
        print(
            f"{ep_id}: 场 {c['scenes']}  镜 {c['shots']}  段落元素 {c['elementCount']}  "
            f"差 {c['shotsMinusElementCount']:+d}  存疑 {len(doc['disputed'])}"
        )
    print(f"合计: 场 {t_scenes}  镜 {t_shots}  段落元素 {t_elem}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
