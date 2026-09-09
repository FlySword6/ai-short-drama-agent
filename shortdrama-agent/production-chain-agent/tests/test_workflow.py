"""Regression coverage for real LLM-powered skills with a mock LLM client.

The mock LLM parses prompts to return contextually correct JSON, so the
boundary conditions (ReviewGate, idempotency, promotion) are tested
without real API calls.
"""

import re
import unittest

from production_chain.llm import LLMClient
from production_chain.models import AssetRecord
from production_chain.workflow import ProductionChainAgent, _validate_script


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
                        "evidence": {
                            "scene_no": 1,
                            "excerpt": "角色：林夏",
                            "confidence": 0.95,
                        },
                    },
                    {
                        "kind": "scene",
                        "name": "旧画室",
                        "evidence": {
                            "scene_no": 1,
                            "excerpt": "场景：旧画室",
                            "confidence": 0.95,
                        },
                    },
                    {
                        "kind": "prop",
                        "name": "准考证",
                        "evidence": {
                            "scene_no": 1,
                            "excerpt": "道具：准考证",
                            "confidence": 0.95,
                        },
                    },
                ],
            }

        if "资产管理" in system_prompt:
            # 从 user_prompt 中提取需求 ID 和资产 ID，按位置匹配。
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


class ProductionChainTest(unittest.TestCase):
    def setUp(self) -> None:
        self.mock_llm = MockLLMClient()
        self.agent = ProductionChainAgent.create(llm=self.mock_llm)
        self.breakdown = self.agent.script.run(
            project_id="p1", title="t", episode_no=1,
            script_text="角色：林夏；场景：旧画室；道具：准考证",
        )
        inventory = [
            AssetRecord("a1", "林夏", "character"),
            AssetRecord("a2", "旧画室", "scene"),
            AssetRecord("a3", "准考证", "prop"),
        ]
        matches, gaps = self.agent.asset.run(self.breakdown.requirements, inventory)
        self.package = self.agent.scene.run(self.breakdown, matches, gaps)[0]

    def test_generation_requires_shot_review(self) -> None:
        with self.assertRaises(PermissionError):
            self.agent.generation.run(self.package.shot, "trace", "key")

    def test_generation_is_idempotent_after_review(self) -> None:
        review = self.agent.review_gate.request(
            "shot_card", self.package.shot.shot_id, "director",
        )
        self.agent.review_gate.approve(review, "director")
        first, _ = self.agent.generation.run(self.package.shot, "trace-1", "same-key")
        second, _ = self.agent.generation.run(self.package.shot, "trace-2", "same-key")
        self.assertEqual(first.task_id, second.task_id)

    def test_result_cannot_be_promoted_without_second_review(self) -> None:
        review = self.agent.review_gate.request(
            "shot_card", self.package.shot.shot_id, "director",
        )
        self.agent.review_gate.approve(review, "director")
        _, result = self.agent.generation.run(self.package.shot, "trace", "key")
        result_review = self.agent.review_gate.request(
            "generation_result", result.result_id, "asset promotion",
        )
        with self.assertRaises(PermissionError):
            self.agent.promote_result_to_asset(result, result_review)

    def test_generation_returns_output_url(self) -> None:
        review = self.agent.review_gate.request(
            "shot_card", self.package.shot.shot_id, "director",
        )
        self.agent.review_gate.approve(review, "director")
        _, result = self.agent.generation.run(self.package.shot, "trace", "key")
        self.assertTrue(result.output_url)

    def test_script_skill_extracts_all_requirements(self) -> None:
        kinds = {r.kind for r in self.breakdown.requirements}
        self.assertEqual(kinds, {"character", "scene", "prop"})

    def test_scene_skill_generates_rich_prompt(self) -> None:
        self.assertIn("中景", self.package.shot.prompt_summary)


class BrokenLLMClient:
    """Mock LLM that always returns invalid output to test fallback."""

    def chat_json(self, *, system_prompt, user_prompt, **kwargs):
        # 模拟 LLM 返回空 dict（chat_json 重试全部失败时的结果）
        return {}

    def generate_image(self, *, prompt, **kwargs):
        raise RuntimeError("image API unavailable")


