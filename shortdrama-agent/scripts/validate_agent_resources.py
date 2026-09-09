#!/usr/bin/env python3
"""Offline contract validation for the V0.3.0 Pi resource package."""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "agent_resources"
CLI_CLIENT_COMMIT = "98d217c0ad08bd3728a4a67082908c3523f5b83c"
EXPECTED_TOOLS = {
    "shortdrama_capabilities",
    "shortdrama_project_list",
    "shortdrama_project_get",
    "shortdrama_episode_list",
    "shortdrama_episode_get",
    "shortdrama_scene_list",
    "shortdrama_scene_get",
    "shortdrama_shot_list",
    "shortdrama_shot_get",
    "shortdrama_script_versions",
    "shortdrama_script_paste",
    "shortdrama_script_breakdown",
    "shortdrama_script_breakdown_status",
    "shortdrama_script_breakdown_resume",
    "shortdrama_asset_search",
    "shortdrama_asset_get",
    "shortdrama_asset_registration_schema",
    "shortdrama_asset_register_candidate",
    "shortdrama_asset_registration_status",
    "shortdrama_project_asset_add",
    "shortdrama_project_asset_list",
}
RECEIPT_FIELDS = {
    "request_id", "tool", "status", "permissions_checked", "cost_status", "reversible", "timestamp"
}


def load_json(path: Path) -> object:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def executable_tool_names(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(target, ast.Name) and target.id == "TOOL_SPECS" for target in node.targets):
            continue
        if not isinstance(node.value, (ast.Tuple, ast.List)):
            return set()
        return {
            element.args[0].value
            for element in node.value.elts
            if (
                isinstance(element, ast.Call)
                and isinstance(element.func, ast.Name)
                and element.func.id == "ToolSpec"
                and element.args
                and isinstance(element.args[0], ast.Constant)
                and isinstance(element.args[0].value, str)
            )
        }
    return set()


def main() -> int:
    errors: list[str] = []
    manifest = load_json(PACKAGE / "manifest.json")
    if not isinstance(manifest, dict):
        errors.append("manifest must be an object")
        manifest = {}

    if manifest.get("version") != "0.3.0":
        errors.append("manifest version must be 0.3.0")
    if manifest.get("production_runtime") != "main_openapi_only":
        errors.append("production_runtime must be main_openapi_only")
    cli_client = manifest.get("cli_client", {})
    if not isinstance(cli_client, dict) or cli_client.get("commit") != CLI_CLIENT_COMMIT:
        errors.append("CLI client dependency must be pinned to the approved commit")
    allowed_imports = set(cli_client.get("allowed_imports", [])) if isinstance(cli_client, dict) else set()
    if allowed_imports != {
        "shortdrama_cli.server_api.client",
        "shortdrama_cli.api.errors",
    }:
        errors.append("manifest must allow exactly the two approved CLI imports")
    boundary = manifest.get("fact_boundary", {})
    if not isinstance(boundary, dict) or boundary.get("business_facts_owner") != "main":
        errors.append("business facts must remain owned by main")

    receipt = manifest.get("receipt_contract", {})
    fields = set(receipt.get("required_fields", [])) if isinstance(receipt, dict) else set()
    if not RECEIPT_FIELDS.issubset(fields):
        errors.append("receipt contract is missing required fields")

    resources = manifest.get("resources", [])
    if not isinstance(resources, list):
        errors.append("resources must be a list")
        resources = []
    ids = {entry.get("id") for entry in resources if isinstance(entry, dict)}
    if ids != EXPECTED_TOOLS:
        errors.append("manifest must declare exactly the approved main-chain tools")
    for entry in resources:
        if not isinstance(entry, dict):
            continue
        missing = {"version", "depends_on", "input", "output", "permission", "cost", "reversal", "receipt"} - set(entry)
        if missing:
            errors.append(f"{entry.get('id', '<unknown>')} missing {sorted(missing)}")

    tools = load_json(PACKAGE / "pi" / "schemas" / "tools.json")
    tool_names = {tool.get("name") for tool in tools.get("tools", [])} if isinstance(tools, dict) else set()
    if tool_names != EXPECTED_TOOLS:
        errors.append("schema tools do not match manifest")
    invalid_names = sorted(
        name for name in tool_names
        if not isinstance(name, str) or re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name) is None
    )
    if invalid_names:
        errors.append(f"Pi-incompatible tool names: {invalid_names}")
    if not isinstance(tools, dict) or tools.get("cli_client_commit") != CLI_CLIENT_COMMIT:
        errors.append("schema snapshot must record the approved CLI client commit")
    fixture = load_json(PACKAGE / "pi" / "fixtures" / "offline-contract.json")
    cases = fixture.get("cases", []) if isinstance(fixture, dict) else []
    fixture_tools = {case.get("tool") for case in cases if isinstance(case, dict)}
    if fixture_tools != EXPECTED_TOOLS:
        errors.append("offline fixture does not cover every approved tool")
    if not (PACKAGE / "pi" / "skills" / "shortdrama-main-chain" / "SKILL.md").is_file():
        errors.append("Pi skill is missing")
    if not (PACKAGE / "pi" / "prompts" / "shortdrama-main-chain.md").is_file():
        errors.append("Pi prompt is missing")

    wrapper = ROOT / "pi-http-wrapper"
    pyproject = (wrapper / "pyproject.toml").read_text(encoding="utf-8")
    dependency = (
        "shortdrama-cli @ "
        "git+https://github.com/col-shortdrama/zhongwen-shortdrama-cli.git@"
        f"{CLI_CLIENT_COMMIT}"
    )
    if dependency not in pyproject:
        errors.append("pyproject must pin shortdrama-cli to the approved commit")

    adapter_path = wrapper / "src" / "pi_http_wrapper" / "main_chain.py"
    if executable_tool_names(adapter_path) != EXPECTED_TOOLS:
        errors.append("executable adapter registry must match manifest and generated schema")
    adapter_imports = imported_modules(adapter_path)
    cli_imports = {name for name in adapter_imports if name.startswith("shortdrama_cli")}
    if cli_imports != {
        "shortdrama_cli.server_api.client",
        "shortdrama_cli.api.errors",
    }:
        errors.append("adapter must import exactly the approved CLI client and error modules")
    if any(name.startswith("shortdrama_cli.cli") or name == "shortdrama_cli.main" for name in adapter_imports):
        errors.append("adapter must not import the Typer command layer")
    if "class UrlLibTransport" in adapter_path.read_text(encoding="utf-8"):
        errors.append("adapter must not copy the CLI HTTP transport source")

    domain_path = wrapper / "src" / "pi_http_wrapper" / "main_chain_domain.py"
    domain_source = domain_path.read_text(encoding="utf-8")
    domain_imports = imported_modules(domain_path)
    if any(name.startswith(("pi_http_wrapper", "shortdrama_cli")) for name in domain_imports):
        errors.append("name-resolution domain module must have zero Pi and CLI dependencies")
    if "move this module as a whole into CLI core" not in domain_source:
        errors.append("name-resolution domain module must retain the CLI-core migration note")

    if errors:
        print("FAIL")
        print("\n".join(f"- {error}" for error in errors))
        return 1
    print("PASS: agent resources manifest, Pi package, schema, and offline fixture are coherent")
    return 0


def imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    return modules


if __name__ == "__main__":
    sys.exit(main())
