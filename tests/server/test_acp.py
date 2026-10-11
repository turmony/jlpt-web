import json
import os
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from server.cli import run_cli


class ACPProcessTests(unittest.TestCase):
    def test_wall_timeout_cancels_upstream_prompt_and_keeps_partial_reply(self):
        fixture = Path(__file__).resolve().parents[1] / 'agent/fake-acp.mjs'
        events = []
        with tempfile.TemporaryDirectory() as cwd, patch.dict(os.environ, {
            'JLPT_CODEX_ACP_COMMAND': shutil.which('node'),
            'JLPT_CODEX_ACP_ARGS': json.dumps([str(fixture)]),
        }):
            with self.assertRaises(TimeoutError):
                run_cli('codex', 'hang', None, cwd, events.append,
                        threading.Event(), timeout=.8)
            self.assertTrue(any(event.get('text') == '你好，' for event in events))
            self.assertEqual(Path(cwd, 'cancelled').read_text(), 'yes')