class FallbackTest(unittest.TestCase):
    """When LLM returns garbage, Skills must degrade gracefully, not crash."""

    def setUp(self) -> None:
        self.broken_llm = BrokenLLMClient()
        self.agent = ProductionChainAgent.create(llm=self.broken_llm)

    def test_script_skill_fallback_on_empty_json(self) -> None:
        """No scenes/requirements from LLM → use full script as one scene."""
        breakdown = self.agent.script.run(
            project_id="p1", title="t", episode_no=1,
            script_text="角色：林夏",
        )
        self.assertEqual(len(breakdown.scenes), 1)
        self.assertEqual(breakdown.scenes[0].dialogue, "角色：林夏")
        self.assertEqual(len(breakdown.requirements), 0)

    def test_asset_skill_fallback_on_empty_json(self) -> None:
        """No matches from LLM → all requirements become gaps."""
        from production_chain.models import AssetRequirementCandidate, Evidence
        reqs = [
            AssetRequirementCandidate(
                "req_1", "character", "林夏",
                Evidence(1, "", 0.5),
            ),
        ]
        inventory = [AssetRecord("a1", "林夏", "character")]
        matches, gaps = self.agent.asset.run(reqs, inventory)
        self.assertEqual(len(matches), 0)
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0].recommendation, "generate")

    def test_scene_skill_fallback_on_empty_json(self) -> None:
        """No shots from LLM → prompt falls back to title:dialogue."""
        from production_chain.models import ScriptBreakdown, SceneDraft
        breakdown = ScriptBreakdown(
            project_id="p1", script_title="t", episode_no=1,
            script_version="v1", parse_batch_id="b1",
            scenes=[SceneDraft("s1", 1, "旧画室", "林夏低声说：我再画一张。")],
            requirements=[],
        )
        packages = self.agent.scene.run(breakdown, [], [])
        self.assertEqual(len(packages), 1)
        self.assertIn("旧画室", packages[0].shot.prompt_summary)
        self.assertIn("我再画一张", packages[0].shot.prompt_summary)

    def test_generation_skill_fallback_on_api_error(self) -> None:
        """Image API failure → task marked failed, not crash."""
        from production_chain.models import ShotCardDraft
        shot = ShotCardDraft("shot_1", "s1", 1, "prompt", [])
        review = self.agent.review_gate.request("shot_card", shot.shot_id, "dir")
        self.agent.review_gate.approve(review, "director")
        task, result = self.agent.generation.run(shot, "trace", "key")
        self.assertEqual(task.state, "failed")
        self.assertEqual(result.output_url, "")


class RetryWithFeedbackTest(unittest.TestCase):
    """Test that chat_json retries with correction feedback when schema validation fails."""

    def test_validate_failure_triggers_retry_with_feedback(self) -> None:
        """First call returns bad structure → retry with error message → second call returns valid JSON."""

        class FlakyLLMClient(LLMClient):
            def __init__(self):
                super().__init__(api_key="mock")
                self.calls: list[str] = []

            def chat(self, *, system_prompt, user_prompt, **kwargs):
                self.calls.append(user_prompt)
                if len(self.calls) == 1:
                    # 第一次：缺少 scenes 字段
                    return '{"requirements": []}'
                # 第二次：应包含修正提示，返回完整结构
                return (
                    '{"scenes": [{"scene_no": 1, "title": "画室", '
                    '"dialogue": "林夏说：好"}], '
                    '"requirements": []}'
                )

        client = FlakyLLMClient()
        result = client.chat_json(
            system_prompt="test",
            user_prompt="拆解剧本",
            validate=_validate_script,
        )

        # 第二次调用成功返回了合法结构
        self.assertIn("scenes", result)
        self.assertEqual(len(result["scenes"]), 1)
        # 确认第二次调用的 prompt 包含了修正提示
        self.assertEqual(len(client.calls), 2)
        self.assertIn("修正提示", client.calls[1])
        self.assertIn("缺少 'scenes' 字段", client.calls[1])

    def test_all_retries_exhausted_returns_empty(self) -> None:
        """All retries fail → returns {} for downstream fallback."""

        class AlwaysBadLLMClient(LLMClient):
            def __init__(self):
                super().__init__(api_key="mock")
                self.call_count = 0

            def chat(self, *, system_prompt, user_prompt, **kwargs):
                self.call_count += 1
                # 每次都返回非 JSON
                return "我无法解析这个剧本"

        client = AlwaysBadLLMClient()
        result = client.chat_json(
            system_prompt="test",
            user_prompt="拆解剧本",
            validate=_validate_script,
            retries=1,
        )

        # 重试 1 次后仍失败，返回空 dict
        self.assertEqual(result, {})
        self.assertEqual(client.call_count, 2)  # 初始 1 次 + 重试 1 次


if __name__ == "__main__":
    unittest.main()
