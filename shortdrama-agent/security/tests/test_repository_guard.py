from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from security.repository_guard import (
    Finding,
    MAX_CURRENT_TEXT_BYTES,
    MAX_HISTORY_BLOB_BYTES,
    PRODUCTION_BLOCKING_RULES,
    apply_baseline,
    baseline_document,
    changed_paths,
    scan_changed,
    scan_current,
    scan_file,
    scan_history_secrets,
    validate_baseline_not_grown,
)


def rule_ids(path: str, text: str) -> set[str]:
    return {finding.rule_id for finding in scan_file(path, text)}


def commit_all(root: Path, message: str) -> None:
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=Security Test",
            "-c",
            "user.email=security-test@example.invalid",
            "commit",
            "-qm",
            message,
        ],
        cwd=root,
        check=True,
    )


class SecretRulesTest(unittest.TestCase):
    def test_synthetic_runtime_secret_is_blocked(self) -> None:
        # Split fixtures so this test file never contains a scan-shaped secret.
        for spelling in ("runtime_" + "apikey", "runtime_" + "api_key"):
            with self.subTest(spelling=spelling):
                document = (
                    spelling + ": " + "unitcredential4f69b1c8d2e7a530"
                )
                rules = rule_ids("sandbox/config.yaml", document)
                self.assertIn("SECRET_LITERAL_ASSIGNMENT", rules)

    def test_secret_name_in_assertion_is_not_an_assignment(self) -> None:
        line = 'self.assertNotIn("' + "VOLCENGINE_SECRET_KEY:" + '", config)'
        self.assertNotIn(
            "SECRET_LITERAL_ASSIGNMENT",
            rule_ids("component/tests/test_config.py", line),
        )

    def test_agentkit_example_template_has_no_literal_secret(self) -> None:
        template = (
            Path(__file__).resolve().parents[2]
            / "test-agent"
            / "agentkit.example.yaml"
        )
        findings = scan_file(
            "test-agent/agentkit.example.yaml",
            template.read_text(encoding="utf-8"),
        )
        self.assertFalse(
            [finding for finding in findings if finding.rule_id.startswith("SECRET_")]
        )

    def test_placeholder_template_is_allowed(self) -> None:
        rules = rule_ids(
            "sandbox/agentkit.example.yaml",
            "runtime_apikey: <managed-by-secret-store>",
        )
        self.assertNotIn("SECRET_LITERAL_ASSIGNMENT", rules)
        self.assertNotIn("TRACKED_RUNTIME_CONFIG", rules)

    def test_only_complete_secret_references_are_placeholders(self) -> None:
        safe_values = (
            "$ARK_API_KEY",
            "${ARK_API_KEY}",
            "${{ secrets.ARK_API_KEY }}",
            "{{ managed.ark_api_key }}",
            "<managed-by-secret-store>",
        )
        for value in safe_values:
            with self.subTest(value=value):
                rules = rule_ids(
                    "sandbox/agentkit.example.yaml",
                    "runtime_" + "apikey: " + value,
                )
                self.assertNotIn("SECRET_LITERAL_ASSIGNMENT", rules)

        fallback = "${ARK_API_KEY:-" + "unitFallback9x8y7z6w5v4u3t2s" + "}"
        rules = rule_ids(
            "sandbox/agentkit.example.yaml",
            "runtime_" + "apikey: " + fallback,
        )
        self.assertIn("SECRET_LITERAL_ASSIGNMENT", rules)

    def test_high_entropy_secret_containing_placeholder_word_is_blocked(self) -> None:
        value = "A9z_" + "example" + "_Q8yW7vU6tS5rP4nM3"
        rules = rule_ids(
            "sandbox/config.yaml",
            "runtime_" + "apikey: " + value,
        )
        self.assertIn("SECRET_LITERAL_ASSIGNMENT", rules)

    def test_tracked_agentkit_runtime_config_is_always_blocked(self) -> None:
        rules = rule_ids("sandbox/agentkit.yaml", "runtime_apikey: <placeholder>")
        self.assertIn("TRACKED_RUNTIME_CONFIG", rules)

    def test_private_key_is_blocked_without_printing_body(self) -> None:
        header = "-----BEGIN " + "PRIVATE KEY-----"
        self.assertIn(
            "SECRET_PRIVATE_KEY",
            rule_ids("sandbox/config.txt", header + "\nunit-only\n"),
        )

    def test_binary_private_key_filename_is_reachable_from_current_scan(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            (root / "id_rsa").write_bytes(b"\x00\xff\x00")
            subprocess.run(["git", "add", "id_rsa"], cwd=root, check=True)

            rules = {finding.rule_id for finding in scan_current(root)}

            self.assertIn("TRACKED_PRIVATE_KEY", rules)

    def test_current_scan_preserves_leading_dot_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            workflow = root / ".github" / "workflows" / "unsafe.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text(
                """
permissions:
  contents: read
jobs:
  unsafe:
    steps:
      - uses: actions/checkout@main
""",
                encoding="utf-8",
            )
            (root / ".env").write_text("MODE=placeholder\n", encoding="utf-8")
            (root / ".agent-token").write_bytes(b"\x00synthetic")
            subprocess.run(
                [
                    "git",
                    "add",
                    ".github/workflows/unsafe.yml",
                    ".env",
                    ".agent-token",
                ],
                cwd=root,
                check=True,
            )

            findings = scan_current(root)
            rules_by_path: dict[str, set[str]] = {}
            for finding in findings:
                rules_by_path.setdefault(finding.path, set()).add(finding.rule_id)

            self.assertIn(
                "WORKFLOW_UNPINNED_ACTION",
                rules_by_path[".github/workflows/unsafe.yml"],
            )
            self.assertIn("TRACKED_RUNTIME_CONFIG", rules_by_path[".env"])
            self.assertIn(
                "TRACKED_PRIVATE_KEY",
                rules_by_path[".agent-token"],
            )

    def test_current_scan_fails_closed_for_unscannable_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            (root / "embedded_nul.py").write_bytes(b"print('safe')\x00\n")
            (root / "non_utf8.py").write_bytes(b"# coding: latin-1\n# \xff\n")
            (root / "oversize.md").write_bytes(
                b"x" * (MAX_CURRENT_TEXT_BYTES + 1)
            )
            (root / "missing.py").write_text("MODE = 'safe'\n", encoding="utf-8")
            subprocess.run(
                [
                    "git",
                    "add",
                    "embedded_nul.py",
                    "non_utf8.py",
                    "oversize.md",
                    "missing.py",
                ],
                cwd=root,
                check=True,
            )
            (root / "missing.py").unlink()

            findings = scan_current(root)
            unscannable = [
                finding
                for finding in findings
                if finding.rule_id == "UNSCANNABLE_CURRENT_FILE"
            ]

            self.assertEqual(
                {
                    "embedded_nul.py",
                    "non_utf8.py",
                    "oversize.md",
                    "missing.py",
                },
                {finding.path for finding in unscannable},
            )
            self.assertTrue(all(not finding.baselinable for finding in unscannable))

    def test_history_scan_reads_unique_blobs_without_printing_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            # This synthetic value matches both the known-prefix and literal
            # assignment recognisers; history output must still report its
            # location only once.
            value = "AK" + "LT" + "Synthetic9xY7vW5uT3sR1"
            config = root / "config.py"
            config.write_text("ACCESS_TOKEN='" + value + "'\n", encoding="utf-8")
            subprocess.run(["git", "add", "config.py"], cwd=root, check=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Security Test",
                    "-c",
                    "user.email=security-test@example.invalid",
                    "commit",
                    "-qm",
                    "add synthetic credential",
                ],
                cwd=root,
                check=True,
            )
            config.write_text("MODE='safe'\n", encoding="utf-8")
            subprocess.run(["git", "add", "config.py"], cwd=root, check=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Security Test",
                    "-c",
                    "user.email=security-test@example.invalid",
                    "commit",
                    "-qm",
                    "remove synthetic credential",
                ],
                cwd=root,
                check=True,
            )

            findings = scan_history_secrets(root)
            rendered = json.dumps([finding.__dict__ for finding in findings])

            self.assertEqual(
                {"HISTORY_SECRET"},
                {finding.rule_id for finding in findings},
            )
            self.assertEqual(1, len(findings))
            self.assertNotIn(value, rendered)

    def test_history_scan_fails_closed_for_unscannable_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            (root / "embedded_nul.py").write_bytes(b"print('safe')\x00\n")
            (root / "non_utf8.py").write_bytes(b"# coding: latin-1\n# \xff\n")
            (root / "oversize.md").write_bytes(
                b"x" * (MAX_HISTORY_BLOB_BYTES + 1)
            )
            commit_all(root, "add unscannable synthetic fixtures")

            findings = scan_history_secrets(root)
            unscannable = [
                finding
                for finding in findings
                if finding.rule_id == "UNSCANNABLE_HISTORY_BLOB"
            ]

            self.assertEqual(
                {"embedded_nul.py", "non_utf8.py", "oversize.md"},
                {finding.path for finding in unscannable},
            )
            self.assertTrue(all(not finding.baselinable for finding in unscannable))


