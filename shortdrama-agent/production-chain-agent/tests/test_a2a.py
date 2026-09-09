"""Tests for the A2A multi-agent architecture.

Uses real HTTP (ThreadingHTTPServer on port 0) with a mock LLM
to verify the full A2A protocol stack without external API calls.
"""

import json
import re
import unittest

from sda2a import (
    A2AClient,
    A2AOrchestrator,
    AgentCard,
    AgentSkill,
    AssetAgentServer,
    GenerationAgentServer,
    SceneAgentServer,
    ScriptAgentServer,
    SubAgentCluster,
)
from sda2a.protocol import (
    build_task_payload,
    build_task_result,
    extract_result_data,
    extract_task_data,
    make_error,
    make_request,
    make_response,
)
from production_chain.models import AssetRecord, to_dict


# ---------------------------------------------------------------------------
# Mock LLM (same behaviour as test_workflow.MockLLMClient)
# ---------------------------------------------------------------------------

class MockLLMClient:
    """Mock LLM that returns predefined JSON based on system-prompt keywords."""

    def chat_json(self, *, system_prompt, user_prompt, **kwargs):
        if "剧本拆解" in system_prompt and "资产" not in system_prompt:
            return {
                "scenes": [
                    {
                        "scene_no": 1,
                        "title": "首场",
                        "dialogue": "角色：林夏；场景：旧画室；道具：准考证",
                    }
                ],
                "requirements": [
                    {
                        "kind": "character",
                        "name": "林夏",
                        "evidence": {"scene_no": 1, "excerpt": "角色：林夏", "confidence": 0.95},
                    },
                    {
                        "kind": "scene",
                        "name": "旧画室",
                        "evidence": {"scene_no": 1, "excerpt": "场景：旧画室", "confidence": 0.95},
                    },
                    {
                        "kind": "prop",
                        "name": "准考证",
                        "evidence": {"scene_no": 1, "excerpt": "道具：准考证", "confidence": 0.95},
                    },
                ],
            }

        if "资产管理" in system_prompt:
            req_ids = re.findall(r'"requirement_id":\s*"([^"]+)"', user_prompt)
            asset_ids = re.findall(r'"asset_id":\s*"([^"]+)"', user_prompt)
            matches = []
            for i, req_id in enumerate(req_ids):
                if i < len(asset_ids):
                    matches.append({
                        "requirement_id": req_id,
                        "asset_id": asset_ids[i],
                        "confidence": 0.95,
                        "rationale": "semantic match",
                    })
            return {"matches": matches, "gaps": []}

        if "分镜师" in system_prompt:
            scene_ids = re.findall(r'"scene_id":\s*"([^"]+)"', user_prompt)
            shots = [
                {
                    "scene_id": sid,
                    "prompt_summary": f"中景：林夏在旧画室中手持准考证，暖色调柔光（scene={sid}）",
                }
                for sid in scene_ids
            ]
            return {"shots": shots}

        return {}

    def generate_image(self, *, prompt, **kwargs):
        return "https://mock.example.com/generated_image.png"


class TwoSceneMockLLMClient(MockLLMClient):
    """Mock that exposes per-shot idempotency behaviour in an A2A run."""

    def __init__(self) -> None:
        self.generate_image_calls = 0

    def chat_json(self, *, system_prompt, user_prompt, **kwargs):
        if "剧本拆解" in system_prompt and "资产" not in system_prompt:
            return {
                "scenes": [
                    {"scene_no": 1, "title": "第一场", "dialogue": "林夏在画室"},
                    {"scene_no": 2, "title": "第二场", "dialogue": "林夏离开画室"},
                ],
                "requirements": [],
            }
        return super().chat_json(
            system_prompt=system_prompt, user_prompt=user_prompt, **kwargs,
        )

    def generate_image(self, *, prompt, **kwargs):
        self.generate_image_calls += 1
        return f"https://mock.example.com/generated_{self.generate_image_calls}.png"


# ---------------------------------------------------------------------------
# Protocol unit tests
# ---------------------------------------------------------------------------

