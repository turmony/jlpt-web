import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from server.health import CliHealth


class HealthTests(unittest.TestCase):
    def setUp(self):
        self.health = CliHealth()
        self.addCleanup(self.health.close)
        self.metadata = [{'id': name, 'installed': name != 'agy', 'auth': 'ready',
                          'detail': '已登录', 'models': []} for name in ('codex', 'qoder', 'agy')]
        self.status = patch('server.health.cli.status', return_value=self.metadata).start()
        self.addCleanup(patch.stopall)

    def finish(self):
        self.health.thread.join(timeout=3)
        self.assertFalse(self.health.thread.is_alive())
        return self.health.snapshot()

    def test_only_actual_reply_proves_usable_and_probe_uses_disposable_workspace(self):
        calls = []
        def run(name, prompt, session, cwd, callback, cancelled, **settings):
            self.assertIsNone(session)
            self.assertTrue(Path(cwd).is_dir())
            self.assertEqual(list(Path(cwd).iterdir()), [])
            calls.append((name, cwd, settings))
            if name == 'qoder':
                raise RuntimeError('需要登录')
            token = prompt.split('：', 1)[1].split('。', 1)[0]
            callback({'type': 'assistant', 'text': token[:8]})
            callback({'type': 'assistant', 'text': token[8:]})
        with patch('server.health.cli.run_cli', side_effect=run):
            self.health.refresh()
            states = self.finish()
        self.assertEqual([s['id'] for s in states if s['usable']], ['codex'])
        self.assertEqual(states[1]['auth'], 'failed')
        self.assertIn('需要登录', states[1]['detail'])
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(not Path(cwd).exists() for _, cwd, _ in calls))
        self.assertLessEqual(calls[0][2]['timeout'], 60)
        self.assertFalse(calls[1][2]['persist_session'])

    def test_logged_in_and_success_exit_without_challenge_reply_are_insufficient(self):
        with patch('server.health.cli.run_cli', return_value=None):
            self.health.refresh()
            states = self.finish()
        self.assertFalse(any(s['usable'] for s in states))
        self.assertNotEqual(states[0]['auth'], 'ready')

    def test_refresh_revokes_old_success_and_checks_again(self):
        def success(name, prompt, session, cwd, callback, cancelled, **settings):
            callback({'text': prompt.split('：', 1)[1].split('。', 1)[0]})
        with patch('server.health.cli.run_cli', side_effect=success):
            self.health.refresh()
            self.assertTrue(self.finish()[0]['usable'])
        with patch('server.health.cli.run_cli', side_effect=RuntimeError('登录失效')):
            self.health.refresh()
            self.assertFalse(self.finish()[0]['usable'])

    def test_concurrent_refresh_is_one_job_and_unverified_agents_remain_hidden(self):
        started, release = threading.Event(), threading.Event()
        def run(*args, **kwargs):
            started.set()
            release.wait(2)
        with patch('server.health.cli.run_cli', side_effect=run) as runner:
            self.health.refresh()
            self.assertTrue(started.wait(1))
            first = self.health.thread
            self.health.refresh()
            self.assertIs(self.health.thread, first)
            self.assertFalse(any(s['usable'] for s in self.health.snapshot()))
            release.set()
            self.finish()
            self.assertEqual(runner.call_count, 2)
        self.assertEqual(self.status.call_count, 1)

    def test_close_cancels_probe_and_prevents_new_jobs(self):
        started = threading.Event()
        def run(name, prompt, session, cwd, callback, cancelled, **settings):
            started.set()
            self.assertTrue(cancelled.wait(2))
            raise RuntimeError('已取消')
        with patch('server.health.cli.run_cli', side_effect=run) as runner:
            self.health.refresh()
            self.assertTrue(started.wait(1))
            first = self.health.thread
            self.health.close()
            self.assertFalse(first.is_alive())
            self.health.refresh()
            self.assertIs(self.health.thread, first)
            self.assertEqual(runner.call_count, 1)
            self.assertFalse(any(s['usable'] for s in self.health.snapshot()))
