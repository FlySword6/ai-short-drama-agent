"""Helpers for asserting on what a user reads, not on how a terminal paints it."""

from __future__ import annotations

import re

ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")


def plain(output: str) -> str:
    """Strip terminal escape sequences from CLI output before matching text.

    Rich treats an option name as one token and highlights it, splitting it across
    escape sequences: ``--i-mean-it`` arrives as ``-``, ``-i``, ``-mean-it`` with
    markup between the pieces. Whether that happens depends on the environment —
    CI runners force styling on, developer machines usually leave it off — so any
    assertion against the raw output passes in one place and fails in the other.
    Setting ``NO_COLOR`` is not enough: it drops colour but keeps bold and dim,
    which split the token just the same.
    """

    return ANSI_ESCAPE.sub("", output)
