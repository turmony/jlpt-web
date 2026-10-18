import json
import mimetypes
import re
import threading
import time
from collections import defaultdict
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from . import papers, review
from .auth import Auth, YEAR
from .papers import safe_file
from .store import Store, Conflict


class Application:
    def __init__(self, config):
        self.config = config
        state = Path(config['state'])
        state.mkdir(parents=True, exist_ok=True)
        self.store = Store(state / 'state.sqlite')
        self.auth = Auth(self.store, config['password_hash'])
        self.attempts = defaultdict(list)
        self.auth_lock = threading.Lock()


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
            if 'Cache-Control' not in (headers or {}):
                self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'same-origin')
            self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
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
            except review.Forbidden as error:
                self.reply(403, {'error': str(error)})
            except review.StudyDataError as error:
                self.reply(500, {'error': str(error)})
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
            if path.startswith('/api/review/'):
                return self.review(path[len('/api/review'):], parsed.query, post)
            if path == '/api/quiz/papers' and not post:
                return self.reply(200, papers.list_papers(app.config['study']))
            match = re.fullmatch(r'/api/quiz/papers/([^/]+)(/answers)?', path)
            if match:
                slug, answers = match.groups()
                if answers and post:
                    return self.reply(200, papers.write_answers(app.config['study'], slug, self.json_body().get('answers')))
                if not answers and not post:
                    return self.reply(200, papers.read_paper(app.config['study'], slug))
            if not path.startswith(('/api/', '/auth/')) and not post:
                return self.static('/index.html' if path == '/' else path)
            self.reply(404, {'error': '页面不存在'})

        def review(self, path, query, post):
            study = app.config['study']
            if path == '/today' and not post:
                return self.reply(200, review.today(study))
            if path == '/asset' and not post:
                values = parse_qs(query).get('path', [])
                if len(values) != 1:
                    raise ValueError('图片路径无效')
                data, mime = review.asset(study, values[0])
                return self.reply(200, data, mime, headers={'Cache-Control': 'private, max-age=3600'})
            match = re.fullmatch(r'/units/(B-\d{2}-\d+|G-\d{3})(/recall|/submit)?', path)
            if match:
                unit_id, action = match.groups()
                if action is None and not post:
                    return self.reply(200, review.unit_view(study, unit_id))
                if action == '/recall' and post:
                    return self.reply(200, review.recall(study, unit_id))
                if action == '/submit' and post:
                    body = self.json_body()
                    return self.reply(200, review.submit_unit(study, unit_id, body.get('answers'), body.get('sentence'), body.get('note')))
            match = re.fullmatch(r'/reviews/(review-\d{2})(/submit)?', path)
            if match:
                review_id, action = match.groups()
                if action is None and not post:
                    return self.reply(200, review.review_view(study, review_id))
                if action and post:
                    return self.reply(200, review.submit_review(study, review_id, self.json_body().get('answers')))
            self.reply(404, {'error': '页面不存在'})

        def static(self, path):
            try:
                name = (path + 'index.html' if path.endswith('/') else path).lstrip('/')
                if any(part.startswith('.') for part in Path(name).parts):
                    raise ValueError('hidden')
                file = safe_file(app.config['static'], name)
            except ValueError:
                return self.reply(404, {'error': '文件不存在'})
            mime = mimetypes.guess_type(str(file))[0] or 'application/octet-stream'
            self.reply(200, file.read_bytes(), mime)

    return ThreadingHTTPServer(address, Handler)
