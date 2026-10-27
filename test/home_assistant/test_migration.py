import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("zero_migration", Path(__file__).parents[2] / "scripts/migrate-ha-zero.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MigrationTests(unittest.TestCase):
    def test_preserves_entry_rule_storage_and_pipeline_while_merging_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".storage").mkdir()
            (root / "configuration.yaml").write_text("homeassistant:\nassistant_zero: !include assistant_zero_credentials.yaml\nassistant_rules: !include assistant_rules_credentials.yaml\n")
            voice = {"url": "http://zero", "token": "voice", "satellite_id": "assist_satellite.test"}
            rules = {"callback_url": "http://zero/events", "callback_token": "callback"}
            (root / "assistant_zero_credentials.yaml").write_text(json.dumps(voice))
            (root / "assistant_rules_credentials.yaml").write_text(json.dumps(rules))
            entries = {"version": 1, "data": {"entries": [{"entry_id": "same-voice-id", "domain": "assistant_zero", "data": voice}, {"entry_id": "old-rules", "domain": "assistant_rules", "data": rules}]}}
            path = root / ".storage/core.config_entries"
            path.write_text(json.dumps(entries))
            (root / ".storage/assistant_rules").write_text('unique-rule-storage')
            (root / ".storage/assist_pipeline.pipelines").write_text('same-pipeline')
            for domain in ("assistant_zero", "assistant_rules"):
                (root / "custom_components" / domain).mkdir(parents=True)
                (root / "custom_components" / domain / "old.py").write_text("old")
            files = {"__init__.py": base64.b64encode(b'new merged component').decode()}
            result = module.migrate(root, files, "new-settings-token", "migration-test")
            saved = json.loads(path.read_text())["data"]["entries"]
            self.assertEqual(len(saved), 1)
            self.assertEqual(saved[0]["entry_id"], "same-voice-id")
            self.assertEqual(saved[0]["data"]["token"], "voice")
            self.assertEqual(saved[0]["data"]["callback_token"], "callback")
            self.assertEqual((root / ".storage/assistant_rules").read_text(), 'unique-rule-storage')
            self.assertEqual((root / ".storage/assist_pipeline.pipelines").read_text(), 'same-pipeline')
            self.assertFalse((root / "custom_components/assistant_rules").exists())
            self.assertTrue(Path(result["backup"], ".storage/core.config_entries").exists())
            self.assertNotIn("assistant_rules:", (root / "configuration.yaml").read_text())
