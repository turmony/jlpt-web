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

    def test_prompt_preserves_input_and_handoff_identity(self):
        text = build_prompt('t-1', 2, '用户原文\n出题', [])
        self.assertIn('用户原文\n出题', text)
        self.assertIn('web/t-1/turn-2.json', text)
        self.assertIn('git push', text)
        self.assertIn('attempts.jsonl', text)
