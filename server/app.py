import json
import mimetypes
import re
import threading
import time
import uuid
from collections import defaultdict
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit, parse_qs

from . import cli, models
from .artifacts import safe_file
from .auth import Auth, YEAR
from .prompts import build_prompt
from .store import Store, Conflict


class Application:
    def __init__(self, config):
        self.config = config
        state = Path(config['state'])
        state.mkdir(parents=True, exist_ok=True)
        self.store = Store(state / 'state.sqlite')
        self.auth = Auth(self.store, config['password_hash'])
        self.worker = None
        self.attempts = defaultdict(list)
        self.auth_lock = threading.Lock()

    def preview(self, data):
        text = data.get('text')
        executor = data.get('cli')
        operation = data.get('operation', 'generate')
        if executor not in cli.CLIS or not isinstance(text, str) or not text.strip() or len(text) > 20000:
            raise ValueError('请选择 CLI 并输入有效提示词（最多 20000 字符）')
        model, effort = models.validate_selection(models.catalog(executor), data.get('model', ''), data.get('effort', ''))
        task_id = data.get('task_id') or str(uuid.uuid4())
        generation = 0
        if data.get('task_id'):
            task = self.store.get('tasks', task_id)
            if task['cli'] != executor:
                raise Conflict('会话不能跨 CLI 继续')
            generation = task['generation']
        preview = {'id': str(uuid.uuid4()), 'task_id': task_id, 'cli': executor, 'generation': generation,
                   'model': model, 'effort': effort, 'operation': operation, 'text': text, 'prompt': build_prompt(operation, text)}
        return self.store.put('previews', preview['id'], preview)


def create_server(app, address):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, format, *args):
            # No passwords, prompt bodies, cookies or CLI credentials in access logs.
            pass

        def reply(self, status, body, content_type='application/json; charset=utf-8', headers=None):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Connection', 'close')
            self.close_connection = True
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'same-origin')
            self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def token(self):
            try:
                cookie = SimpleCookie(self.headers.get('Cookie', ''))
                return cookie['jlpt_session'].value if 'jlpt_session' in cookie else ''
            except Exception:
                return ''

        def json_body(self):
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                raise ValueError('请求必须使用 JSON')
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 256000:
                raise ValueError('请求大小无效')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('请求必须是对象')
            return body

        def cookie(self, token, age=YEAR):
            return f'jlpt_session={token}; Max-Age={age}; Path=/; HttpOnly; SameSite=Strict' + ('; Secure' if app.config.get('secure_cookie', True) else '')

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            self.dispatch()

        def do_POST(self):
            self.dispatch()

        def dispatch(self):
            try:
                self.route()
            except Conflict as error:
                self.reply(409, {'error': str(error)})
            except KeyError:
                self.reply(404, {'error': '记录不存在'})
            except (ValueError, TypeError) as error:
                self.reply(400, {'error': str(error)})
            except Exception as error:
                self.reply(500, {'error': '服务器处理失败：' + str(error)[:1000]})

        def route(self):
            parsed = urlsplit(self.path)
            path = unquote(parsed.path)
            post = self.command == 'POST'
            if post and self.headers.get('Origin') != app.config['origin']:
                self.close_connection = True
                return self.reply(403, {'error': '请求来源不匹配'})
            if path == '/api/login' and post:
                data = self.json_body()
                with app.auth_lock:
                    host = self.client_address[0]
                    now = time.time()
                    app.attempts[host] = [t for t in app.attempts[host] if t > now - 300]
                    if len(app.attempts[host]) >= 10:
                        return self.reply(429, {'error': '尝试过多，请五分钟后再试'})
                    token = app.auth.login(data.get('password'))
                    if not token:
                        app.attempts[host].append(now)
                        return self.reply(401, {'error': '密码错误'})
                    app.attempts[host] = []
                return self.reply(200, {'ok': True}, headers={'Set-Cookie': self.cookie(token)})
            if path in ('/login.html', '/login.mjs', '/site.css') and not post:
                return self.static(path)
            token = self.token()
            if not app.auth.check(token):
                return self.reply(401, {'error': '请登录'})
            if path == '/auth/check':
                return self.reply(200, {'ok': True})
            if path == '/api/logout' and post:
                self.json_body()
                app.auth.logout(token)
                return self.reply(200, {'ok': True}, headers={'Set-Cookie': self.cookie('', 0)})
            if path == '/api/session':
                return self.reply(200, {'ok': True})
            if path == '/api/clis' and not post:
                states = cli.status()
                tasks = app.store.list('tasks')
                for item in states:
                    recent = sorted((task for task in tasks if task.get('cli') == item['id']), key=lambda task: task.get('updated', 0), reverse=True)
                    if recent and recent[0].get('error'):
                        item['last_error'] = recent[0]['error']
                        item['detail'] += '；上次运行：' + recent[0]['error']
                return self.reply(200, states)
            if path == '/api/previews' and post:
                return self.reply(201, app.preview(self.json_body()))
            if path == '/api/tasks':
                if post:
                    task = app.store.enqueue(self.json_body()['preview_id'])
                    if app.worker:
                        app.worker.wake()
                    return self.reply(202, task)
                return self.reply(200, app.store.list('tasks'))
            if path == '/api/papers' and not post:
                return self.reply(200, app.store.list('papers'))
            match = re.fullmatch(r'/api/tasks/([a-zA-Z0-9-]+)(?:/(events|cancel|commit))?', path)
            if match:
                task_id, action = match.groups()
                task = app.store.get('tasks', task_id)
                if action == 'events' and not post:
                    after = int(parse_qs(parsed.query).get('after', [0])[0])
                    return self.reply(200, app.store.events(task_id, after))
                if action in ('cancel', 'commit') and post:
                    self.json_body()
                    if not app.worker:
                        raise Conflict('任务执行器未启动')
                    result = app.worker.cancel(task_id) if action == 'cancel' else app.worker.retry_commit(task_id)
                    return self.reply(200, result)
                if not action and not post:
                    return self.reply(200, task)
            match = re.fullmatch(r'/api/papers/([a-zA-Z0-9-]+)(?:/(draft|submit|report|answers))?', path)
            if match:
                paper_id, action = match.groups()
                paper = app.store.get('papers', paper_id)
                if post:
                    data = self.json_body()
                    if action == 'draft':
                        return self.reply(200, app.store.save_draft(paper_id, data['answers'], data['version']))
                    if action == 'submit':
                        return self.reply(200, app.store.submit(paper_id, data['version']))
                elif action in ('report', 'answers'):
                    name = paper.get('report') if action == 'report' else f'jlpt-notes/quizzes/answers/{paper_id}-answers.md'
                    if not name:
                        raise KeyError('report')
                    return self.reply(200, {'text': safe_file(app.config['study'], name).read_text()})
                elif action is None:
                    return self.reply(200, paper)
            if not path.startswith(('/api/', '/auth/')) and not post:
                return self.static('/index.html' if path == '/' else path)
            self.reply(404, {'error': '页面不存在'})

        def static(self, path):
            try:
                name = path.lstrip('/')
                if any(part.startswith('.') for part in Path(name).parts):
                    raise ValueError('hidden')
                file = safe_file(app.config['static'], name)
            except ValueError:
                return self.reply(404, {'error': '文件不存在'})
            mime = mimetypes.guess_type(str(file))[0] or 'application/octet-stream'
            self.reply(200, file.read_bytes(), mime)

    return ThreadingHTTPServer(address, Handler)
