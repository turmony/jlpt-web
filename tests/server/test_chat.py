import json
import concurrent.futures
import sqlite3
import threading
import tempfile
import unittest
from pathlib import Path
from server.store import Store, Conflict


class ChatHistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'state.sqlite'

    def test_old_database_migrates_and_preserves_history(self):
        with sqlite3.connect(self.path) as db:
            db.execute('CREATE TABLE events (id INTEGER PRIMARY KEY, task TEXT, type TEXT, text TEXT, time REAL)')
            db.execute("INSERT INTO events VALUES (1,'task','message','旧答案',1)")
        store = Store(self.path)
        store.event('task', 'assistant', '增量', {'message_id': 'answer', 'delta': True, 'generation': 2})
        events = store.events('task')
        self.assertEqual(events[0]['text'], '旧答案')
        self.assertEqual(events[1]['data']['message_id'], 'answer')
        self.assertEqual(store.events('task', 1), events[1:])
        self.assertEqual(Store(self.path).events('task'), events)

    def test_enqueue_records_original_user_input_exactly_once_per_turn(self):
        store = Store(self.path)
        for generation in (0, 1):
            preview = {'task_id': 'task', 'cli': 'codex', 'generation': generation,
                       'text': f'用户原文 {generation}', 'prompt': f'包装后的提示词 {generation}'}
            store.put('previews', f'p{generation}', preview)
            first = store.enqueue(f'p{generation}')
            store.enqueue(f'p{generation}')
            self.assertEqual(first['transport'], 'acp')
            store.change('tasks', 'task', lambda task: task.update(status='waiting'))
        history = store.events('task')
        self.assertEqual([event['text'] for event in history], ['用户原文 0', '用户原文 1'])
        self.assertEqual([event['data']['generation'] for event in history], [1, 2])
        self.assertTrue(all(event['type'] == 'user' for event in history))

    def test_legacy_sessions_keep_their_known_transport(self):
        store = Store(self.path)
        store.put('tasks', 'old', {'id': 'old', 'cli': 'codex', 'session': 'old-exec-session', 'generation': 1, 'status': 'waiting'})
        store.put('previews', 'p', {'task_id': 'old', 'cli': 'codex', 'generation': 1, 'text': '继续', 'prompt': '继续'})
        self.assertEqual(store.enqueue('p')['transport'], 'exec')

    def test_archive_survives_restart_and_preserves_conversation_and_paper(self):
        store = Store(self.path)
        task = {'id': 'chat', 'cli': 'qoder', 'session': 'real-cli-session',
                'generation': 1, 'status': 'ready', 'paper_id': 'paper'}
        paper = {'id': 'paper', 'task_id': 'chat', 'draft': {'1': {'answer': '2'}}, 'score': 1}
        store.put('tasks', 'chat', task)
        store.put('papers', 'paper', paper)
        store.event('chat', 'user', '保留的原文')
        events = store.events('chat')
        archived = store.set_archived('chat', True)
        self.assertGreater(archived['archived_at'], 0)
        self.assertEqual(store.set_archived('chat', True)['archived_at'], archived['archived_at'])
        restarted = Store(self.path)
        self.assertEqual(restarted.get('tasks', 'chat'), archived)
        self.assertEqual(restarted.events('chat'), events)
        self.assertEqual(restarted.get('papers', 'paper'), paper)
        self.assertEqual(restarted.set_archived('chat', False), task)
        self.assertEqual(restarted.set_archived('chat', False), task)

    def test_processing_tasks_cannot_be_archived(self):
        store = Store(self.path)
        for status in ('queued', 'running', 'checking', 'committing'):
            task = {'id': 'busy', 'status': status, 'session': 'still-running'}
            store.put('tasks', 'busy', task)
            with self.subTest(status=status), self.assertRaises(Conflict):
                store.set_archived('busy', True)
            self.assertEqual(store.get('tasks', 'busy'), task)
        with self.assertRaises(ValueError):
            store.set_archived('busy', 'false')

    def test_archived_conversation_cannot_enqueue_until_restored(self):
        store = Store(self.path)
        store.put('tasks', 'chat', {'id': 'chat', 'cli': 'codex', 'session': 'resume-this',
                                  'generation': 1, 'status': 'waiting', 'transport': 'acp'})
        store.put('previews', 'p', {'task_id': 'chat', 'cli': 'codex', 'generation': 1,
                                  'text': '继续原会话', 'prompt': '继续原会话'})
        store.set_archived('chat', True)
        with self.assertRaises(Conflict):
            store.enqueue('p')
        self.assertFalse(store.get('previews', 'p').get('used', False))
        self.assertEqual(store.events('chat'), [])
        store.set_archived('chat', False)
        self.assertEqual(store.enqueue('p')['session'], 'resume-this')
        self.assertEqual(store.events('chat')[0]['text'], '继续原会话')

    def test_archive_and_send_cannot_both_succeed_when_tabs_race(self):
        store = Store(self.path)
        store.put('tasks', 'chat', {'id': 'chat', 'cli': 'codex', 'generation': 1, 'status': 'waiting'})
        store.put('previews', 'p', {'task_id': 'chat', 'cli': 'codex', 'generation': 1, 'prompt': '继续'})
        barrier = threading.Barrier(2)
        def race(action):
            barrier.wait()
            try:
                action()
                return True
            except Conflict:
                return False
        with concurrent.futures.ThreadPoolExecutor() as pool:
            archive = pool.submit(race, lambda: store.set_archived('chat', True))
            send = pool.submit(race, lambda: store.enqueue('p'))
            self.assertEqual(sum((archive.result(), send.result())), 1)
        task = store.get('tasks', 'chat')
        self.assertFalse(task.get('archived_at') and task['status'] == 'queued')

    def test_history_titles_use_first_user_message_and_dates_survive_archive(self):
        store = Store(self.path)
        task = {'id': 'old', 'cli': 'codex', 'status': 'waiting', 'session': 'original', 'updated': 200}
        store.put('tasks', 'old', task)
        store.event('old', 'assistant', '这不是标题')
        store.event('old', 'user', '请帮我推荐日本轻量云服务器，能运行 CLI。')
        store.event('old', 'user', '后续修改问题，不应替换标题')
        with store.connect() as db:
            db.execute('UPDATE events SET time=100+id WHERE task=?', ('old',))
        history = store.history_tasks()
        self.assertEqual(history[0]['title'], '日本轻量云服务器推荐')
        self.assertEqual(history[0]['created_at'], 101)
        self.assertEqual(history[0]['last_activity'], 200)
        self.assertEqual(store.get('tasks', 'old'), task)
        store.set_archived('old', True)
        archived = Store(self.path).history_tasks()[0]
        self.assertEqual(archived['title'], history[0]['title'])
        self.assertEqual(archived['last_activity'], history[0]['last_activity'])
        store.set_archived('old', False)
        self.assertEqual(store.history_tasks()[0], history[0])

    def test_new_conversation_keeps_first_title_after_continuation(self):
        store = Store(self.path)
        store.put('previews', 'p', {'task_id': 'new', 'cli': 'codex', 'generation': 0,
                                  'text': '请帮我解释 N3 助词用法。举例说明。', 'prompt': '内部包装的提示词'})
        first = store.enqueue('p')
        self.assertEqual(first['title'], 'N3 助词用法解释')
        self.assertGreater(first['created_at'], 0)
        store.change('tasks', 'new', lambda t: t.update(status='waiting'))
        store.put('previews', 'p2', {'task_id': 'new', 'cli': 'codex', 'generation': 1,
                                   'text': '改为 N1', 'prompt': '内部包装的续写提示词'})
        second = store.enqueue('p2')
        self.assertEqual(second['title'], first['title'])
        self.assertEqual(second['created_at'], first['created_at'])

    def test_missing_first_message_uses_unnamed_title_and_zero_date(self):
        store = Store(self.path)
        store.put('tasks', 'missing', {'id': 'missing', 'cli': 'qoder', 'status': 'failed'})
        item = store.history_tasks()[0]
        self.assertEqual(item['title'], '未命名对话')
        self.assertEqual(item['last_activity'], 0)

    def test_legacy_history_uses_earliest_executed_original_preview_text(self):
        store = Store(self.path)
        store.put('tasks', 'old', {'id': 'old', 'cli': 'codex', 'status': 'waiting'})
        store.put('previews', 'later', {'task_id': 'old', 'used': True, 'generation': 1,
                                      'text': '换一个主题', 'prompt': '内部提示词'})
        store.put('previews', 'first', {'task_id': 'old', 'used': True, 'generation': 0,
                                      'text': '请帮我推荐日本轻量云服务器。', 'prompt': '内部提示词'})
        store.put('previews', 'unused', {'task_id': 'old', 'used': False, 'generation': 0,
                                       'text': '没有发送的草稿'})
        self.assertEqual(store.history_tasks()[0]['title'], '日本轻量云服务器推荐')

    def test_legacy_title_does_not_become_a_new_continuation_message(self):
        store = Store(self.path)
        store.put('tasks', 'old', {'id': 'old', 'cli': 'codex', 'status': 'waiting'})
        store.put('previews', 'first', {'task_id': 'old', 'used': True, 'generation': 0,
                                      'text': '请帮我推荐日本轻量云服务器。'})
        store.event('old', 'user', '请帮我解释新的语法问题', {'generation': 2})
        self.assertEqual(store.history_tasks()[0]['title'], '日本轻量云服务器推荐')
        store.event('old', 'user', '再次更换话题', {'generation': 3})
        self.assertEqual(Store(self.path).history_tasks()[0]['title'], '日本轻量云服务器推荐')

    def test_first_user_event_wins_over_a_later_remaining_preview(self):
        store = Store(self.path)
        store.put('tasks', 'old', {'id': 'old', 'cli': 'codex', 'status': 'waiting'})
        store.put('previews', 'later', {'task_id': 'old', 'used': True, 'generation': 2,
                                      'text': '请帮我解释新的语法问题'})
        store.event('old', 'user', '请帮我推荐日本轻量云服务器。', {'generation': 1})
        self.assertEqual(store.history_tasks()[0]['title'], '日本轻量云服务器推荐')

    def test_short_introduction_questions_get_readable_summaries(self):
        from server.history import summarize_first_message
        self.assertEqual(summarize_first_message('介绍你自己'), '智能体介绍')
        self.assertEqual(summarize_first_message('你是什么模型？'), '模型介绍')
