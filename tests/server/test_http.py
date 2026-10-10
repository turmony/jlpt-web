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

    def request(self, path, data=None, origin='http://test.local'):
        headers = {'Cookie': self.cookie}
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
        first = json.load(self.request('/api/tasks', {'preview_id': preview['id']}))
        second = json.load(self.request('/api/tasks', {'preview_id': preview['id']}))
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(first['prompt'], preview['prompt'])
        self.assertEqual(self.request('/api/previews', {'cli': 'bad', 'text': 'x'}).status, 400)

    def test_drafts_and_submission_are_persisted_and_locked(self):
        self.login()
        self.app.store.put('papers', 'slug', {'id': 'slug', 'questions': [{'number': 1}], 'draft': {}, 'version': 0})
        response = self.request('/api/papers/slug/draft', {'answers': {'1': {'answer': '2'}}, 'version': 0})
        self.assertEqual(response.status, 200)
        first = json.load(self.request('/api/papers/slug/submit', {'version': 1}))
        second = json.load(self.request('/api/papers/slug/submit', {'version': 1}))
        self.assertEqual(first['submission']['id'], second['submission']['id'])
        self.assertEqual(self.request('/api/papers/slug/draft', {'answers': {}, 'version': 1}).status, 409)

    def test_selected_skill_is_preserved_from_preview_through_execution(self):
        self.login()
        for operation, skill in [('generate', 'quiz-generate'), ('grade', 'quiz-grade')]:
            preview = json.load(self.request('/api/previews', {'cli': 'codex', 'operation': operation, 'text': '用户原文'}))
            self.assertEqual(preview['operation'], operation)
            self.assertIn(f'.claude/skills/{skill}/SKILL.md', preview['prompt'])
            self.assertLess(len(preview['prompt']), 100)
            task = json.load(self.request('/api/tasks', {'preview_id': preview['id']}))
            self.assertEqual(task['operation'], operation)
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