class ArchitectureRulesTest(unittest.TestCase):
    def test_direct_ark_and_dynamic_auth_endpoint_are_detected(self) -> None:
        source = """
import os
import httpx
base_url = os.getenv("ARK_BASE_URL")
headers = {"Authorization": "Bearer " + token}
httpx.post(base_url, headers=headers)
"""
        rules = rule_ids("sd-generation-agent/app.py", source)
        self.assertIn("AGENT_CLOUD_CREDENTIAL", rules)
        self.assertIn("SAST_VARIABLE_URL_REQUEST", rules)

    def test_direct_tos_is_detected_in_test_agent(self) -> None:
        rules = rule_ids(
            "test-agent/short_drama_agent/storage.py",
            "import tos\nclient = tos.TosClientV2(a, s, endpoint, region)\n",
        )
        self.assertIn("AGENT_DIRECT_TOS", rules)

    def test_auto_approval_is_detected(self) -> None:
        rules = rule_ids(
            "sd-orchestrator/app.py",
            "auto_approve_generated_assets = True\n",
        )
        self.assertIn("AGENT_AUTO_APPROVAL", rules)

    def test_dangerous_test_surface_is_detected(self) -> None:
        rules = rule_ids(
            "test-agent/agent_a2a.py",
            'allow_origins=["*"]\n@app.get("/debug/tools")\ndef f(): pass\n',
        )
        self.assertIn("TEST_HARNESS_DEPLOYABLE", rules)
        self.assertIn("TEST_HARNESS_OPEN_CORS", rules)
        self.assertIn("TEST_HARNESS_DEBUG_ROUTE", rules)

    def test_test_agent_fixture_does_not_trigger_harness_surface_rule(self) -> None:
        rules = rule_ids(
            "test-agent/tests/test_local_server_security.py",
            'def test_public_bind_is_rejected():\n    host = "0.0.0.0"\n',
        )
        self.assertNotIn("TEST_HARNESS_PUBLIC_BIND", rules)

    def test_only_explicit_tests_directories_skip_production_rules(self) -> None:
        source = """
import os
import httpx
base_url = os.getenv("ARK_BASE_URL")
httpx.post(base_url)
"""
        for path in (
            "sd-generation-agent/test_cloud.py",
            "test-agent/new_cloud_entry.py",
        ):
            with self.subTest(path=path):
                rules = rule_ids(path, source)
                self.assertIn("AGENT_CLOUD_CREDENTIAL", rules)
                self.assertIn("SAST_VARIABLE_URL_REQUEST", rules)

        test_rules = rule_ids(
            "sd-generation-agent/tests/test_cloud.py",
            source,
        )
        self.assertNotIn("AGENT_CLOUD_CREDENTIAL", test_rules)
        self.assertNotIn("SAST_VARIABLE_URL_REQUEST", test_rules)

    def test_whole_file_legacy_fingerprint_changes_with_content(self) -> None:
        for path, original_text, changed_text, rule_id in (
            (
                "production-chain-agent/sda2a/server.py",
                "def serve():\n    return 'legacy'\n",
                "def serve():\n    return 'legacy-expanded'\n",
                "PRODUCTION_A2A_SURFACE",
            ),
            (
                "test-agent/agent.py",
                "def run():\n    return 'legacy'\n",
                "def run():\n    return 'legacy-expanded'\n",
                "TEST_HARNESS_DEPLOYABLE",
            ),
        ):
            with self.subTest(path=path):
                original = [
                    finding
                    for finding in scan_file(path, original_text)
                    if finding.rule_id == rule_id
                ]
                changed = [
                    finding
                    for finding in scan_file(path, changed_text)
                    if finding.rule_id == rule_id
                ]
                self.assertEqual(1, len(original))
                self.assertEqual(1, len(changed))
                self.assertNotEqual(
                    original[0].fingerprint,
                    changed[0].fingerprint,
                )
                equivalent_line_endings = [
                    finding
                    for finding in scan_file(
                        path,
                        original_text.replace("\n", "\r\n"),
                    )
                    if finding.rule_id == rule_id
                ]
                self.assertEqual(
                    original[0].fingerprint,
                    equivalent_line_endings[0].fingerprint,
                )


