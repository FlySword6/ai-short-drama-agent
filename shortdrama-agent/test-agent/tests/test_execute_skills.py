import asyncio
import unittest
from unittest.mock import patch

from google.genai import types

from short_drama_agent.execute_skills import _prepare_artifact_refs_for_skills


class ExecuteSkillsIntegrationTest(unittest.TestCase):
    def test_prepare_artifact_refs_uploads_adk_artifact_to_tos(self):
        class FakeToolContext:
            async def list_artifacts(self):
                return ["artifact_e-467c8c64-3db1-489a-af0f-e582d3e6bb79_1"]

            async def load_artifact(self, filename):
                return types.Part(
                    inline_data=types.Blob(
                        mime_type="image/jpeg",
                        data=b"image-bytes",
                        display_name="小龙女定妆照.jpg",
                    )
                )

        with patch(
            "short_drama_agent.knowledge_assets.upload_asset_bytes_to_tos",
            return_value={
                "tos_path": "asset-bucket/knowledgebase/assets/xiaolongnv.jpg",
                "tos_url": "tos://asset-bucket/knowledgebase/assets/xiaolongnv.jpg",
                "public_url": "https://example.com/xiaolongnv.jpg",
            },
        ) as upload:
            prepared_prompt = asyncio.run(
                _prepare_artifact_refs_for_skills(
                    "请把 artifact_e-467c8c64-3db1-489a-af0f-e582d3e6bb79_1 入库",
                    FakeToolContext(),
                )
            )

        upload.assert_called_once()
        upload_kwargs = upload.call_args.kwargs
        self.assertEqual(upload_kwargs["file_name"], "小龙女定妆照.jpg")
        self.assertEqual(upload_kwargs["content"], b"image-bytes")
        self.assertIn(
            "tos_path: asset-bucket/knowledgebase/assets/xiaolongnv.jpg",
            prepared_prompt,
        )
        self.assertIn("file_name: 小龙女定妆照.jpg", prepared_prompt)
        self.assertIn("不要再在 sandbox 本地查找 artifact 文件", prepared_prompt)

    def test_prepare_artifact_refs_returns_clear_error_when_artifact_missing(self):
        class FakeToolContext:
            async def list_artifacts(self):
                return []

            async def load_artifact(self, filename):
                return None

        prepared_prompt = asyncio.run(
            _prepare_artifact_refs_for_skills(
                "请把 artifact_e-missing_1 入库",
                FakeToolContext(),
            )
        )

        self.assertIn("无法执行 Skills 入库", prepared_prompt)
        self.assertIn("artifact_e-missing_1", prepared_prompt)
        self.assertIn("请重新上传附件", prepared_prompt)

    def test_prepare_artifact_refs_ignores_non_ingest_prompts(self):
        class FakeToolContext:
            async def list_artifacts(self):
                raise AssertionError("should not list artifacts")

        with patch(
            "short_drama_agent.knowledge_assets.upload_asset_bytes_to_tos"
        ) as upload:
            prepared_prompt = asyncio.run(
                _prepare_artifact_refs_for_skills(
                    "请总结 artifact_e-467c8c64-3db1-489a-af0f-e582d3e6bb79_1 的内容",
                    FakeToolContext(),
                )
            )

        upload.assert_not_called()
        self.assertEqual(
            prepared_prompt,
            "请总结 artifact_e-467c8c64-3db1-489a-af0f-e582d3e6bb79_1 的内容",
        )


if __name__ == "__main__":
    unittest.main()
