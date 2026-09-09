#!/usr/bin/env python3
"""Print the three numbers (total / passed / skipped) from a pytest JUnit XML report.

Issue #5 asks every PR gate run to report 总/过/skip so a reader can tell
"gate is green" apart from "gate ran nothing".
"""

from __future__ import annotations

import os
import sys
import xml.etree.ElementTree as ET


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: summarise-junit.py <junit.xml> <label>", file=sys.stderr)
        return 2

    report_path, label = argv[1], argv[2]

    if not os.path.exists(report_path):
        line = f"{label}: no JUnit report at {report_path} — the test step did not produce one"
        print(line)
        _append_summary(f"- **{label}**: {line}")
        return 1

    root = ET.parse(report_path).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))

    total = sum(int(s.get("tests", 0)) for s in suites)
    skipped = sum(int(s.get("skipped", 0)) for s in suites)
    failures = sum(int(s.get("failures", 0)) for s in suites)
    errors = sum(int(s.get("errors", 0)) for s in suites)
    passed = total - skipped - failures - errors

    line = (
        f"{label}: total={total} passed={passed} skipped={skipped} "
        f"failed={failures} errors={errors}"
    )
    print(line)
    _append_summary(f"- **{label}** — total {total} / passed {passed} / skipped {skipped}"
                    f" / failed {failures} / errors {errors}")

    if total == 0:
        print(f"::error::{label} collected 0 tests — an empty gate is not a green gate")
        return 1
    return 0


def _append_summary(markdown_line: str) -> None:
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return
    with open(summary_path, "a", encoding="utf-8") as handle:
        handle.write(markdown_line + "\n")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