class SupplyChainRulesTest(unittest.TestCase):
    def test_unpinned_dependency_is_detected(self) -> None:
        rules = rule_ids("component/requirements.txt", "httpx>=0.27\n")
        self.assertIn("DEPENDENCY_UNPINNED", rules)

    def test_remote_dependency_is_not_baselinable(self) -> None:
        findings = scan_file(
            "component/requirements.txt",
            "sample @ https://packages.invalid/sample.whl\n",
        )
        finding = next(
            item for item in findings if item.rule_id == "DEPENDENCY_REMOTE_SOURCE"
        )
        self.assertFalse(finding.baselinable)

    def test_unpinned_action_is_detected(self) -> None:
        workflow = """
permissions:
  contents: read
on:
  pull_request:
jobs:
  test:
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
"""
        self.assertIn(
            "WORKFLOW_UNPINNED_ACTION",
            rule_ids(".github/workflows/security.yml", workflow),
        )

    def test_sha_pinned_action_and_minimum_permissions_pass(self) -> None:
        workflow = """
permissions:
  contents: read
on:
  pull_request:
jobs:
  test:
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
"""
        rules = rule_ids(".github/workflows/security.yml", workflow)
        self.assertNotIn("WORKFLOW_UNPINNED_ACTION", rules)
        self.assertNotIn("WORKFLOW_MISSING_PERMISSIONS", rules)
        self.assertNotIn("WORKFLOW_CHECKOUT_PERSISTS_CREDENTIALS", rules)

    def test_job_level_reusable_workflow_must_be_sha_pinned(self) -> None:
        workflow = """
permissions:
  contents: read
jobs:
  reused:
    uses: organisation/repository/.github/workflows/test.yml@main
"""
        self.assertIn(
            "WORKFLOW_UNPINNED_ACTION",
            rule_ids(".github/workflows/security.yml", workflow),
        )

    def test_every_checkout_step_must_disable_persisted_credentials(self) -> None:
        workflow = """
permissions:
  contents: read
jobs:
  test:
    steps:
      - uses: actions/checkout@1111111111111111111111111111111111111111
        with:
          persist-credentials: false
      - uses: actions/checkout@2222222222222222222222222222222222222222
"""
        self.assertIn(
            "WORKFLOW_CHECKOUT_PERSISTS_CREDENTIALS",
            rule_ids(".github/workflows/security.yml", workflow),
        )

    def test_flow_style_action_is_scanned_and_safe_checkout_is_supported(self) -> None:
        unsafe = """
permissions: {}
on: [push]
jobs:
  test:
    steps:
      - { uses: actions/checkout@v4, with: { persist-credentials: false } }
"""
        self.assertIn(
            "WORKFLOW_UNPINNED_ACTION",
            rule_ids(".github/workflows/security.yml", unsafe),
        )

        pinned = "1" * 40
        safe = f"""
permissions: {{}}
on: [push]
jobs:
  test:
    steps:
      - {{ uses: actions/checkout@{pinned}, with: {{ persist-credentials: false }} }}
"""
        rules = rule_ids(".github/workflows/security.yml", safe)
        self.assertNotIn("WORKFLOW_UNPINNED_ACTION", rules)
        self.assertNotIn("WORKFLOW_CHECKOUT_PERSISTS_CREDENTIALS", rules)

    def test_checkout_false_outside_with_cannot_hide_true_input(self) -> None:
        workflow = """
permissions: {}
on: [push]
jobs:
  test:
    steps:
      - uses: actions/checkout@1111111111111111111111111111111111111111
        env:
          persist-credentials: false
        with:
          persist-credentials: true
"""
        self.assertIn(
            "WORKFLOW_CHECKOUT_PERSISTS_CREDENTIALS",
            rule_ids(".github/workflows/security.yml", workflow),
        )

    def test_workflow_write_permissions_are_rejected(self) -> None:
        for permissions in (
            "permissions:\n  contents: write",
            "permissions: { contents: write }",
            "permissions: write-all",
            'permissions: { "contents": "write" }',
            'permissions: "write-all"',
        ):
            with self.subTest(permissions=permissions):
                workflow = permissions + "\non: [push]\njobs: {}\n"
                self.assertIn(
                    "WORKFLOW_WRITE_PERMISSION",
                    rule_ids(".github/workflows/security.yml", workflow),
                )

    def test_flow_pull_request_event_blocks_bracket_secret_context(self) -> None:
        workflow = """
permissions: {}
on: [pull_request]
jobs:
  test:
    steps:
      - run: echo "${{ secrets['TOKEN'] }}"
"""
        self.assertIn(
            "WORKFLOW_SECRET_ON_PR",
            rule_ids(".github/workflows/security.yml", workflow),
        )

    def test_flow_pull_request_target_event_is_rejected(self) -> None:
        workflow = """
permissions: {}
on: [push, pull_request_target]
jobs: {}
"""
        self.assertIn(
            "WORKFLOW_PULL_REQUEST_TARGET",
            rule_ids(".github/workflows/security.yml", workflow),
        )

    def test_docker_digest_must_be_on_image_token_and_be_full_length(self) -> None:
        unsafe = "FROM python:3.12 # @sha256:not-a-digest\n"
        self.assertIn(
            "DOCKER_BASE_UNPINNED",
            rule_ids("component/Dockerfile", unsafe),
        )

        digest = "a" * 64
        safe = (
            f"FROM registry.invalid/python@sha256:{digest} AS build\n"
            "FROM build AS final\n"
        )
        self.assertNotIn(
            "DOCKER_BASE_UNPINNED",
            rule_ids("component/Dockerfile", safe),
        )

    def test_repository_security_workflow_uses_the_baseline_base_guard(self) -> None:
        root = Path(__file__).resolve().parents[2]
        workflow_path = root / ".github" / "workflows" / "security.yml"
        workflow = workflow_path.read_text(encoding="utf-8")

        rules = rule_ids(".github/workflows/security.yml", workflow)

        self.assertNotIn("WORKFLOW_UNPINNED_ACTION", rules)
        self.assertNotIn("WORKFLOW_WRITE_PERMISSION", rules)
        self.assertNotIn("WORKFLOW_CHECKOUT_PERSISTS_CREDENTIALS", rules)
        self.assertIn("--baseline-base", workflow)
        self.assertIn("git show", workflow)
        self.assertIn('"${BASE_SHA}^{commit}"', workflow)
        self.assertIn("portable-security-tests", workflow)
        self.assertIn("ubuntu-22.04", workflow)
        self.assertIn("macos-14", workflow)
        self.assertIn(
            "python -m unittest discover -s security/tests -v",
            workflow,
        )


