import json
import os
import tempfile
import unittest
import shutil
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
        with patch.dict(os.environ, self.acp_environment()):
            self.store.put('previews', 'p', {'task_id': 'task', 'cli': 'codex', 'prompt': 'web/task/turn-1.json', 'generation': 0})
            self.store.enqueue('p')
            self.assertTrue(self.worker.run_once())
            task = self.store.get('tasks', 'task')
            self.assertEqual(task['status'], 'waiting')
            self.assertEqual(task['session'], 'fixture-session')
            self.assertTrue(any(e['type'] == 'assistant' and e.get('data', {}).get('delta') for e in self.store.events('task')))
            self.assertIn('请补充范围', [e['text'] for e in self.store.events('task')])
            self.store.put('previews', 'p2', {'task_id': 'task', 'cli': 'codex', 'prompt': 'web/task/turn-2.json', 'generation': 1})
            self.store.enqueue('p2')
            self.worker.run_once()
            self.assertEqual(self.store.get('tasks', 'task')['session'], 'fixture-session')

    def acp_environment(self):
        return {'JLPT_CODEX_ACP_COMMAND': shutil.which('node'),
                'JLPT_CODEX_ACP_ARGS': json.dumps([str(Path('tests/agent/fake-acp.mjs').resolve())])}

    def test_plain_conversation_succeeds_without_artifact_handoff(self):
        self.store.put('previews', 'chat', {'task_id': 'chat', 'cli': 'qoder', 'prompt': '介绍你自己', 'operation': 'auto', 'generation': 0})
        self.store.enqueue('chat')
        def reply(cli, prompt, session, cwd, callback, cancelled, **settings):
            callback({'text': '我是你的智能体助手。'})
        with patch('server.worker.run_cli', side_effect=reply):
            self.worker.run_once()
        task = self.store.get('tasks', 'chat')
        self.assertEqual(task['status'], 'answered')
        self.assertIsNone(task.get('error'))
        self.assertEqual([event['text'] for event in self.store.events('chat') if event['type'] == 'message'], ['我是你的智能体助手。'])
        finishes = [event['data'] for event in self.store.events('chat') if event['type'] == 'finish']
        self.assertEqual(len(finishes), 1)
        self.assertEqual(finishes[0]['generation'], 1)
        self.assertGreaterEqual(finishes[0]['elapsed_seconds'], 0)
        self.assertIsNotNone(task.get('started_at'))
        self.assertGreaterEqual(task['finished_at'], task['started_at'])

    def test_cli_error_and_process_failure_are_shown_once(self):
        self.store.put('previews', 'error', {'task_id': 'error', 'cli': 'qoder', 'prompt': '你好', 'operation': 'auto', 'generation': 0})
        self.store.enqueue('error')
        def fail(cli, prompt, session, cwd, callback, cancelled, **settings):
            callback({'error': '模型服务连接失败'})
            raise RuntimeError('模型服务连接失败')
        with patch('server.worker.run_cli', side_effect=fail):
            self.worker.run_once()
        self.assertEqual(self.store.get('tasks', 'error')['status'], 'failed')
        errors = [event['text'] for event in self.store.events('error') if event['type'] == 'error']
        self.assertEqual(errors, ['模型服务连接失败'])

    def test_actual_artifact_changes_and_explicit_generation_still_require_handoff(self):
        for operation, write_artifact in [('generate', False), ('auto', True)]:
            with self.subTest(operation=operation):
                task_id = operation
                self.store.put('previews', operation, {'task_id': task_id, 'cli': 'qoder', 'prompt': '出卷', 'operation': operation, 'generation': 0})
                self.store.enqueue(operation)
                def reply(cli, prompt, session, cwd, callback, cancelled, **settings):
                    callback({'text': '完成'})
                    if write_artifact:
                        path = self.root/'jlpt-notes/quizzes/papers/new.md'
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text('未验证试卷')
                with patch('server.worker.run_cli', side_effect=reply):
                    self.worker.run_once()
                task = self.store.get('tasks', task_id)
                self.assertEqual(task['status'], 'failed')
                self.assertIn('交接', task['error'])

    def test_handoff_message_is_not_a_second_copy_of_assistant_reply(self):
        self.store.put('previews', 'p', {'task_id': 'same', 'cli': 'qoder', 'prompt': '范围', 'operation': 'auto', 'generation': 0})
        self.store.enqueue('p')
        def reply(cli, prompt, session, cwd, callback, cancelled, **settings):
            callback({'text': '请补充范围'})
            path=self.root/'jlpt-notes/quizzes/web/same/turn-1.json'
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({'task_id':'same','turn':1,'operation':'clarify','message':'请补充范围'}))
        with patch('server.worker.run_cli', side_effect=reply):
            self.worker.run_once()
        self.assertEqual([e['text'] for e in self.store.events('same') if e['type']=='message'], ['请补充范围'])

    def test_cancel_during_final_artifact_check_cannot_become_answered(self):
        self.store.put('previews', 'cancel', {'task_id':'cancel-chat','cli':'qoder','prompt':'你好','operation':'auto','generation':0})
        self.store.enqueue('cancel')
        original=self.worker.quiz_snapshot
        snapshots=0
        def snapshot():
            nonlocal snapshots
            snapshots+=1
            if snapshots==2:
                self.worker.cancel('cancel-chat')
            return original()
        def reply(cli,prompt,session,cwd,callback,cancelled,**settings):
            callback({'text':'你好'})
        with patch('server.worker.run_cli',side_effect=reply), patch.object(self.worker,'quiz_snapshot',side_effect=snapshot):
            self.worker.run_once()
        self.assertEqual(self.store.get('tasks','cancel-chat')['status'],'cancelled')

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
        with patch.dict(os.environ, self.acp_environment()):
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
