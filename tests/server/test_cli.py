import unittest
from server.cli import command, decode_event
from server.prompts import build_prompt


class CLITests(unittest.TestCase):
    def test_resume_uses_specific_session_and_no_shell(self):
        prompt = '题目 $(touch /tmp/bad); `whoami`'
        argv, stdin = command('codex', prompt, 's-1')
        self.assertEqual(argv[:3], ['codex', 'exec', 'resume'])
        self.assertEqual(argv[-2:], ['s-1', '-'])
        self.assertEqual(stdin, prompt)
        argv, stdin = command('agy', prompt, 'a-1')
        self.assertIn('--conversation', argv)
        self.assertEqual(argv[argv.index('--conversation') + 1], 'a-1')
        self.assertEqual(argv[argv.index('-p') + 1], prompt)
        argv, _ = command('qoder', prompt, 'q-1')
        self.assertEqual(argv[argv.index('--session-id') + 1], 'q-1')
        with self.assertRaises(ValueError):
            command('unknown', prompt)

    def test_actual_cli_event_shapes(self):
        self.assertEqual(decode_event('codex', {'type': 'thread.started', 'thread_id': 'c'}), {'session': 'c'})
        self.assertEqual(decode_event('codex', {'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'hello'}})['text'], 'hello')
        self.assertEqual(decode_event('agy', {'event': 'init', 'conversation_id': 'a'})['session'], 'a')
        self.assertEqual(decode_event('agy', {'event': 'result', 'result': {'conversation_id': 'a', 'status': 'ERROR', 'response': 'question', 'error': 'login'}})['error'], 'login')
        event = decode_event('qoder', {'type': 'assistant', 'session_id': 'q', 'message': {'content': [{'type': 'text', 'text': '请补充'}]}})
        self.assertEqual(event, {'session': 'q', 'text': '请补充'})

    def test_model_and_effort_are_passed_for_new_and_resumed_sessions(self):
        for session in (None, 'existing-session'):
            for cli, effort_flag in [('codex', '-c'), ('agy', '--effort'), ('qoder', '--reasoning-effort')]:
                argv, _ = command(cli, '用户原文', session, model='example-model', effort='high')
                self.assertEqual(argv[argv.index('--model') + 1], 'example-model')
                if cli == 'codex':
                    self.assertIn('model_reasoning_effort="high"', argv)
                else:
                    self.assertEqual(argv[argv.index(effort_flag) + 1], 'high')

    def test_prompt_contains_only_selected_skill_and_unchanged_user_input(self):
        user_text = '  用户原文\n出题  '
        for operation, name, label in [('generate', 'quiz-generate', '出卷'), ('grade', 'quiz-grade', '判卷')]:
            self.assertEqual(build_prompt(operation, user_text),
                             f'请使用{label} skill：.claude/skills/{name}/SKILL.md\n\n{user_text}')
        with self.assertRaises(ValueError):
            build_prompt('unknown', user_text)