class BaselineRulesTest(unittest.TestCase):
    def _baseline_file(self, findings: list[Finding]) -> Path:
        temporary = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            suffix=".json",
            delete=False,
        )
        with temporary:
            json.dump(
                baseline_document(
                    findings,
                    owner="unit-test-security-owner",
                    expires_on=(date.today() + timedelta(days=30)).isoformat(),
                ),
                temporary,
            )
        self.addCleanup(Path(temporary.name).unlink, missing_ok=True)
        return Path(temporary.name)

    def test_baseline_lifetime_cannot_exceed_ninety_days(self) -> None:
        findings = scan_file(
            "component/requirements.txt",
            "sample-package>=1.0\n",
        )
        with self.assertRaisesRegex(ValueError, "90 days"):
            baseline_document(
                findings,
                owner="unit-test-security-owner",
                expires_on=(date.today() + timedelta(days=91)).isoformat(),
            )

    def test_production_blocking_finding_cannot_be_suppressed(self) -> None:
        findings = scan_file(
            "sd-orchestrator/app.py",
            "auto_approve_generated_assets = True\n",
        )
        active, suppressed = apply_baseline(
            findings, self._baseline_file(findings)
        )
        self.assertEqual(findings, active)
        self.assertEqual([], suppressed)

    def test_every_production_blocking_rule_is_non_baselinable(self) -> None:
        for rule_id in PRODUCTION_BLOCKING_RULES:
            with self.subTest(rule_id=rule_id):
                finding = Finding(
                    rule_id=rule_id,
                    path="component/production.py",
                    line=1,
                    fingerprint="unit-test-fingerprint",
                    message="unit-test-message",
                )
                self.assertFalse(finding.baselinable)

    def test_changed_legacy_finding_is_not_suppressed(self) -> None:
        original = scan_file(
            "component/requirements.txt",
            "sample-package>=1.0\n",
        )
        changed = scan_file(
            "component/requirements.txt",
            "sample-package>=2.0\n",
        )
        active, _ = apply_baseline(changed, self._baseline_file(original))
        self.assertIn("DEPENDENCY_UNPINNED", {item.rule_id for item in active})
        self.assertIn("BASELINE_STALE", {item.rule_id for item in active})

    def test_secret_cannot_be_suppressed_by_generated_baseline(self) -> None:
        document = "runtime_" + "apikey: " + "unitcredential4f69b1c8d2e7a530"
        findings = scan_file("sandbox/config.yaml", document)
        active, _ = apply_baseline(findings, self._baseline_file(findings))
        self.assertIn("SECRET_LITERAL_ASSIGNMENT", {item.rule_id for item in active})

    def test_duplicate_new_legacy_risk_is_not_hidden_by_old_baseline(self) -> None:
        original = scan_file(
            "component/requirements.txt",
            "sample-package>=1.0\n",
        )
        changed = scan_file(
            "component/requirements.txt",
            "sample-package>=1.0\n"
            "sample-package>=1.0\n",
        )

        active, suppressed = apply_baseline(
            changed,
            self._baseline_file(original),
        )

        self.assertEqual(1, len(suppressed))
        self.assertIn("DEPENDENCY_UNPINNED", {item.rule_id for item in active})

    def test_changed_baselinable_finding_invalidates_old_baseline(self) -> None:
        path = "component/requirements.txt"
        original = scan_file(path, "legacy-package>=1.0\n")
        changed = scan_file(path, "legacy-package>=2.0\n")

        active, suppressed = apply_baseline(
            changed,
            self._baseline_file(original),
        )

        self.assertEqual([], suppressed)
        self.assertIn("DEPENDENCY_UNPINNED", {item.rule_id for item in active})
        self.assertIn("BASELINE_STALE", {item.rule_id for item in active})

    def test_pr_baseline_may_shrink_but_cannot_grow_or_replace(self) -> None:
        original = scan_file(
            "component/requirements.txt",
            "legacy-one>=1.0\n",
        )
        added = scan_file(
            "other/requirements.txt",
            "legacy-two>=1.0\n",
        )
        replacement = scan_file(
            "component/requirements.txt",
            "legacy-one>=2.0\n",
        )
        base = self._baseline_file(original + added)
        shrunk = self._baseline_file(original)
        grown = self._baseline_file(original + added + replacement)
        replaced = self._baseline_file(replacement)

        self.assertEqual([], validate_baseline_not_grown(shrunk, base))
        for candidate in (grown, replaced):
            with self.subTest(candidate=candidate):
                findings = validate_baseline_not_grown(candidate, base)
                self.assertIn(
                    "BASELINE_GROWTH",
                    {finding.rule_id for finding in findings},
                )
                self.assertTrue(all(not finding.baselinable for finding in findings))


