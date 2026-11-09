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

from . import news, papers, review
from .auth import Auth, YEAR
from .news_errors import NewsError
from .news_sites import allowed_origins, loader_script, sites
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
        sites(config)  # a bad news_sites table stops the server at start-up
        self.news = news.NewsService(config, state)


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
            self.cors_headers()
            if status != 204:
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

        cors_origin = None
        via_token = False

        def cors_headers(self, preflight=False):
            # Only origins from the news site table; no credentials, so cookies never cross sites.
            if self.cors_origin:
                self.send_header('Access-Control-Allow-Origin', self.cors_origin)
                self.send_header('Vary', 'Origin')
                if preflight:
                    self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
                    self.send_header('Access-Control-Allow-Methods', 'GET, POST')
                    self.send_header('Access-Control-Max-Age', '600')

        def listed_origin(self, path):
            origin = self.headers.get('Origin')
            try:
                listed = allowed_origins(app.config)
            except ValueError:
                return None
            return origin if origin and path.startswith('/api/news/') and origin in listed else None

        def device(self):
            """The device id for `Authorization: Bearer <token>`, or None. Never raises, never logs the token."""
            header = self.headers.get('Authorization') or ''
            token = header[len('Bearer '):] if header.startswith('Bearer ') else ''
            try:
                return app.news.devices.check(token)
            except Exception as error:
                app.news.log_error({'stage': 'client', 'reason': '令牌检查失败：' + type(error).__name__}, self.path)
                return None

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

        def do_OPTIONS(self):
            path = unquote(urlsplit(self.path).path)
            self.cors_origin = self.listed_origin(path)
            if not self.cors_origin:
                return self.reply(403, {'error': '请求来源不匹配'})
            self.send_response(204)
            self.cors_headers(preflight=True)
            self.send_header('Connection', 'close')
            self.close_connection = True
            self.end_headers()

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
            news_path = path.startswith('/api/news/')
            self.via_token = False
            self.cors_origin = self.listed_origin(path)
            # A token request is judged by its token below (a bad one earns the 401 the script can act on).
            token_mode = news_path and self.headers.get('Authorization') is not None
            if post and self.headers.get('Origin') != app.config['origin'] and not (token_mode and self.cors_origin):
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
            if token_mode:
                if self.device() is None:
                    error = NewsError('client', '令牌已失效，请重新安装脚本', retryable=False)
                    app.news.log_error(error, self.path)
                    return self.reply(401, {'error': dict(error.to_dict(), install=app.config['origin'] + '/news-script/')})
                self.via_token = True
            elif not app.auth.check(token):
                return self.reply(401, {'error': '请登录'})
            if path == '/auth/check':
                return self.reply(200, {'ok': True})
            if path == '/api/logout' and post:
                self.json_body()
                app.auth.logout(token)
                return self.reply(200, {'ok': True}, headers={'Set-Cookie': self.cookie('', 0)})
            if path == '/api/session':
                return self.reply(200, {'ok': True})
            if path.startswith('/api/news/'):
                return self.news_route(path[len('/api/news'):], parsed.query, post)
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
            if path == '/spaced' and not post:
                return self.reply(200, review.spaced_today(study))
            if path == '/spaced/submit' and post:
                return self.reply(200, review.submit_spaced(study, self.json_body().get('units')))
            match = re.fullmatch(r'/units/(B-\d{2}-\d+|G-\d{3})(/recall|/submit|/forget|/forget/undo)?', path)
            if match:
                unit_id, action = match.groups()
                if action is None and not post:
                    return self.reply(200, review.unit_view(study, unit_id))
                if action == '/recall' and post:
                    return self.reply(200, review.recall(study, unit_id))
                if action == '/forget' and post:
                    return self.reply(200, review.forget(study, unit_id, self.json_body().get('form')))
                if action == '/forget/undo' and post:
                    return self.reply(200, review.undo_forget(study, unit_id, self.json_body().get('event')))
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

        def news_route(self, path, query, post):
            svc = app.news

            def body():
                try:
                    return self.json_body()
                except (ValueError, TypeError) as error:
                    raise news.client_error(str(error) or '请求格式不对')
            try:
                raw = urlsplit(self.path).path[len('/api/news'):]  # still percent-encoded
                if path == '/client.js' and not post:
                    file = Path(app.config['static']) / 'news-script' / 'client.js'
                    try:
                        code = file.read_bytes()
                    except OSError:
                        return self.reply(503, {'error': '主脚本未构建'})
                    return self.reply(200, code, 'text/javascript; charset=utf-8')
                install = re.fullmatch(r'/install/([^/]+)/jlpt-news\.user\.js', raw)
                if install or path in ('/devices', '/devices/revoke'):
                    if self.via_token:
                        return self.reply(403, {'error': '令牌不能管理设备'})
                if install and self.command == 'GET':  # a HEAD must not mint a token
                    try:
                        name = unquote(install[1], errors='strict')
                    except UnicodeDecodeError:
                        raise ValueError('设备名称无效')
                    _device, token = svc.devices.install(name)
                    headers = {}
                    if parse_qs(query).get('download') == ['1']:
                        headers['Content-Disposition'] = 'attachment; filename="jlpt-news.user.js"'
                    script = loader_script(app.config['origin'], token, sites(app.config))
                    return self.reply(200, script.encode('utf-8'), 'text/javascript; charset=utf-8', headers)
                if path == '/devices' and not post:
                    return self.reply(200, {'devices': svc.devices.list()})
                if path == '/devices/revoke' and post:
                    device_id = body().get('id')
                    if not isinstance(device_id, str):
                        raise news.client_error('设备编号无效')
                    try:
                        svc.devices.revoke(device_id)
                    except KeyError:
                        return self.reply(404, {'error': '设备不存在'})
                    return self.reply(200, {'ok': True})
                if path == '/feeds' and not post:
                    values = parse_qs(query).get('cat', [])
                    return self.reply(200, svc.feeds(values[0] if len(values) == 1 else None))
                if path == '/models' and not post:
                    return self.reply(200, svc.models())
                if path == '/settings' and post:
                    return self.reply(200, svc.save_model(body().get('model')))
                if path == '/gloss' and post:
                    data = body()
                    return self.reply(200, svc.gloss(data.get('lemma'), data.get('reading'), data.get('pos')))
                if path == '/open' and post:
                    url = svc.check_url(body().get('url'))
                    return self.sse(lambda emit: svc.open(url, emit), url)
                if path == '/analyze' and post:
                    args = svc.analyze_args(body())
                    return self.sse(lambda emit: svc.analyze(*args, emit=emit))
                if path == '/ask' and post:
                    args = svc.ask_args(body())
                    return self.sse(lambda emit: svc.ask(*args, emit=emit))
                match = re.fullmatch(r'/image/([0-9a-f]{8,64})/(\d{1,4})', path)
                if match and not post:
                    index = int(match[2])
                    try:
                        data, mime = svc.image(match[1], index)
                    except KeyError:
                        error = NewsError('image', '图片不存在或已过期', '第 %d 张' % (index + 1), retryable=False)
                        svc.log_error(error, self.path)
                        return self.reply(404, {'error': error.to_dict()})
                    return self.reply(200, data, mime, headers={'Cache-Control': 'private, max-age=604800'})
            except NewsError as error:
                svc.log_error(error, self.path)
                return self.reply(news.http_status(error), {'error': error.to_dict()})
            self.reply(404, {'error': '页面不存在'})

        def sse(self, run, url=None):
            """Stream `run(emit)` as Server-Sent Events; the connection closes when it ends."""
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Accel-Buffering', 'no')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.cors_headers()
            self.send_header('Connection', 'close')
            self.close_connection = True
            self.end_headers()

            def emit(event, data=None):
                try:
                    self.wfile.write(news.sse_frame(event, data))
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    raise news.ClientGone()
            app.news.guard(run, emit, url or self.path)

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
