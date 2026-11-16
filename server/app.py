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
from .news_sites import LOADER_VERSION, allowed_origins, debug_enabled, loader_script, online_update_enabled, sites
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
        debug_enabled(config)  # so does a news_debug that is not true or false
        online_update_enabled(config)  # and a news_online_update that is not
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

        def cors_headers(self, preflight=False):
            # Only origins from the news site table; no credentials, so cookies never cross sites.
            # Authorization stays allowed: loaders installed before tokens were dropped still send it (ignored).
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
            self.cors_origin = self.listed_origin(path)
            # No tokens while the userscript is under development: a news request from a site in the table
            # needs no login (its page cannot send our cookie). Anything else follows the usual rules.
            if post and self.headers.get('Origin') != app.config['origin'] and not self.cors_origin:
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
            if path == '/api/news/loader.user.js' and not post:  # public: Userscripts fetches it without our cookie
                return self.news_route(path[len('/api/news'):], post)
            token = self.token()
            if not (news_path and self.cors_origin) and not app.auth.check(token):
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
                return self.news_route(path[len('/api/news'):], post, parsed.query)
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

        def news_route(self, path, post, query=''):
            svc = app.news

            def body():
                try:
                    return self.json_body()
                except (ValueError, TypeError) as error:
                    raise news.client_error(str(error) or '请求格式不对')
            try:
                if path in ('/client.js', '/loader.user.js') and not post:
                    if not online_update_enabled(app.config):
                        return self.reply(404, {'error': '在线更新已关闭'})
                    if path == '/loader.user.js':
                        script = loader_script(app.config['origin'], sites(app.config), debug=debug_enabled(app.config))
                        headers = {'Content-Disposition': f'attachment; filename="jlpt-news-v{LOADER_VERSION}.user.js"'}
                        return self.reply(200, script.encode('utf-8'), 'text/javascript; charset=utf-8', headers=headers)
                    file = Path(app.config['static']) / 'news-script' / 'client.js'
                    try:
                        code = file.read_bytes()
                    except OSError:
                        return self.reply(503, {'error': '主脚本未构建'})
                    return self.reply(200, code, 'text/javascript; charset=utf-8')
                if path == '/models' and not post:
                    values = parse_qs(query).get('provider')
                    if values is not None and len(values) != 1:
                        raise news.client_error('模型来源无效')
                    return self.reply(200, svc.models(values[0] if values else None))
                if path == '/settings' and post:
                    data = body()
                    return self.reply(200, svc.save_settings(data.get('provider'), data.get('model'), data.get('effort')))
                if path == '/gloss' and post:
                    data = body()
                    return self.reply(200, svc.gloss(data.get('lemma'), data.get('reading'), data.get('pos')))
                if path == '/tokenize' and post:
                    return self.reply(200, svc.tokenize(body()))
                if path == '/analyze' and post:
                    args = svc.analyze_args(body())
                    return self.job_sse(lambda emit: svc.analyze(*args, emit=emit))
                if path == '/ask' and post:
                    args = svc.ask_args(body())
                    return self.job_sse(lambda emit: svc.ask(*args, emit=emit))
                if path == '/resume' and post:
                    job, seen = svc.resume_args(body())
                    self.sse_headers(job.id)
                    return self.follow(job, seen)
                if path == '/cancel' and post:
                    svc.jobs.cancel(svc.job_name(body()))
                    return self.reply(200, {})
            except NewsError as error:
                svc.log_error(error, self.path)
                return self.reply(news.http_status(error), {'error': error.to_dict()})
            self.reply(404, {'error': '页面不存在'})

        def sse_headers(self, job_id):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Accel-Buffering', 'no')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-News-Job', job_id)
            self.cors_headers()
            if self.cors_origin:
                self.send_header('Access-Control-Expose-Headers', 'X-News-Job')
            self.send_header('Connection', 'close')
            self.close_connection = True
            self.end_headers()

        def job_sse(self, run, url=None):
            """Run `run(emit)` as a background job and follow it on this connection (see news_jobs)."""
            url = url or self.path
            job = app.news.jobs.start(lambda emit: app.news.guard(run, emit, url))
            self.sse_headers(job.id)
            self.follow(job, 0)

        def follow(self, job, seen):
            """Send the job's events after the first `seen`, as Server-Sent Events with ids."""
            def write(event, data=None, event_id=None):
                try:
                    self.wfile.write(news.sse_frame(event, data, event_id))
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    raise news.ClientGone()
            try:
                app.news.jobs.serve(job, seen, write)
            except news.ClientGone:
                pass

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
