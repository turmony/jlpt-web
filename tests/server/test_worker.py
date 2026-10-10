import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from server.store import Store
from server.worker import Worker


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / 'state.sqlite')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        shim = self.bin / 'codex'
        shim.write_text('''#!/usr/bin/env python3
import json, re, sys
from pathlib import Path
text = sys.stdin.read()
context = json.loads(Path('jlpt-notes/quizzes/web/current-turn.json').read_text())
task, turn = context['task_id'], str(context['turn'])
folder = Path('jlpt-notes/quizzes/web') / task
folder.mkdir(parents=True, exist_ok=True)
(folder / ('turn-' + turn + '.json')).write_text(json.dumps({'task_id':task,'turn':int(turn),'operation':'clarify','message':'请补充范围'}))
print(json.dumps({'type':'thread.started','thread_id':'persistent-session'}))
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'请补充范围'}}))
''')
        shim.chmod(0o755)
        self.worker = Worker(self.store, self.root)
        self.addCleanup(self.worker.close)

    def test_real_subprocess_persists_message_and_resumes_same_session(self):
        with patch.dict(os.environ, {'PATH': str(self.bin) + ':' + os.environ['PATH']}):
            self.store.put('previews', 'p', {'task_id': 'task', 'cli': 'codex', 'prompt': 'web/task/turn-1.json', 'generation': 0})
            self.store.enqueue('p')
            self.assertTrue(self.worker.run_once())
            task = self.store.get('tasks', 'task')
            self.assertEqual(task['status'], 'waiting')
            self.assertEqual(task['session'], 'persistent-session')
            self.assertIn('请补充范围', [e['text'] for e in self.store.events('task')])
            self.store.put('previews', 'p2', {'task_id': 'task', 'cli': 'codex', 'prompt': 'web/task/turn-2.json', 'generation': 1})
            self.store.enqueue('p2')
            self.worker.run_once()
            self.assertEqual(self.store.get('tasks', 'task')['session'], 'persistent-session')

    def test_missing_cli_is_failure_and_cancelled_queue_never_runs(self):
        self.store.put('previews', 'p', {'task_id': 'task', 'cli': 'qoder', 'prompt': 'x', 'generation': 0})
        self.store.enqueue('p')
        with patch.dict(os.environ, {'PATH': str(self.bin)}):
            self.worker.run_once()
        self.assertEqual(self.store.get('tasks', 'task')['status'], 'failed')
        self.assertIn('qoder', self.store.get('tasks', 'task')['error'])
        self.store.put('previews', 'p2', {'task_id': 'task', 'cli': 'qoder', 'prompt': 'x', 'generation': 1})
        self.store.enqueue('p2')
        self.worker.cancel('task')
        self.assertFalse(self.worker.run_once())
        self.assertEqual(self.store.get('tasks', 'task')['status'], 'cancelled')

    def test_short_prompt_uses_current_context_and_preserves_existing_workspace_rules(self):
        rules = self.root / 'AGENTS.md'
        original = '# Existing study rules\nKeep learner text.\n'
        rules.write_text(original)
        prompt = '请使用判卷 skill：.claude/skills/quiz-grade/SKILL.md\n\n请补充'
        with patch.dict(os.environ, {'PATH': str(self.bin) + ':' + os.environ['PATH']}):
            for generation in (0, 1):
                self.store.put('previews', f'p{generation}', {'task_id': 'task', 'cli': 'codex',
                    'prompt': prompt, 'operation': 'grade', 'generation': generation})
                self.store.enqueue(f'p{generation}')
                self.worker.run_once()
                self.assertEqual(self.store.get('tasks', 'task')['status'], 'waiting')
                context = json.loads((self.root / 'jlpt-notes/quizzes/web/current-turn.json').read_text())
                self.assertEqual(context['task_id'], 'task')
                self.assertEqual(context['turn'], generation + 1)
                self.assertEqual(context['operation'], 'grade')
                self.assertEqual(context['handoff'], f'jlpt-notes/quizzes/web/task/turn-{generation + 1}.json')
        self.assertTrue(rules.read_text().startswith(original))
        self.assertEqual(rules.read_text().count('<!-- jlpt-web-workflow:start -->'), 1)
        self.assertIn('git push', rules.read_text())
        self.assertIn('attempts.jsonl', rules.read_text())
