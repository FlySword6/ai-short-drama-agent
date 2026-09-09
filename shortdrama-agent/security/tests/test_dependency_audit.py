from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from subprocess import TimeoutExpired
from unittest.mock import patch

from security.dependency_audit import (
    INVENTORY_FILE_NAME,
    audit_command,
    main,
    prepare_audit_plan,
    requirement_groups,
    run_audit,
    vulnerability_count,
)


class DependencyAuditTest(unittest.TestCase):
    def test_duplicate_nested_requirement_files_share_one_audit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for relative in ("one", "nested/services/two"):
                component = root / relative
                component.mkdir(parents=True)
                (component / "requirements.txt").write_text(
                    "sample-package==1.2.3\n", encoding="utf-8"
                )

            groups = requirement_groups(root)

            self.assertEqual(1, len(groups))
            self.assertEqual(2, len(groups[0][1]))
            self.assertIn(
                root / "nested/services/two/requirements.txt",
                groups[0][1],
            )

    def test_relative_include_files_in_different_directories_do_not_dedupe(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            for name in ("one", "two"):
                component = root / name
                component.mkdir()
                (component / "requirements.txt").write_text(
                    "-r base.txt\n", encoding="utf-8"
                )

            groups = requirement_groups(root)

            self.assertEqual(2, len(groups))

    def test_pyproject_only_nested_service_is_not_hidden_by_requirements(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            requirements_service = root / "requirements-service"
            requirements_service.mkdir()
            (requirements_service / "requirements.txt").write_text(
                "first-package==1.0.0\n", encoding="utf-8"
            )
            pyproject_service = root / "nested/pyproject-service"
            pyproject_service.mkdir(parents=True)
            (pyproject_service / "pyproject.toml").write_text(
                """
[project]
name = "nested-service"
version = "0.1.0"
dependencies = ["second-package==2.0.0"]
""".lstrip(),
                encoding="utf-8",
            )

            plan = prepare_audit_plan(root, root / "reports")

            self.assertFalse(plan.errors)
            self.assertEqual(2, len(plan.sources))
            self.assertEqual(
                {
                    "requirements-service/requirements.txt",
                    "nested/pyproject-service/pyproject.toml",
                },
                {
                    source.path.relative_to(root).as_posix()
                    for source in plan.sources
                },
            )
            self.assertEqual(2, len(plan.groups))

    def test_identical_pyproject_dependencies_are_grouped_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in ("one", "nested/two"):
                component = root / relative
                component.mkdir(parents=True)
                (component / "pyproject.toml").write_text(
                    """
[project]
name = "sample"
version = "0.1.0"
dependencies = ["sample-package==1.2.3"]
""".lstrip(),
                    encoding="utf-8",
                )

            plan = prepare_audit_plan(root, root / "reports")

            self.assertFalse(plan.errors)
            self.assertEqual(2, len(plan.sources))
            self.assertEqual(1, len(plan.groups))
            self.assertEqual(2, len(plan.groups[0].sources))

    def test_pyproject_optional_dependencies_are_conservatively_audited(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "service"
            project.mkdir()
            (project / "pyproject.toml").write_text(
                """
[project]
name = "sample"
version = "0.1.0"
dependencies = ["core-package==1.0.0"]

[project.optional-dependencies]
media = ["media-package==2.0.0"]
""".lstrip(),
                encoding="utf-8",
            )

            plan = prepare_audit_plan(root, root / "reports")

            self.assertFalse(plan.errors)
            self.assertEqual(2, plan.sources[0].dependency_count)
            generated = plan.groups[0].audit_input.read_text(encoding="utf-8")
            self.assertIn("core-package==1.0.0", generated)
            self.assertIn("media-package==2.0.0", generated)

    def test_uv_lock_audits_exact_registry_versions_and_skips_local_root(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "service"
            project.mkdir()
            (project / "pyproject.toml").write_text(
                """
[project]
name = "sample-service"
version = "0.1.0"
dependencies = ["sample-package>=1"]
""".lstrip(),
                encoding="utf-8",
            )
            (project / "uv.lock").write_text(
                """
version = 1

[[package]]
name = "sample-service"
version = "0.1.0"
source = { virtual = "." }

[[package]]
name = "sample-package"
version = "1.2.3"
source = { registry = "https://example.invalid/simple" }
""".lstrip(),
                encoding="utf-8",
            )

            plan = prepare_audit_plan(root, root / "reports")

            self.assertFalse(plan.errors)
            lock_source = next(
                source for source in plan.sources if source.kind == "uv-lock"
            )
            self.assertEqual(1, lock_source.dependency_count)
            lock_group = next(
                group
                for group in plan.groups
                if project.resolve() / "uv.lock" in group.sources
            )
            self.assertTrue(lock_group.no_deps)
            generated = lock_group.audit_input.read_text(encoding="utf-8")
            self.assertEqual("sample-package==1.2.3\n", generated)
            self.assertNotIn("sample-service", generated)

    def test_sha_pinned_vcs_dependency_is_inventoried_not_audited(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "service"
            project.mkdir()
            (project / "pyproject.toml").write_text(
                """
[project]
name = "sample-service"
version = "0.1.0"
dependencies = [
  "fastapi>=0.115,<1",
  "shortdrama-cli @ git+https://github.com/col-shortdrama/zhongwen-shortdrama-cli.git@98d217c0ad08bd3728a4a67082908c3523f5b83c",
]
""".lstrip(),
                encoding="utf-8",
            )

            plan = prepare_audit_plan(root, root / "reports")

            self.assertFalse(plan.errors)
            source = plan.sources[0]
            self.assertEqual(1, source.dependency_count)
            self.assertEqual(
                (
                    "shortdrama-cli @ git+https://github.com/col-shortdrama/"
                    "zhongwen-shortdrama-cli.git@"
                    "98d217c0ad08bd3728a4a67082908c3523f5b83c",
                ),
                source.vcs_pinned,
            )
            generated = plan.groups[0].audit_input.read_text(encoding="utf-8")
            self.assertIn("fastapi", generated)
            self.assertNotIn("git+", generated)

    def test_unpinned_vcs_dependency_still_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "service"
            project.mkdir()
            (project / "pyproject.toml").write_text(
                """
[project]
name = "sample-service"
version = "0.1.0"
dependencies = [
  "shortdrama-cli @ git+https://github.com/col-shortdrama/zhongwen-shortdrama-cli.git@main",
]
""".lstrip(),
                encoding="utf-8",
            )

            plan = prepare_audit_plan(root, root / "reports")

            self.assertEqual(
                {"pyproject_dependencies_unsupported"},
                {error.code for error in plan.errors},
            )

    def test_dynamic_pyproject_dependencies_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "service"
            project.mkdir()
            (project / "pyproject.toml").write_text(
                """
[project]
name = "sample"
version = "0.1.0"
dynamic = ["dependencies"]
""".lstrip(),
                encoding="utf-8",
            )

            plan = prepare_audit_plan(root, root / "reports")

            self.assertEqual(
                ["pyproject_dynamic_dependencies"],
                [error.code for error in plan.errors],
            )
            inventory = json.loads(
                plan.inventory_path.read_text(encoding="utf-8")
            )
            self.assertEqual("blocked", inventory["status"])

    def test_missing_dependency_manifests_fail_closed_in_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            plan = prepare_audit_plan(root, root / "reports")

            self.assertEqual(
                ["no_dependency_manifests_found"],
                [error.code for error in plan.errors],
            )
            inventory = json.loads(
                plan.inventory_path.read_text(encoding="utf-8")
            )
            self.assertEqual("blocked", inventory["status"])

    def test_pyproject_direct_reference_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "service"
            project.mkdir()
            (project / "pyproject.toml").write_text(
                """
[project]
name = "sample"
version = "0.1.0"
dependencies = ["internal-package@https://example.invalid/archive.whl"]
""".lstrip(),
                encoding="utf-8",
            )

            plan = prepare_audit_plan(root, root / "reports")

            self.assertEqual(
                ["pyproject_dependencies_unsupported"],
                [error.code for error in plan.errors],
            )

    def test_mixed_non_pep621_dependency_layout_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "service"
            project.mkdir()
            (project / "pyproject.toml").write_text(
                """
[project]
name = "sample"
version = "0.1.0"
dependencies = ["sample-package==1.2.3"]

[tool.poetry.dependencies]
python = "^3.12"
another-package = "^4"
""".lstrip(),
                encoding="utf-8",
            )

            plan = prepare_audit_plan(root, root / "reports")

            self.assertEqual(
                ["pyproject_mixed_dependency_layouts"],
                [error.code for error in plan.errors],
            )

    @patch("security.dependency_audit.run_audit")
    def test_unsupported_lockfile_fails_before_network_audit(
        self,
        run_audit_mock,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "service"
            project.mkdir()
            (project / "pyproject.toml").write_text(
                """
[project]
name = "sample"
version = "0.1.0"
dependencies = ["sample-package==1.2.3"]
""".lstrip(),
                encoding="utf-8",
            )
            (project / "poetry.lock").write_text(
                "[[package]]\nname = \"sample-package\"\nversion = \"1.2.3\"\n",
                encoding="utf-8",
            )
            report_dir = root / "reports"

            with redirect_stdout(io.StringIO()):
                exit_code = main(
                    [
                        "--root",
                        str(root),
                        "--report-dir",
                        str(report_dir),
                    ]
                )

            self.assertEqual(1, exit_code)
            run_audit_mock.assert_not_called()
            inventory = json.loads(
                (report_dir / INVENTORY_FILE_NAME).read_text(encoding="utf-8")
            )
            self.assertEqual("blocked", inventory["status"])
            self.assertEqual(
                "lockfile_exporter_not_supported",
                inventory["errors"][0]["code"],
            )

    @patch("security.dependency_audit.run_audit")
    def test_ready_plan_audits_each_unique_group_once(
        self,
        run_audit_mock,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in ("one", "nested/two"):
                project = root / relative
                project.mkdir(parents=True)
                (project / "requirements.txt").write_text(
                    "sample-package==1.2.3\n", encoding="utf-8"
                )
            report_dir = root / "reports"

            def successful_audit(
                requirement,
                report,
                timeout_seconds,
                *,
                cwd=None,
                no_deps=False,
            ):
                del requirement, timeout_seconds, cwd, no_deps
                report.write_text(
                    json.dumps({"vulnerabilities": []}),
                    encoding="utf-8",
                )
                return 0

            run_audit_mock.side_effect = successful_audit

            with redirect_stdout(io.StringIO()):
                exit_code = main(
                    [
                        "--root",
                        str(root),
                        "--report-dir",
                        str(report_dir),
                    ]
                )

            self.assertEqual(0, exit_code)
            self.assertEqual(1, run_audit_mock.call_count)
            inventory = json.loads(
                (report_dir / INVENTORY_FILE_NAME).read_text(encoding="utf-8")
            )
            self.assertEqual("ready", inventory["status"])
            self.assertEqual(1, len(inventory["audit_groups"]))

    def test_inventory_does_not_copy_dependency_values(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project = root / "service"
            project.mkdir()
            dependency = "private-internal-name==9.9.9"
            (project / "pyproject.toml").write_text(
                f"""
[project]
name = "sample"
version = "0.1.0"
dependencies = ["{dependency}"]
""".lstrip(),
                encoding="utf-8",
            )

            plan = prepare_audit_plan(root, root / "reports")

            inventory_text = plan.inventory_path.read_text(encoding="utf-8")
            self.assertNotIn(dependency, inventory_text)
            self.assertNotIn("private-internal-name", inventory_text)

    def test_cyclonedx_vulnerability_count(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "report.json"
            report.write_text(
                json.dumps({"vulnerabilities": [{"id": "UNIT-1"}]}),
                encoding="utf-8",
            )
            self.assertEqual(1, vulnerability_count(report))

    def test_command_uses_cyclonedx_and_strict_mode(self) -> None:
        command = audit_command(
            Path("component/requirements.txt"), Path("report.json")
        )
        self.assertIn("cyclonedx-json", command)
        self.assertIn("--strict", command)
        self.assertNotIn("shell=True", command)

    def test_locked_command_disables_dependency_resolution(self) -> None:
        command = audit_command(
            Path("component/locked-requirements.txt"),
            Path("report.json"),
            no_deps=True,
        )

        self.assertIn("--no-deps", command)

    @patch("security.dependency_audit.subprocess.run")
    def test_group_timeout_fails_without_hanging(self, run) -> None:
        run.side_effect = TimeoutExpired(cmd=["pip-audit"], timeout=7)

        result = run_audit(
            Path("component/requirements.txt"),
            Path("report.json"),
            timeout_seconds=7,
        )

        self.assertIsNone(result)
        self.assertEqual(7, run.call_args.kwargs["timeout"])


if __name__ == "__main__":
    unittest.main()