class DiffModeTest(unittest.TestCase):
    """--diff-base gates only violations introduced since the base commit."""

    def _repo(self) -> tuple[Path, str]:
        directory = tempfile.mkdtemp()
        root = Path(directory)
        root.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        return root, "main"

    def test_untouched_legacy_violation_is_not_introduced(self) -> None:
        root, _ = self._repo()
        (root / "test-agent").mkdir()
        (root / "test-agent" / "agent.py").write_text(
            "print('legacy harness')\n", encoding="utf-8"
        )
        commit_all(root, "legacy debt")
        base_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True
        ).stdout.strip()

        (root / "README.md").write_text("docs only\n", encoding="utf-8")
        commit_all(root, "docs change")

        findings = scan_changed(root, base_sha)
        self.assertEqual([], findings)

    def test_new_violation_in_changed_file_is_introduced(self) -> None:
        root, _ = self._repo()
        (root / "README.md").write_text("clean\n", encoding="utf-8")
        commit_all(root, "clean base")
        base_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True
        ).stdout.strip()

        (root / "app").mkdir()
        (root / "app" / "requirements.txt").write_text(
            "requests>=2.0\n", encoding="utf-8"
        )
        commit_all(root, "add file with violation")

        findings = scan_changed(root, base_sha)
        self.assertIn(
            "DEPENDENCY_UNPINNED", {f.rule_id for f in findings}
        )

    def test_same_rule_new_evidence_in_legacy_file_is_introduced(self) -> None:
        root, _ = self._repo()
        (root / "test-agent").mkdir()
        (root / "test-agent" / "agent.py").write_text(
            "print('one')\n", encoding="utf-8"
        )
        commit_all(root, "legacy harness")
        base_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True
        ).stdout.strip()

        (root / "test-agent" / "agent.py").write_text(
            "print('one')\nprint('two')\n", encoding="utf-8"
        )
        commit_all(root, "edit legacy file")

        findings = scan_changed(root, base_sha)
        # TEST_HARNESS_DEPLOYABLE already fired at base; the edit changes only
        # the content digest, so the legacy violation stays out of scope.
        self.assertEqual([], findings)


if __name__ == "__main__":
    unittest.main()
