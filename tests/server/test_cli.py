import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from server.cli import command, decode_event, run_cli, status
from server import models
from server.prompts import build_prompt


class CLITests(unittest.TestCase):
    def test_cli_result_does_not_repeat_already_emitted_assistant_text(self):
        cases = {
            'qoder': [
                {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': '第一段'}]}},
                {'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': '第二段'}]}},
                {'type': 'result', 'session_id': 'q1', 'result': '第二段'},
            ],
            'agy': [
                {'event': 'step_update', 'step_update': {'step_type': 'agent_response', 'text_delta': '第一段'}},
                {'event': 'step_update', 'step_update': {'step_type': 'agent_response', 'text_delta': '第二段'}},
                {'event': 'result', 'result': {'status': 'SUCCESS', 'conversation_id': 'a1', 'response': '第一段第二段'}},
            ],
        }
        for name, rows in cases.items():
            with self.subTest(cli=name), tempfile.TemporaryDirectory() as tmp:
                binary = Path(tmp, name)
                import json
                binary.write_text('#!/bin/sh\n' + '\n'.join("printf '%s\\n' '" + json.dumps(row, ensure_ascii=False) + "'" for row in rows) + '\n')
                binary.chmod(0o755)
                with patch.dict('os.environ', {'PATH': tmp}):
                    events = []
                    run_cli(name, 'hello', None, tmp, events.append, threading.Event(), timeout=5)
                self.assertEqual([event['text'] for event in events if event.get('text')], ['第一段', '第二段'])
                self.assertTrue(any(event.get('session') for event in events))
                if name == 'agy':
                    chunks = [event for event in events if event.get('text')]
                    self.assertTrue(all(event.get('type') == 'assistant' and event.get('delta') for event in chunks))
                    self.assertEqual(chunks[0]['message_id'], chunks[1]['message_id'])

    def test_qoder_variants_are_detected_and_used_for_models_and_execution(self):
        for name in ('qodercli', 'qoderclicn'):
            with self.subTest(binary=name), tempfile.TemporaryDirectory() as tmp:
                binary = Path(tmp, name)
                binary.write_text('''#!/bin/sh
case "$1" in
  --version) echo '1.1.67' ;;
  --list-models) printf 'MODEL\\nAuto\\nQwen3.8-Max\\nDeepSeek-V4-Pro\\n' ;;
  -p) printf '%s\\n' '{"type":"result","session_id":"q-cn","result":"ready"}' ;;
  *) exit 2 ;;
esac
''')
                binary.chmod(0o755)
                models.discover.cache_clear()
                self.addCleanup(models.discover.cache_clear)
                with patch.dict('os.environ', {'PATH': tmp}):
                    state = next(item for item in status() if item['id'] == 'qoder')
                    self.assertTrue(state['installed'])
                    self.assertEqual([item['id'] for item in state['models']],
                                     ['Auto', 'Qwen3.8-Max', 'DeepSeek-V4-Pro'])
                    argv, _ = command('qoder', 'hello', model='Qwen3.8-Max')
                    self.assertEqual(argv[0], str(binary))
                    events = []
                    run_cli('qoder', 'hello', None, tmp, events.append, threading.Event(), timeout=5)
                    self.assertEqual(events, [{'session': 'q-cn', 'text': 'ready'}])

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
        self.assertEqual(argv[argv.index('--resume') + 1], 'q-1')
        self.assertIn('--include-partial-messages', argv)
        probe, _ = command('qoder', 'hello', persist_session=False)
        self.assertIn('--no-session-persistence', probe)

    def test_qoder_partial_text_events_are_streamed(self):
        event = decode_event('qoder', {'type':'stream_event','event':{'type':'content_block_delta','delta':{'type':'text_delta','text':'前半段'}}})
        self.assertEqual(event.get('text'), '前半段')
        self.assertEqual(event.get('type'), 'assistant')
        self.assertTrue(event.get('delta'))
        with self.assertRaises(ValueError):
            command('unknown', 'hello')

    def test_distinct_terminal_information_and_repeated_real_messages_are_preserved(self):
        import json
        with tempfile.TemporaryDirectory() as tmp:
            rows = [{'type':'assistant','message':{'content':[{'type':'text','text':'重复的真实消息'}]}}] * 2
            rows.append({'type':'result','result':'仅结束结果提供的补充'})
            binary = Path(tmp,'qoder')
            binary.write_text('#!/bin/sh\n' + '\n'.join("printf '%s\\n' '" + json.dumps(row,ensure_ascii=False) + "'" for row in rows) + '\n')
            binary.chmod(0o755)
            with patch.dict('os.environ', {'PATH':tmp}):
                events=[]
                run_cli('qoder','hello',None,tmp,events.append,threading.Event(),timeout=5)
            self.assertEqual([e['text'] for e in events if e.get('text')],['重复的真实消息','重复的真实消息','仅结束结果提供的补充'])

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

    def test_prompt_is_exact_user_input_without_a_skill_prefix(self):
        user_text = '  用户原文\n出题  '
        for operation in ('auto', 'generate', 'grade'):
            self.assertEqual(build_prompt(operation, user_text), user_text)
        with self.assertRaises(ValueError):
            build_prompt('unknown', user_text)
