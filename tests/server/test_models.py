import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import models


class ModelTests(unittest.TestCase):
    def test_codex_catalog_uses_visible_models_and_model_specific_efforts(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, 'models_cache.json').write_text(json.dumps({'models': [
                {'slug': 'visible', 'display_name': 'Visible model', 'visibility': 'list',
                 'supported_reasoning_levels': [{'effort': 'low'}, {'effort': 'high'}]},
                {'slug': 'hidden', 'visibility': 'hide'}]}))
            with patch.dict('os.environ', {'CODEX_HOME': tmp}):
                catalog = models.catalog('codex')
            self.assertEqual(catalog['models'], [{'id': 'visible', 'label': 'Visible model', 'efforts': ['low', 'high']}])
            self.assertEqual(models.validate_selection(catalog, 'visible', 'high'), ('visible', 'high'))
            for model, effort in [('hidden', 'high'), ('visible', 'ultra')]:
                with self.assertRaises(ValueError):
                    models.validate_selection(catalog, model, effort)

    def test_cli_model_list_and_failure_do_not_invent_models(self):
        models.discover.cache_clear()
        with patch('server.models.shutil.which', return_value='/bin/agy'), patch('server.models.subprocess.run') as run:
            run.return_value.stdout = 'Fetching available models...\ngemini-example-high\tGemini Example (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n'
            run.return_value.returncode = 0
            catalog = models.catalog('agy')
            self.assertEqual(catalog['models'][0]['id'], 'gemini-example-high')
            self.assertEqual(catalog['models'][0]['efforts'], ['high'])
            self.assertEqual(catalog['models'][1]['efforts'], [])
            with self.assertRaises(ValueError):
                models.validate_selection(catalog, 'gemini-example-high', 'medium')
        models.discover.cache_clear()
        with patch('server.models.shutil.which', return_value=None):
            catalog = models.catalog('qoder')
            self.assertEqual(catalog['models'], [])
            self.assertEqual(models.validate_selection(catalog, '', ''), ('', ''))
            with self.assertRaises(ValueError):
                models.validate_selection(catalog, 'invented', 'high')
        models.discover.cache_clear()
