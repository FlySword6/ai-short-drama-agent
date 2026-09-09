import asyncio
import unittest
from unittest.mock import Mock, patch

from veadk.knowledgebase.entry import KnowledgebaseEntry

from short_drama_agent.knowledge_assets import AssetMetadataFirstLoadKnowledgebaseTool


class AssetMetadataFirstLoadKnowledgebaseToolTest(unittest.TestCase):
    def test_asset_tool_filters_unrelated_asset_results(self):
        tool = AssetMetadataFirstLoadKnowledgebaseTool(knowledgebase=Mock())

        with patch(
            "short_drama_agent.knowledge_assets.search_knowledge_entries",
            return_value=[
                KnowledgebaseEntry(
                    content="角色：叶逍遥",
                    metadata={
                        "character_name": "叶逍遥",
                        "image_url": "https://example.com/yexiaoyao.jpg",
                    },
                )
            ],
        ):
            response = asyncio.run(
                tool.load_knowledgebase("春生照相馆悬疑开篇有哪些资产", None)
            )

        self.assertEqual(response.knowledges, [])

    def test_asset_tool_keeps_explicitly_related_asset_results(self):
        tool = AssetMetadataFirstLoadKnowledgebaseTool(knowledgebase=Mock())

        with patch(
            "short_drama_agent.knowledge_assets.search_knowledge_entries",
            return_value=[
                KnowledgebaseEntry(
                    content="场景：悬疑开篇",
                    metadata={
                        "work": "春生照相馆",
                        "tag": "悬疑开篇",
                        "image_url": "https://example.com/chunsheng.jpg",
                    },
                )
            ],
        ):
            response = asyncio.run(
                tool.load_knowledgebase("春生照相馆悬疑开篇有哪些资产", None)
            )

        self.assertEqual(len(response.knowledges), 1)
        self.assertIn(
            "https://example.com/chunsheng.jpg", response.knowledges[0].content
        )


if __name__ == "__main__":
    unittest.main()
