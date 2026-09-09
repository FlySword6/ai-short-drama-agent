"""Static coverage for the AgentKit entrypoint without requiring cloud credentials."""

from pathlib import Path
import unittest


AGENTKIT_CONFIG = Path("agentkit.yaml")

# agentkit.yaml 是 `agentkit deploy` 在本地生成的产物，仓库根 .gitignore 明确
# 不收它（"AgentKit 运行时生成文件（含真实 API key，由 agentkit deploy 写入）"）。
# 原来这个测试无条件读它，在干净检出里必然 FileNotFoundError——2026-08-13 加 PR
# 门禁（#5）时第一次被跑出来。拆成两个用例：入口源码那半在任何检出里都跑，
# 部署产物那半只在本地跑过 deploy 的机器上跑，缺文件时 skip 并说明原因。
# skip 不会被藏起来：门禁按 #5 的要求报总/过/skip 三数。
_CONFIG_MISSING_REASON = (
    "agentkit.yaml 不在仓库里（.gitignore 按设计排除，含真实 API key）；"
    "这半个断言只在跑过 agentkit deploy 的机器上有意义"
)


class AgentKitEntryContractTest(unittest.TestCase):
    def test_entrypoint_declares_agentkit_server_and_real_tools(self) -> None:
        source = Path("agentkit_entry.py").read_text(encoding="utf-8")
        self.assertIn("AgentkitAgentServerApp", source)
        self.assertIn("FunctionTool(run_fixture_production_chain)", source)
        self.assertIn("FunctionTool(run_production_chain_tool)", source)
        self.assertIn("FunctionTool(run_a2a_hub_production_chain_tool)", source)

    @unittest.skipUnless(AGENTKIT_CONFIG.exists(), _CONFIG_MISSING_REASON)
    def test_deploy_config_points_at_entrypoint_and_carries_no_secret(self) -> None:
        config = AGENTKIT_CONFIG.read_text(encoding="utf-8")
        self.assertIn("entry_point: agentkit_entry.py", config)
        self.assertNotIn("VOLCENGINE_SECRET_KEY:", config)


if __name__ == "__main__":
    unittest.main()
