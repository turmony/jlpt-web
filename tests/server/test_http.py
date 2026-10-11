import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
from pathlib import Path
from server.app import Application, create_server
from server.auth import Auth


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.static = root / 'static'
        self.static.mkdir()
        (self.static / 'index.html').write_text('private home')
        (self.static / 'login.html').write_text('login page')
        (self.static / 'login.mjs').write_text('login script')
        config = {'state': str(root), 'study': str(root / 'study'), 'static': str(self.static),
                  'origin': 'http://test.local', 'secure_cookie': False, 'password_hash': Auth.hash_password('secret')}
        self.app = Application(config)
        self.server = create_server(self.app, ('127.0.0.1', 0))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.cookie = ''

    def request(self, path, data=None, origin='http://test.local', extra_headers=None):
        headers = {'Cookie': self.cookie, **(extra_headers or {})}
        if data is not None:
            headers.update({'Content-Type': 'application/json', 'Origin': origin})
        req = urllib.request.Request(self.url + path, data=None if data is None else json.dumps(data).encode(), headers=headers)
        try:
            return urllib.request.urlopen(req)
        except urllib.error.HTTPError as error:
            return error

    def login(self):
        response = self.request('/api/login', {'password': 'secret'})
        self.assertEqual(response.status, 200)
        self.cookie = response.headers['Set-Cookie'].split(';')[0]

    def test_every_resource_needs_same_auth_and_csrf_is_rejected(self):
        for path in ('/api/tasks', '/catalog.json', '/images/test.png', '/auth/check'):
            self.assertEqual(self.request(path).status, 401)
        self.assertEqual(self.request('/login.html').status, 200)
        self.assertEqual(self.request('/api/login', {'password': 'wrong'}).status, 401)
        self.login()
        self.assertEqual(self.request('/auth/check').status, 200)
        self.assertEqual(self.request('/index.html').read(), b'private home')
        self.assertEqual(self.request('/api/logout', {}, origin='https://evil.example').status, 403)
        self.assertEqual(self.request('/api/logout', {}).status, 200)
        self.assertEqual(self.request('/auth/check').status, 401)

    def test_execute_uses_saved_preview_and_duplicate_request_is_safe(self):
        self.login()
        response = self.request('/api/previews', {'cli': 'codex', 'text': '自由文本'})
        self.assertEqual(response.status, 201)
        preview = json.load(response)
        self.assertEqual(preview['operation'], 'auto')
        first = json.load(self.request('/api/tasks', {'preview_id': preview['id']}))
        second = json.load(self.request('/api/tasks', {'preview_id': preview['id']}))
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(first['prompt'], preview['prompt'])
        self.assertEqual(self.request('/api/previews', {'cli': 'bad', 'text': 'x'}).status, 400)

    def test_diagnostic_refresh_requires_auth_origin_and_rechecks_health(self):
        from unittest.mock import Mock
        self.app.health = Mock()
        self.app.health.snapshot.return_value = [{'id': 'codex', 'usable': False, 'checking': True}]
        self.assertEqual(self.request('/api/clis/refresh', {}).status, 401)
        self.app.health.refresh.assert_not_called()
        self.login()
        self.assertEqual(self.request('/api/clis/refresh', {}, origin='https://other.example').status, 403)
        self.app.health.refresh.assert_not_called()
        self.assertEqual(self.request('/api/clis/refresh', {}).status, 202)
        self.app.health.refresh.assert_called_once()
        states = json.load(self.request('/api/clis'))
        self.assertFalse(states[0]['usable'])
        self.assertTrue(states[0]['checking'])

    def test_drafts_and_submission_are_persisted_and_locked(self):
        self.login()
        self.app.store.put('papers', 'slug', {'id': 'slug', 'questions': [{'number': 1}], 'draft': {}, 'version': 0})
        response = self.request('/api/papers/slug/draft', {'answers': {'1': {'answer': '2'}}, 'version': 0})
        self.assertEqual(response.status, 200)
        first = json.load(self.request('/api/papers/slug/submit', {'version': 1}))
        second = json.load(self.request('/api/papers/slug/submit', {'version': 1}))
        self.assertEqual(first['submission']['id'], second['submission']['id'])
        self.assertEqual(self.request('/api/papers/slug/draft', {'answers': {}, 'version': 1}).status, 409)

    def test_archive_requires_auth_and_origin_and_preserves_linked_records(self):
        self.app.store.put('tasks', 'chat', {'id': 'chat', 'cli': 'codex', 'status': 'ready',
                                          'generation': 1, 'session': 'cli-session'})
        self.app.store.event('chat', 'assistant', '保留的答案')
        self.app.store.put('papers', 'paper', {'id': 'paper', 'task_id': 'chat', 'score': 1})
        self.assertEqual(self.request('/api/tasks/chat/archive', {'archived': True}).status, 401)
        self.login()
        self.assertEqual(self.request('/api/tasks/chat/archive', {'archived': True}, origin='https://evil.example').status, 403)
        self.assertEqual(self.request('/api/tasks/chat/archive', {'archived': 'true'}).status, 400)
        self.assertEqual(self.request('/api/tasks/missing/archive', {'archived': True}).status, 404)
        response = self.request('/api/tasks/chat/archive', {'archived': True})
        self.assertEqual(response.status, 200)
        archived = json.load(response)
        self.assertGreater(archived['archived_at'], 0)
        self.assertEqual(archived['session'], 'cli-session')
        self.assertEqual(json.load(self.request('/api/tasks'))[0]['archived_at'], archived['archived_at'])
        self.assertEqual(json.load(self.request('/api/tasks/chat/events'))[0]['text'], '保留的答案')
        self.assertEqual(json.load(self.request('/api/papers/paper'))['score'], 1)
        self.assertEqual(self.request('/api/previews', {'task_id': 'chat', 'cli': 'codex', 'text': '继续'}).status, 409)
        self.assertEqual(self.request('/api/tasks/chat/commit', {}).status, 409)
        response = self.request('/api/tasks/chat/archive', {'archived': False})
        self.assertEqual(response.status, 200)
        self.assertNotIn('archived_at', json.load(response))
        self.app.store.change('tasks', 'chat', lambda task: task.update(status='running'))
        self.assertEqual(self.request('/api/tasks/chat/archive', {'archived': True}).status, 409)

    def test_commit_retry_rechecks_archive_after_http_snapshot_is_read(self):
        from server.worker import Worker
        self.login()
        self.app.worker = Worker(self.app.store, self.app.config['study'])
        self.addCleanup(self.app.worker.close)
        self.app.store.put('tasks', 'chat', {'id': 'chat', 'status': 'commit_failed',
                                          'grade': {'score': 1}, 'session': 'original-session'})
        original_get = self.app.store.get
        def read_then_archive(kind, key):
            task = original_get(kind, key)
            if kind == 'tasks' and key == 'chat':
                self.app.store.set_archived(key, True)
            return task
        with patch.object(self.app.store, 'get', side_effect=read_then_archive):
            self.assertEqual(self.request('/api/tasks/chat/commit', {}).status, 409)
        task = self.app.store.get('tasks', 'chat')
        self.assertEqual(task['status'], 'commit_failed')
        self.assertGreater(task['archived_at'], 0)
        self.assertEqual(task['session'], 'original-session')
        self.app.store.set_archived('chat', False)
        self.assertEqual(self.request('/api/tasks/chat/commit', {}).status, 200)
        self.assertEqual(self.app.store.get('tasks', 'chat')['status'], 'queued')

    def test_history_response_names_existing_conversations_without_changing_records(self):
        self.login()
        task = {'id': 'old', 'cli': 'qoder', 'status': 'waiting', 'session': 'cli-session'}
        self.app.store.put('tasks', 'old', task)
        self.app.store.event('old', 'user', '请帮我推荐日本轻量云服务器。')
        self.app.store.event('old', 'user', '第二条消息')
        response = self.request('/api/tasks')
        self.assertEqual(response.status, 200)
        history = json.load(response)
        self.assertEqual(history[0]['title'], '日本轻量云服务器推荐')
        self.assertGreater(history[0]['last_activity'], 0)
        self.assertEqual(self.app.store.get('tasks', 'old'), task)

    def test_chat_stream_is_authenticated_and_resumes_after_event_cursor(self):
        self.app.store.put('tasks', 'chat', {'id': 'chat', 'cli': 'codex', 'status': 'waiting'})
        self.app.store.event('chat', 'user', '问题')
        self.app.store.event('chat', 'assistant', '答案', {'message_id': 'reply', 'delta': True})
        events = self.app.store.events('chat')
        self.assertEqual(self.request('/api/tasks/chat/stream').status, 401)
        self.login()
        response = self.request(f"/api/tasks/chat/stream?after={events[0]['id']}")
        self.assertEqual(response.headers['Content-Type'], 'text/event-stream; charset=utf-8')
        body = response.read().decode()
        self.assertIn('答案', body)
        self.assertNotIn('问题', body)
        self.assertIn('event: task', body)
        resumed = self.request('/api/tasks/chat/stream?after=0', extra_headers={'Last-Event-ID': str(events[0]['id'])}).read().decode()
        self.assertNotIn('问题', resumed)
        self.assertIn('答案', resumed)
        self.assertEqual(self.request('/api/tasks/chat/stream?after=-1').status, 400)

    def test_completed_stream_drains_history_before_terminal_state(self):
        self.login()
        self.app.store.put('tasks', 'long', {'id': 'long', 'status': 'waiting'})
        with self.app.store.connect() as db:
            db.executemany('INSERT INTO events(task,type,text,time) VALUES (?,?,?,?)',
                           [('long', 'assistant', f'chunk-{number}', 1) for number in range(501)])
        body = self.request('/api/tasks/long/stream').read().decode()
        self.assertEqual(body.count('event: message'), 501)
        self.assertLess(body.index('chunk-500'), body.index('event: task'))

    def test_selected_operation_keeps_exact_user_input_through_execution(self):
        self.login()
        for operation in ('generate', 'grade'):
            preview = json.load(self.request('/api/previews', {'cli': 'codex', 'operation': operation, 'text': '用户原文'}))
            self.assertEqual(preview['operation'], operation)
            self.assertEqual(preview['prompt'], '用户原文')
            self.assertLess(len(preview['prompt']), 100)
            task = json.load(self.request('/api/tasks', {'preview_id': preview['id']}))
            self.assertEqual(task['operation'], operation)
            self.assertEqual(task['prompt'], '用户原文')
        self.assertEqual(self.request('/api/previews', {'cli': 'codex', 'operation': 'other', 'text': '用户原文'}).status, 400)

    def test_model_selection_is_validated_and_execution_uses_saved_selection(self):
        self.login()
        catalog = {'models': [{'id': 'example', 'label': 'Example', 'efforts': ['low', 'high']}], 'efforts': ['low', 'high']}
        with patch('server.models.catalog', return_value=catalog):
            preview = json.load(self.request('/api/previews', {'cli': 'codex', 'text': '用户原文', 'model': 'example', 'effort': 'high'}))
            task = json.load(self.request('/api/tasks', {'preview_id': preview['id'], 'model': 'tampered', 'effort': 'low'}))
            self.assertEqual((task['model'], task['effort']), ('example', 'high'))
            self.assertEqual(task['prompt'], preview['prompt'])
            for model, effort in [('wrong', 'high'), ('example', 'max')]:
                self.assertEqual(self.request('/api/previews', {'cli': 'codex', 'text': '用户原文', 'model': model, 'effort': effort}).status, 400)

    def test_traversal_and_encoded_paths_do_not_serve_secrets(self):
        self.login()
        self.assertEqual(self.request('/%2e%2e/state.sqlite').status, 404)
        (self.static / 'secret').symlink_to(Path(self.tmp.name) / 'state.sqlite')
        self.assertEqual(self.request('/secret').status, 404)
