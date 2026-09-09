import base64
import inspect
import unittest

from shortdrama_cli.api.errors import ApiRequestError

from pi_http_wrapper.contract import ToolCall
from pi_http_wrapper.main_chain import CLI_CLIENT_COMMIT, MainChainAdapter


PROJECT_ID = "11111111-1111-4111-8111-111111111111"
EPISODE_ID = "22222222-2222-4222-8222-222222222222"
ASSET_ID = "33333333-3333-4333-8333-333333333333"
RUN_ID = "44444444-4444-4444-8444-444444444444"


class FakeClient:
    def __init__(self) -> None:
        self.calls = []
        self.uploads = []
        self.responses = {}

    def request(self, method, path, body=None):
        self.calls.append((method, path, body))
        response = self.responses.get((method, path))
        if callable(response):
            return response(body)
        return response if isinstance(response, dict) else {"observed_path": path}

    def upload(self, path, filename, content, content_type, fields):
        self.uploads.append((path, filename, content, content_type, fields))
        return {"id": "upload-task-1", "status": "queued"}


def call(adapter, name, arguments=None):
    return adapter.execute(ToolCall(id="call-1", name=name, arguments=arguments or {}))


class MainChainAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = FakeClient()
        self.client.responses[("GET", "/me/capabilities")] = {
            "platform_role": "member",
            "projects": [],
            "permissions": ["projects:read"],
        }
        self.adapter = MainChainAdapter(self.client)

    def preflight(self) -> None:
        result = call(self.adapter, "shortdrama_capabilities")
        self.assertFalse(result.is_error)

    def test_cli_dependency_is_commit_pinned_and_typer_layer_is_not_imported(self) -> None:
        self.assertEqual(CLI_CLIENT_COMMIT, "fe3019b1c5e1431b4b9fb6fe327e569ad2aba6fb")
        source = inspect.getsource(__import__("pi_http_wrapper.main_chain", fromlist=["*"]))
        self.assertIn("shortdrama_cli.server_api", source)
        self.assertNotIn("shortdrama_cli.cli", source)
        self.assertNotIn("shortdrama_cli.main", source)

    def test_only_server_owned_free_tools_are_registered(self) -> None:
        names = {definition.name for definition in self.adapter.definitions()}
        self.assertIn("shortdrama_script_breakdown", names)
        self.assertIn("shortdrama_asset_register_candidate", names)
        self.assertIn("shortdrama_project_asset_add", names)
        self.assertNotIn("shortdrama_script_confirm", names)
        self.assertNotIn("shortdrama_generation_submit", names)
        self.assertTrue(all("." not in name for name in names))

    def test_capabilities_preflight_is_required_and_receipt_never_invents_request_id(self) -> None:
        blocked = call(self.adapter, "shortdrama_project_list")
        self.assertTrue(blocked.is_error)
        self.assertEqual(blocked.content["error"]["code"], "capabilities_required")
        self.assertFalse(blocked.content["receipt"]["permissions_checked"])

        result = call(self.adapter, "shortdrama_capabilities")
        self.assertFalse(result.is_error)
        self.assertEqual(result.content["receipt"]["request_id"], "unknown")
        self.assertTrue(result.content["receipt"]["permissions_checked"])
        self.assertEqual(self.client.calls, [("GET", "/me/capabilities", None)])

    def test_project_name_zero_and_ambiguous_matches_never_choose_an_id(self) -> None:
        self.preflight()
        self.client.responses[("GET", "/projects")] = {
            "items": [{"id": PROJECT_ID, "name": "唯一项目"}],
            "count": 1,
        }
        missing = call(self.adapter, "shortdrama_project_get", {"project_name": "不存在"})
        self.assertTrue(missing.is_error)
        self.assertEqual(missing.content["error"]["code"], "name_not_found")
        self.assertFalse(any(path.startswith("/projects/") for _, path, _ in self.client.calls))

        self.client.responses[("GET", "/projects")] = {
            "items": [
                {"id": PROJECT_ID, "name": "同名项目"},
                {"id": EPISODE_ID, "name": "同名项目"},
            ],
            "count": 2,
        }
        ambiguous = call(self.adapter, "shortdrama_project_get", {"project_name": "同名项目"})
        self.assertTrue(ambiguous.is_error)
        self.assertEqual(ambiguous.content["error"]["code"], "name_ambiguous")
        self.assertEqual(len(ambiguous.content["error"]["details"]["candidates"]), 2)

    def test_unique_project_name_resolves_exactly_then_reads_by_id(self) -> None:
        self.preflight()
        self.client.responses[("GET", "/projects")] = {
            "items": [{"id": PROJECT_ID, "name": "雾岛来信"}],
            "count": 1,
        }
        self.client.responses[("GET", f"/projects/{PROJECT_ID}")] = {
            "id": PROJECT_ID,
            "name": "雾岛来信",
        }
        result = call(self.adapter, "shortdrama_project_get", {"project_name": "雾岛来信"})
        self.assertFalse(result.is_error)
        self.assertEqual(result.content["data"]["id"], PROJECT_ID)

    def test_missing_main_id_stops_without_guessing_and_keeps_receipt_unknown(self) -> None:
        self.preflight()
        self.client.responses[("GET", "/projects")] = {
            "items": [{"name": "缺 ID 项目"}],
            "count": 1,
        }
        result = call(self.adapter, "shortdrama_project_get", {"project_name": "缺 ID 项目"})
        self.assertTrue(result.is_error)
        self.assertEqual(result.content["error"]["code"], "invalid_main_response")
        self.assertEqual(result.content["receipt"]["request_id"], "unknown")
        self.assertFalse(any(path.startswith("/projects/") for _, path, _ in self.client.calls))

    def test_upstream_error_diagnostic_never_echoes_response_body(self) -> None:
        class FailingClient(FakeClient):
            def request(self, method, path, body=None):
                raise ApiRequestError("HTTP 500 secret-token user-script")

        result = MainChainAdapter(FailingClient()).execute(
            ToolCall(id="call-1", name="shortdrama_capabilities", arguments={}),
        )
        self.assertTrue(result.is_error)
        diagnostic = result.content["error"]["details"]["diagnostic"]
        self.assertEqual(diagnostic, "ApiRequestError")
        self.assertNotIn("secret-token", repr(result.content))

    def test_script_paste_and_breakdown_only_use_candidate_routes(self) -> None:
        self.preflight()
        key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        pasted = call(self.adapter, "shortdrama_script_paste", {
            "episode_id": EPISODE_ID,
            "script_text": "第一场，海边，夜。",
            "client_idempotency_key": key,
        })
        self.assertFalse(pasted.is_error)
        self.assertEqual(self.client.calls[-1], (
            "POST",
            f"/episodes/{EPISODE_ID}/script-versions",
            {
                "script_text": "第一场，海边，夜。",
                "client_idempotency_key": key,
            },
        ))

        breakdown = call(self.adapter, "shortdrama_script_breakdown", {
            "episode_id": EPISODE_ID,
            "script_version_id": ASSET_ID,
            "client_idempotency_key": key,
        })
        self.assertFalse(breakdown.is_error)
        self.assertEqual(self.client.calls[-1][1], f"/episodes/{EPISODE_ID}/script-breakdowns")
        self.assertNotIn("confirm", self.client.calls[-1][1])

    def test_asset_upload_uses_cli_multipart_client_and_project_add_requires_ids(self) -> None:
        self.preflight()
        image = b"clean-image-bytes"
        registered = call(self.adapter, "shortdrama_asset_register_candidate", {
            "file_name": "portrait.png",
            "content_type": "image/png",
            "image_base64": base64.b64encode(image).decode(),
            "registration": {"asset_kind": "character", "display_name": "候选角色"},
        })
        self.assertFalse(registered.is_error)
        upload = self.client.uploads[-1]
        self.assertEqual(upload[0:4], ("/asset-upload-tasks", "portrait.png", image, "image/png"))
        self.assertIn("client_idempotency_key", upload[4])

        added = call(self.adapter, "shortdrama_project_asset_add", {
            "project_id": PROJECT_ID,
            "asset_id": ASSET_ID,
        })
        self.assertFalse(added.is_error)
        self.assertEqual(self.client.calls[-1], (
            "POST",
            f"/projects/{PROJECT_ID}/assets",
            {"asset_entity_id": ASSET_ID},
        ))
        self.assertEqual(
            added.content["receipt"]["reversible"],
            "remove_project_asset_reference",
        )

    def test_breakdown_status_does_not_fill_missing_business_fields(self) -> None:
        self.preflight()
        self.client.responses[("GET", f"/script-breakdowns/{RUN_ID}")] = {
            "run": {"id": RUN_ID, "status": "running"},
            "stages": [],
        }
        result = call(self.adapter, "shortdrama_script_breakdown_status", {"run_id": RUN_ID})
        self.assertEqual(result.content["data"]["run"], {"id": RUN_ID, "status": "running"})
        self.assertNotIn("draft", result.content["data"]["run"])
        self.assertEqual(result.content["receipt"]["cost_status"], "none")


if __name__ == "__main__":
    unittest.main()