class TestAgentCard(unittest.TestCase):
    def test_card_serialization_roundtrip(self) -> None:
        card = AgentCard(
            name="test-agent",
            description="A test agent",
            url="http://localhost:8000",
            skills=[
                AgentSkill(name="do_thing", description="does a thing"),
            ],
        )
        d = card.to_dict()
        self.assertEqual(d["name"], "test-agent")
        self.assertEqual(d["skills"][0]["name"], "do_thing")

        restored = AgentCard.from_dict(d)
        self.assertEqual(restored.name, "test-agent")
        self.assertEqual(len(restored.skills), 1)
        self.assertEqual(restored.skills[0].name, "do_thing")

    def test_card_from_dict_handles_missing_fields(self) -> None:
        card = AgentCard.from_dict({"name": "minimal"})
        self.assertEqual(card.name, "minimal")
        self.assertEqual(card.version, "0.1.0")
        self.assertEqual(len(card.skills), 0)


class TestProtocolMessages(unittest.TestCase):
    def test_make_request_has_jsonrpc_version(self) -> None:
        req = make_request("tasks/send", {"id": "t1"})
        self.assertEqual(req["jsonrpc"], "2.0")
        self.assertEqual(req["method"], "tasks/send")

    def test_build_and_extract_task_payload(self) -> None:
        data = {"project_id": "p1", "script_text": "hello"}
        params = build_task_payload(data)
        extracted = extract_task_data(params)
        self.assertEqual(extracted, data)

    def test_build_and_extract_task_result(self) -> None:
        result = build_task_result("task-1", {"scenes": []})
        self.assertEqual(result["status"]["state"], "completed")
        extracted = extract_result_data(result)
        self.assertEqual(extracted, {"scenes": []})

    def test_make_error_response(self) -> None:
        err = make_error(-32601, "method not found", "req-1")
        self.assertEqual(err["error"]["code"], -32601)
        self.assertEqual(err["id"], "req-1")


# ---------------------------------------------------------------------------
# A2A server + client integration (real HTTP on random port)
# ---------------------------------------------------------------------------

class TestA2AServerClient(unittest.TestCase):
    """Test that A2AAgentServer and A2AClient work together over HTTP."""

    def setUp(self) -> None:
        # Simple echo handler for protocol testing.
        card = AgentCard(name="echo-agent", description="echo", url="")
        from sda2a.server import A2AAgentServer

        def echo_handler(payload: dict) -> dict:
            return {"echoed": payload}

        self.server = A2AAgentServer(card, echo_handler)
        self.url = self.server.start()
        self.client = A2AClient(timeout=10)

    def tearDown(self) -> None:
        self.server.stop()

    def test_discover_agent_card(self) -> None:
        card = self.client.discover(self.url)
        self.assertEqual(card.name, "echo-agent")

    def test_send_task_and_get_result(self) -> None:
        result = self.client.send_task(self.url, {"hello": "world"})
        self.assertEqual(result, {"echoed": {"hello": "world"}})

    def test_health_endpoint(self) -> None:
        import httpx

        resp = httpx.get(f"{self.url}/health", timeout=5)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "ok")


# ---------------------------------------------------------------------------
# Sub-agent server tests (with mock LLM)
# ---------------------------------------------------------------------------

class TestScriptAgentServer(unittest.TestCase):
    def setUp(self) -> None:
        self.agent = ScriptAgentServer(llm=MockLLMClient())
        self.url = self.agent.start()
        self.client = A2AClient(timeout=10)

    def tearDown(self) -> None:
        self.agent.stop()

    def test_script_breakdown_via_a2a(self) -> None:
        result = self.client.send_task(self.url, {
            "project_id": "p1",
            "title": "测试",
            "episode_no": 1,
            "script_text": "角色：林夏；场景：旧画室；道具：准考证",
        })
        self.assertIn("scenes", result)
        self.assertEqual(len(result["scenes"]), 1)
        self.assertIn("requirements", result)
        kinds = {r["kind"] for r in result["requirements"]}
        self.assertEqual(kinds, {"character", "scene", "prop"})

    def test_discover_card(self) -> None:
        card = self.client.discover(self.url)
        self.assertEqual(card.name, "script-agent")
        self.assertTrue(card.skills)


