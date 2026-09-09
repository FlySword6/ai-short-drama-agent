from __future__ import annotations

import subprocess
import sys
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class AgentResourcesContractTests(unittest.TestCase):
    def test_manifest_and_pi_package_validate_offline(self) -> None:
        result = subprocess.run(
            [sys.executable, "scripts/validate_agent_resources.py"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_research_runtimes_are_gated(self) -> None:
        result = subprocess.run(
            [sys.executable, "scripts/check_no_second_runtime.py"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
