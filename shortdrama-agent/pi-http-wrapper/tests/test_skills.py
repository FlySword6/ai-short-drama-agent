import tempfile
import unittest
from pathlib import Path

from pi_http_wrapper.skills import SkillRegistry


class SkillRegistryTests(unittest.TestCase):
    def test_only_allowlisted_skill_directories_are_listed_and_can_be_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            agents = root / "agents-skills"
            workbuddy = root / "workbuddy-skills"
            (agents / "shortdrama-cli").mkdir(parents=True)
            (agents / "shortdrama-cli" / "SKILL.md").write_text("# skill\n", encoding="utf-8")
            (workbuddy / "outside").mkdir(parents=True)
            (root / "not-allowed" / "bad").mkdir(parents=True)
            (root / "not-allowed" / "bad" / "SKILL.md").write_text("# never listed\n", encoding="utf-8")
            registry = SkillRegistry((agents, workbuddy), root / "state.json")
            skills = registry.list()
            self.assertEqual([skill.id for skill in skills], ["agents/shortdrama-cli"])
            updated = registry.set_enabled("agents/shortdrama-cli", False)
            self.assertFalse(updated.enabled)
            self.assertFalse(registry.list()[0].enabled)