class TestAssetAgentServer(unittest.TestCase):
    def setUp(self) -> None:
        self.agent = AssetAgentServer(llm=MockLLMClient())
        self.url = self.agent.start()
        self.client = A2AClient(timeout=10)

    def tearDown(self) -> None:
        self.agent.stop()

    def test_asset_match_via_a2a(self) -> None:
        result = self.client.send_task(self.url, {
            "requirements": [
                {
                    "requirement_id": "req_1",
                    "kind": "character",
                    "name": "林夏",
                    "evidence": {"scene_no": 1, "excerpt": "角色：林夏", "confidence": 0.95},
                },
            ],
            "inventory": [
                {"asset_id": "a1", "name": "林夏", "kind": "character"},
            ],
        })
        self.assertEqual(len(result["matches"]), 1)
        self.assertEqual(result["matches"][0]["asset_id"], "a1")
        self.assertEqual(len(result["gaps"]), 0)


class TestGenerationAgentServer(unittest.TestCase):
    def setUp(self) -> None:
        self.agent = GenerationAgentServer(llm=MockLLMClient())
        self.url = self.agent.start()
        self.client = A2AClient(timeout=10)

    def tearDown(self) -> None:
        self.agent.stop()

    def test_generate_image_via_a2a(self) -> None:
        result = self.client.send_task(self.url, {
            "prompt": "中景：林夏在旧画室",
        })
        self.assertEqual(result["state"], "succeeded")
        self.assertTrue(result["output_url"])

    def test_generation_failure_returns_failed_state(self) -> None:
        """When the LLM raises, the agent returns state=failed, not crash."""

        class BrokenLLM:
            def generate_image(self, **kwargs):
                raise RuntimeError("API unavailable")

        agent = GenerationAgentServer(llm=BrokenLLM())
        url = agent.start()
        try:
            result = self.client.send_task(url, {"prompt": "test"})
            self.assertEqual(result["state"], "failed")
            self.assertIn("API unavailable", result["error"])
        finally:
            agent.stop()


# ---------------------------------------------------------------------------
# Full A2A pipeline (orchestrator + all sub-agents + real HTTP)
# ---------------------------------------------------------------------------

class TestA2AOrchestrator(unittest.TestCase):
    """End-to-end A2A pipeline with mock LLM and real HTTP."""

    def setUp(self) -> None:
        self.cluster = SubAgentCluster(llm=MockLLMClient())
        self.urls = self.cluster.start()
        self.orchestrator = A2AOrchestrator(self.urls)

    def tearDown(self) -> None:
        self.cluster.stop()

    def test_all_four_agents_started(self) -> None:
        self.assertEqual(len(self.urls), 4)
        for name in ("script", "asset", "scene", "generation"):
            self.assertIn(name, self.urls)
            self.assertTrue(self.urls[name].startswith("http://"))

    def test_full_pipeline_produces_trace_receipt(self) -> None:
        receipt = self.orchestrator.run(verbose=False)

        self.assertIn("trace_id", receipt)
        self.assertIn("breakdown", receipt)
        self.assertIn("matches", receipt)
        self.assertIn("gaps", receipt)
        self.assertIn("scene_packages", receipt)
        self.assertIn("generation_tasks", receipt)
        self.assertIn("generation_results", receipt)
        self.assertIn("promoted_assets", receipt)

    def test_pipeline_extracts_three_requirements(self) -> None:
        receipt = self.orchestrator.run(verbose=False)
        requirements = receipt["breakdown"]["requirements"]
        kinds = {r["kind"] for r in requirements}
        self.assertEqual(kinds, {"character", "scene", "prop"})

    def test_pipeline_matches_all_requirements(self) -> None:
        receipt = self.orchestrator.run(verbose=False)
        self.assertEqual(len(receipt["matches"]), 3)
        self.assertEqual(len(receipt["gaps"]), 0)

    def test_pipeline_generates_shot_cards(self) -> None:
        receipt = self.orchestrator.run(verbose=False)
        packages = receipt["scene_packages"]
        self.assertEqual(len(packages), 1)
        self.assertIn("中景", packages[0]["shot"]["prompt_summary"])

    def test_pipeline_generates_images(self) -> None:
        receipt = self.orchestrator.run(verbose=False)
        results = receipt["generation_results"]
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0]["output_url"])

    def test_pipeline_promotes_assets(self) -> None:
        receipt = self.orchestrator.run(verbose=False)
        promoted = receipt["promoted_assets"]
        self.assertEqual(len(promoted), 1)
        self.assertEqual(promoted[0]["kind"], "video")

    def test_each_shot_uses_a_distinct_idempotency_key(self) -> None:
        """Two shots at revision 1 must not reuse one generated image."""

        self.cluster.stop()
        llm = TwoSceneMockLLMClient()
        self.cluster = SubAgentCluster(llm=llm)
        self.urls = self.cluster.start()
        self.orchestrator = A2AOrchestrator(self.urls)

        receipt = self.orchestrator.run(verbose=False)
        tasks = receipt["generation_tasks"]

        self.assertEqual(len(tasks), 2)
        self.assertEqual(llm.generate_image_calls, 2)
        self.assertEqual(len({task["idempotency_key"] for task in tasks}), 2)
        self.assertEqual(len({task["shot_id"] for task in tasks}), 2)


# ---------------------------------------------------------------------------
# Orchestrator state management
# ---------------------------------------------------------------------------

class TestOrchestratorState(unittest.TestCase):
    """Test ReviewGate and idempotency in the orchestrator."""

    def setUp(self) -> None:
        self.cluster = SubAgentCluster(llm=MockLLMClient())
        self.urls = self.cluster.start()
        self.orchestrator = A2AOrchestrator(self.urls)

    def tearDown(self) -> None:
        self.cluster.stop()

    def test_generation_is_idempotent(self) -> None:
        """Same idempotency key returns cached result without re-calling agent."""

        from production_chain.models import ShotCardDraft

        shot = ShotCardDraft("shot_1", "s1", 1, "test prompt", [])
        # 第一次调用 — 通过 A2A 发送到 GenerationAgent
        task1, result1 = self.orchestrator._call_generation_agent(
            shot, "trace-1", "same-key", lambda *a: None,
        )
        self.assertEqual(task1.state, "succeeded")

        # 第二次用同一 key — 应返回缓存，不再发 HTTP 请求
        task2, result2 = self.orchestrator._call_generation_agent(
            shot, "trace-2", "same-key", lambda *a: None,
        )
        self.assertEqual(task1.task_id, task2.task_id)
        self.assertEqual(result1.output_url, result2.output_url)

    def test_review_gate_blocks_unapproved_generation(self) -> None:
        """Generation cannot proceed without ReviewGate approval."""

        # Orchestrator.run() handles approval internally, but
        # _call_generation_agent itself doesn't check the gate —
        # the gate check happens in run() before calling it.
        # Here we verify the gate is enforced for promotion.
        from production_chain.models import GenerationResult

        result = GenerationResult(
            "r1", "t1", "shot_1", "candidate", 20, "https://example.com/img.png",
        )
        review_item = self.orchestrator._review_gate.request(
            "generation_result", "r1", "promotion",
        )
        # 未审批前不能入库
        with self.assertRaises(PermissionError):
            self.orchestrator._promote_result_to_asset(result, review_item)

        # 审批后可以入库
        self.orchestrator._review_gate.approve(review_item, "director")
        asset = self.orchestrator._promote_result_to_asset(result, review_item)
        self.assertEqual(asset.kind, "video")

    def test_failed_generation_is_not_promoted(self) -> None:
        """A failed generation remains a task record and cannot become an asset."""

        class BrokenLLM(MockLLMClient):
            def generate_image(self, **kwargs):
                raise RuntimeError("image API unavailable")

        self.cluster.stop()
        self.cluster = SubAgentCluster(llm=BrokenLLM())
        self.urls = self.cluster.start()
        self.orchestrator = A2AOrchestrator(self.urls)

        receipt = self.orchestrator.run(verbose=False)

        self.assertEqual(receipt["generation_tasks"][0]["state"], "failed")
        self.assertEqual(receipt["generation_results"][0]["output_url"], "")
        self.assertEqual(receipt["promoted_assets"], [])


# ---------------------------------------------------------------------------
# AgentCard discovery via SubAgentCluster
# ---------------------------------------------------------------------------

class TestSubAgentCluster(unittest.TestCase):
    def test_cluster_starts_and_stops_all_agents(self) -> None:
        cluster = SubAgentCluster(llm=MockLLMClient())
        urls = cluster.start()
        self.assertEqual(len(urls), 4)

        # Verify all agents are discoverable
        client = A2AClient(timeout=10)
        for name, url in urls.items():
            card = client.discover(url)
            self.assertTrue(card.name.startswith(name))

        cluster.stop()

    def test_cluster_cards_have_correct_names(self) -> None:
        cluster = SubAgentCluster(llm=MockLLMClient())
        cluster.start()
        try:
            cards = cluster.cards
            self.assertEqual(len(cards), 4)
            expected_names = {"script", "asset", "scene", "generation"}
            self.assertEqual(set(cards.keys()), expected_names)
            for name, card in cards.items():
                self.assertIn(name, card.name)
        finally:
            cluster.stop()


# ---------------------------------------------------------------------------
# A2A Hub integration tests (real HTTP + veadk A2AHubServer)
# ---------------------------------------------------------------------------

from sda2a.hub import HubManager


class TestHubManager(unittest.TestCase):
    """Test A2A Hub registration and discovery."""

    def setUp(self) -> None:
        self.hub = HubManager(host="127.0.0.1", port=0)
        self.hub.start()

    def tearDown(self) -> None:
        self.hub.stop()

    def test_hub_starts_and_responds(self) -> None:
        import httpx

        resp = httpx.get(f"{self.hub.url}/ping", timeout=5)
        self.assertEqual(resp.status_code, 200)

    def test_register_and_discover_agent(self) -> None:
        card = {
            "name": "test-agent",
            "description": "test",
            "url": "http://127.0.0.1:12345",
            "version": "0.1.0",
            "capabilities": {"streaming": False},
            "skills": [],
        }
        self.hub.register_agent("test-agent", card)

        agents = self.hub.discover_agents()
        self.assertIn("test-agent", agents)
        self.assertEqual(agents["test-agent"]["url"], "http://127.0.0.1:12345")

    def test_discover_agent_urls(self) -> None:
        self.hub.register_agent("script-agent", {
            "name": "script-agent", "url": "http://127.0.0.1:8001",
        })
        self.hub.register_agent("asset-agent", {
            "name": "asset-agent", "url": "http://127.0.0.1:8002",
        })

        urls = self.hub.discover_agent_urls()
        self.assertIn("script", urls)
        self.assertIn("asset", urls)
        self.assertEqual(urls["script"], "http://127.0.0.1:8001")


class TestFullHubPipeline(unittest.TestCase):
    """Full A2A pipeline: Hub + 4 sub-agents + orchestrator."""

    def setUp(self) -> None:
        self.hub = HubManager(host="127.0.0.1", port=0)
        self.hub.start()
        self.cluster = SubAgentCluster(llm=MockLLMClient(), hub=self.hub)
        self.cluster.start()

    def tearDown(self) -> None:
        self.cluster.stop()
        self.hub.stop()

    def test_hub_discovers_all_four_agents(self) -> None:
        urls = self.hub.discover_agent_urls()
        self.assertEqual(len(urls), 4)
        for name in ("script", "asset", "scene", "generation"):
            self.assertIn(name, urls)

    def test_pipeline_via_hub_discovery(self) -> None:
        """Orchestrator discovers agents via Hub and runs the full chain."""

        urls = self.hub.discover_agent_urls()
        orchestrator = A2AOrchestrator(urls)
        receipt = orchestrator.run(verbose=False)

        self.assertIn("trace_id", receipt)
        self.assertIn("breakdown", receipt)
        self.assertIn("generation_results", receipt)
        self.assertEqual(len(receipt["generation_results"]), 1)
        self.assertTrue(receipt["generation_results"][0]["output_url"])


class TestVeAdkCompatibility(unittest.TestCase):
    """Test compatibility with veadk A2A conventions."""

    def test_agent_card_served_at_well_known_path(self) -> None:
        """veadk RemoteVeAgent uses /.well-known/agent-card.json."""

        import httpx

        agent = ScriptAgentServer(llm=MockLLMClient())
        url = agent.start()
        try:
            # Standard path
            resp1 = httpx.get(f"{url}/.well-known/agent.json", timeout=5)
            self.assertEqual(resp1.status_code, 200)

            # veadk-compatible path
            resp2 = httpx.get(f"{url}/.well-known/agent-card.json", timeout=5)
            self.assertEqual(resp2.status_code, 200)
            self.assertEqual(resp1.json(), resp2.json())
        finally:
            agent.stop()


if __name__ == "__main__":
    unittest.main()
