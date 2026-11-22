#!/usr/bin/env python3
"""Standalone unified authentication service for turmony.site and its four portals."""

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from collections import defaultdict
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

YEAR = 365 * 86400
TOUCH_INTERVAL = 60
_GOB_MAP_HEADER = b'\x0e\xff\x8b\x04\x01\x02\xff\x8c\x00\x01\x10\x01\x10\x00\x00\xff\x8c\xff\x8c\x00\x03'
_TURMONY_HOSTS = {'turmony.site', 'www.turmony.site'}
_TURMONY_ORIGINS = {'https://turmony.site', 'https://www.turmony.site'}
_SESSION_ID_RE = re.compile(r'^[0-9a-f]{12}$')
_CSP = (
    "default-src 'self'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
    "script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)


def _gob_uint(value: int) -> bytes:
    if value < 0x80:
        return bytes([value])
    raw = bytearray()
    while value:
        raw.append(value & 0xFF)
        value >>= 8
    raw.reverse()
    return bytes([0x100 - len(raw)]) + bytes(raw)


def _gob_int(value: int) -> bytes:
    unsigned = (value << 1) if value >= 0 else (((~value) << 1) | 1)
    return _gob_uint(unsigned)


def _gob_iface_int(type_name: str, value: int) -> bytes:
    encoded = b'\x00' + _gob_int(value)
    return (
        bytes([len(type_name)])
        + type_name.encode('ascii')
        + b'\x04'
        + _gob_uint(len(encoded))
        + encoded
    )


def _gob_iface_string(value: str) -> bytes:
    raw = value.encode('utf-8')
    encoded = b'\x00' + _gob_uint(len(raw)) + raw
    return b'\x06string\x0c' + _gob_uint(len(encoded)) + encoded


def derive_xui_csrf_token(secret: str, session_digest: str = '') -> str:
    msg = f'portal-xui-csrf|{session_digest}'.encode('ascii')
    digest = hmac.new(secret.encode('utf-8'), msg, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b'=').decode('ascii')


def build_xui_cookie_value(
    secret: str,
    user_id: int,
    login_epoch: int,
    csrf_token: str | None = None,
    now: int | None = None,
) -> str:
    token = derive_xui_csrf_token(secret) if csrf_token is None else csrf_token
    payload = (
        _GOB_MAP_HEADER
        + _gob_iface_string('CSRF_TOKEN')
        + _gob_iface_string(token)
        + _gob_iface_string('LOGIN_USER')
        + _gob_iface_int('int', int(user_id))
        + _gob_iface_string('LOGIN_EPOCH')
        + _gob_iface_int('int64', int(login_epoch))
    )
    b64_val = base64.urlsafe_b64encode(payload).decode('ascii')
    ts = str(int(time.time() if now is None else now))
    mac = hmac.new(secret.encode('utf-8'), f'3x-ui|{ts}|{b64_val}'.encode('ascii'), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(f'{ts}|{b64_val}|'.encode('ascii') + mac).decode('ascii')


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return f'scrypt${salt}${digest}'


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        scheme, salt, expected = stored_hash.split('$')
        if scheme != 'scrypt':
            return False
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def parse_device_name(ua: str) -> str:
    text = (ua or '').strip()
    if not text:
        return '未知设备'

    if 'iPhone' in text:
        os_name = 'iPhone'
    elif 'iPad' in text:
        os_name = 'iPad'
    elif 'Android' in text:
        os_name = 'Android'
    elif 'Macintosh' in text or 'Mac OS X' in text:
        os_name = 'Mac'
    elif 'Windows NT' in text:
        os_name = 'Windows 电脑'
    elif 'Linux' in text:
        os_name = 'Linux 设备'
    elif 'curl/' in text.lower():
        os_name = 'curl 命令行'
    else:
        os_name = ''

    if 'Edg/' in text or 'EdgiOS/' in text or 'EdgA/' in text:
        browser = 'Edge'
    elif 'CriOS/' in text or ('Chrome/' in text and 'Edg/' not in text):
        browser = 'Chrome'
    elif 'FxiOS/' in text or 'Firefox/' in text:
        browser = 'Firefox'
    elif 'Safari/' in text and (
        'Version/' in text or 'Mobile/' in text or 'iPhone' in text or 'iPad' in text or 'Macintosh' in text
    ):
        browser = 'Safari'
    else:
        browser = ''

    if os_name and browser:
        return f'{os_name} · {browser}'
    return os_name or browser or '未知设备'


def extract_session_tokens(cookie_header: str) -> list[str]:
    tokens: list[str] = []
    for part in (cookie_header or '').split(';'):
        chunk = part.strip()
        if not chunk or '=' not in chunk:
            continue
        name, value = chunk.split('=', 1)
        if name.strip() == 'jlpt_session':
            val = value.strip().strip('"')
            if val and len(val) <= 128 and val not in tokens:
                tokens.append(val)
    return tokens


def atomic_write_text(path: Path, content: str, mode: int = 0o600) -> None:
    tmp = path.with_name(f'.{path.name}.tmp.{os.getpid()}')
    fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            fh.write(content)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
        os.chmod(path, mode)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class PortalAuthService:
    def __init__(self, config_path: str, xui_db: str = '/etc/x-ui/x-ui.db', password_file: str = ''):
        self.config_path = Path(config_path)
        self.xui_db = Path(xui_db) if xui_db else None
        cfg = self.read_config()
        state_dir = Path(cfg['state'])
        state_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = state_dir / 'state.sqlite'
        self.password_file = Path(password_file) if password_file else (state_dir / 'website-password')
        with self._connect() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires REAL);
                CREATE TABLE IF NOT EXISTS session_devices (
                    token TEXT PRIMARY KEY,
                    created_at REAL,
                    last_seen REAL,
                    ip TEXT,
                    user_agent TEXT,
                    device_name TEXT
                );
            ''')
        self.attempts: dict[str, list[float]] = defaultdict(list)
        self.auth_lock = threading.Lock()
        self.config_lock = threading.Lock()
        self._xui_cache: dict[tuple[str, int, int, str, int], str] = {}
        self._xui_lock = threading.Lock()
        self._touch_cache: dict[str, tuple[float, str, str]] = {}
        self._touch_lock = threading.Lock()

    def read_config(self) -> dict:
        return json.loads(self.config_path.read_text(encoding='utf-8'))

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(str(self.db_path), timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()

    def check_tokens(self, tokens: list[str], now: float | None = None) -> str | None:
        ts = time.time() if now is None else now
        valid_candidates = [t for t in tokens if t and len(t) <= 128]
        if not valid_candidates:
            return None
        with self._connect() as db:
            for tok in valid_candidates:
                row = db.execute('SELECT expires FROM sessions WHERE token=?', (token_digest(tok),)).fetchone()
                if row and row[0] > ts:
                    return tok
        return None

    def touch_session(self, token: str, ip: str, user_agent: str, now: float | None = None) -> None:
        digest = token_digest(token)
        ts = time.time() if now is None else now
        ua_short = (user_agent or '')[:300]
        ip_short = (ip or '')[:64]
        with self._touch_lock:
            cached = self._touch_cache.get(digest)
            if cached and (ts - cached[0]) < TOUCH_INTERVAL and cached[1] == ip_short and cached[2] == ua_short:
                return
        device_name = parse_device_name(ua_short)
        with self._connect() as db:
            row = db.execute('SELECT expires FROM sessions WHERE token=?', (digest,)).fetchone()
            if not row:
                return
            created_fallback = max(0.0, float(row[0]) - YEAR)
            db.execute(
                '''
                INSERT INTO session_devices (token, created_at, last_seen, ip, user_agent, device_name)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(token) DO UPDATE SET
                    last_seen = excluded.last_seen,
                    ip = excluded.ip,
                    user_agent = excluded.user_agent,
                    device_name = excluded.device_name
                ''',
                (digest, created_fallback, ts, ip_short, ua_short, device_name),
            )
        with self._touch_lock:
            if len(self._touch_cache) > 1000:
                self._touch_cache.clear()
            self._touch_cache[digest] = (ts, ip_short, ua_short)

    def create_session(self, ip: str = '', user_agent: str = '', now: float | None = None) -> str:
        ts = time.time() if now is None else now
        token = secrets.token_urlsafe(32)
        digest = token_digest(token)
        ua_short = (user_agent or '')[:300]
        ip_short = (ip or '')[:64]
        device_name = parse_device_name(ua_short)
        with self._connect() as db:
            db.execute('INSERT INTO sessions VALUES (?,?)', (digest, ts + YEAR))
            db.execute(
                '''
                INSERT OR REPLACE INTO session_devices (token, created_at, last_seen, ip, user_agent, device_name)
                VALUES (?, ?, ?, ?, ?, ?)
                ''',
                (digest, ts, ts, ip_short, ua_short, device_name),
            )
        with self._touch_lock:
            self._touch_cache[digest] = (ts, ip_short, ua_short)
        return token

    def delete_sessions(self, tokens: list[str]) -> None:
        if not tokens:
            return
        digests = [token_digest(tok) for tok in tokens]
        with self._connect() as db:
            for d in digests:
                db.execute('DELETE FROM sessions WHERE token=?', (d,))
                db.execute('DELETE FROM session_devices WHERE token=?', (d,))
        with self._touch_lock:
            for d in digests:
                self._touch_cache.pop(d, None)

    def list_sessions(self, active_token: str, now: float | None = None) -> list[dict]:
        ts = time.time() if now is None else now
        current_digest = token_digest(active_token)
        with self._connect() as db:
            db.execute('DELETE FROM sessions WHERE expires <= ?', (ts,))
            db.execute('DELETE FROM session_devices WHERE token NOT IN (SELECT token FROM sessions)')
            rows = db.execute(
                '''
                SELECT s.token, s.expires, d.created_at, d.last_seen, d.ip, d.user_agent, d.device_name
                FROM sessions s
                LEFT JOIN session_devices d ON s.token = d.token
                WHERE s.expires > ?
                ''',
                (ts,),
            ).fetchall()
        items = []
        for digest, expires, created_at, last_seen, ip, ua, device_name in rows:
            created = created_at if created_at is not None else max(0.0, float(expires) - YEAR)
            items.append({
                'id': digest[:12],
                'current': digest == current_digest,
                'device_name': device_name or '早期登录设备',
                'user_agent': ua or '',
                'ip': ip or '',
                'created_at': created,
                'last_seen': last_seen,
                'expires': float(expires),
            })
        items.sort(key=lambda r: (0 if r['current'] else 1, -(r['last_seen'] or r['created_at'] or 0.0)))
        return items

    def revoke_sessions(self, active_token: str, *, target_id: str = '', scope: str = '') -> tuple[int, bool]:
        current_digest = token_digest(active_token)
        if scope == 'others':
            with self._connect() as db:
                cur = db.execute('DELETE FROM sessions WHERE token != ?', (current_digest,))
                db.execute('DELETE FROM session_devices WHERE token != ?', (current_digest,))
                revoked = cur.rowcount
            with self._touch_lock:
                keep = self._touch_cache.get(current_digest)
                self._touch_cache.clear()
                if keep:
                    self._touch_cache[current_digest] = keep
            return revoked, False

        if not _SESSION_ID_RE.match(target_id or ''):
            raise ValueError('无效的会话编号')

        with self._connect() as db:
            matches = [
                r[0] for r in db.execute('SELECT token FROM sessions WHERE substr(token, 1, 12) = ?', (target_id,)).fetchall()
            ]
            if not matches:
                return 0, False
            for d in matches:
                db.execute('DELETE FROM sessions WHERE token=?', (d,))
                db.execute('DELETE FROM session_devices WHERE token=?', (d,))
        with self._touch_lock:
            for d in matches:
                self._touch_cache.pop(d, None)
        return len(matches), current_digest in matches

    def change_password(self, current_password: str, new_password: str, ip: str = '', user_agent: str = '') -> str | None:
        if not isinstance(current_password, str) or len(current_password) > 1024:
            return None
        if not isinstance(new_password, str) or not (8 <= len(new_password) <= 1024):
            raise ValueError('新密码长度需在 8 到 1024 个字符之间')
        with self.config_lock:
            cfg = self.read_config()
            if not verify_password(current_password, cfg.get('password_hash', '')):
                return None
            cfg['password_hash'] = hash_password(new_password)
            atomic_write_text(self.config_path, json.dumps(cfg, ensure_ascii=False, indent=2) + '\n', mode=0o600)
            if self.password_file:
                atomic_write_text(self.password_file, new_password + '\n', mode=0o600)
            new_token = secrets.token_urlsafe(32)
            new_digest = token_digest(new_token)
            ts = time.time()
            ua_short = (user_agent or '')[:300]
            ip_short = (ip or '')[:64]
            device_name = parse_device_name(ua_short)
            with self._connect() as db:
                db.execute('DELETE FROM sessions')
                db.execute('DELETE FROM session_devices')
                db.execute('INSERT INTO sessions VALUES (?,?)', (new_digest, ts + YEAR))
                db.execute(
                    '''
                    INSERT INTO session_devices (token, created_at, last_seen, ip, user_agent, device_name)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ''',
                    (new_digest, ts, ts, ip_short, ua_short, device_name),
                )
            with self._touch_lock:
                self._touch_cache.clear()
                self._touch_cache[new_digest] = (ts, ip_short, ua_short)
            return new_token

    def get_xui_cookie(self, session_token: str = '') -> str:
        if not self.xui_db or not self.xui_db.is_file():
            return ''
        try:
            uri = self.xui_db.resolve().as_uri() + '?mode=ro'
            with sqlite3.connect(uri, uri=True, timeout=2) as db:
                db.execute('PRAGMA query_only=ON')
                secret_row = db.execute("SELECT value FROM settings WHERE key='secret'").fetchone()
                user_row = db.execute('SELECT id, login_epoch FROM users ORDER BY id LIMIT 1').fetchone()
            if not secret_row or not user_row:
                return ''
            secret = str(secret_row[0])
            user_id = int(user_row[0])
            login_epoch = int(user_row[1] or 0)
            session_digest = token_digest(session_token) if session_token else ''
            bucket = int(time.time() // 60)
            key = (secret, user_id, login_epoch, session_digest, bucket)
            with self._xui_lock:
                cached = self._xui_cache.get(key)
                if cached:
                    return cached
                csrf_token = derive_xui_csrf_token(secret, session_digest)
                cookie_val = build_xui_cookie_value(secret, user_id, login_epoch, csrf_token=csrf_token)
                header_val = f'3x-ui={cookie_val}'
                if len(self._xui_cache) > 256:
                    self._xui_cache.clear()
                self._xui_cache[key] = header_val
                return header_val
        except Exception:
            return ''


def create_server(service: PortalAuthService, address: tuple[str, int]):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, format, *args):
            pass

        def _client_key(self) -> str:
            for hdr in ('Cf-Connecting-Ip', 'X-Real-IP'):
                val = (self.headers.get(hdr) or '').strip()
                if val:
                    return val
            xff = (self.headers.get('X-Forwarded-For') or '').strip()
            if xff:
                return xff.split(',')[0].strip()
            return self.client_address[0]

        def _request_host(self) -> str:
            raw = (self.headers.get('X-Forwarded-Host') or self.headers.get('Host') or '').split(',')[0].strip()
            return raw.split(':', 1)[0].lower()

        def _is_turmony_domain(self) -> bool:
            host = self._request_host()
            origin = (self.headers.get('Origin') or '').strip().lower()
            return host in _TURMONY_HOSTS or host.endswith('.turmony.site') or origin in _TURMONY_ORIGINS

        def _safe_next(self, query: str) -> str:
            default_target = '/' if self._is_turmony_domain() else '/review/'
            raw_next = parse_qs(query).get('next', [''])[0]
            if raw_next.startswith('/') and not raw_next.startswith('//') and not raw_next.startswith('/login.html'):
                return raw_next
            return default_target

        def _cookie_headers(self, token: str, age: int, cfg: dict) -> list[tuple[str, str]]:
            secure = '; Secure' if cfg.get('secure_cookie', True) else ''
            if self._is_turmony_domain():
                if age == 0:
                    return [
                        ('Set-Cookie', f'jlpt_session=; Max-Age=0; Path=/; HttpOnly{secure}'),
                        ('Set-Cookie', f'jlpt_session=; Max-Age=0; Domain=turmony.site; Path=/; HttpOnly; SameSite=Lax{secure}'),
                    ]
                return [
                    # Clear any legacy host-only jlpt_session cookie so browsers do not send duplicates.
                    ('Set-Cookie', f'jlpt_session=; Max-Age=0; Path=/; HttpOnly{secure}'),
                    ('Set-Cookie', f'jlpt_session={token}; Max-Age={age}; Domain=turmony.site; Path=/; HttpOnly; SameSite=Lax{secure}'),
                ]
            return [('Set-Cookie', f'jlpt_session={token}; Max-Age={age}; Path=/; HttpOnly; SameSite=Strict{secure}')]

        def reply(self, status: int, body, content_type='application/json; charset=utf-8', headers=None):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            header_list = list(headers or [])
            has_cache_control = any(k.lower() == 'cache-control' for k, _ in header_list)
            for key, value in header_list:
                self.send_header(key, value)
            if status not in (204, 303):
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(body)))
            else:
                self.send_header('Content-Length', '0')
            self.send_header('Connection', 'close')
            self.close_connection = True
            if not has_cache_control:
                self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'same-origin')
            self.send_header('Content-Security-Policy', _CSP)
            self.end_headers()
            if self.command != 'HEAD' and status not in (204, 303):
                self.wfile.write(body)

        def json_body(self) -> dict:
            if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
                raise ValueError('请求必须使用 JSON')
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 65536:
                raise ValueError('请求大小无效')
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError('请求必须是对象')
            return body

        def _allowed_post_origin(self, cfg: dict) -> bool:
            origin = (self.headers.get('Origin') or '').strip()
            allowed = {o for o in (cfg.get('origin'), *_TURMONY_ORIGINS) if o}
            return origin in allowed

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            self._dispatch()

        def do_POST(self):
            self._dispatch()

        def _dispatch(self):
            try:
                self._route()
            except ValueError as error:
                self.reply(400, {'error': str(error)})
            except Exception as error:
                self.reply(500, {'error': '认证服务处理失败：' + str(error)[:300]})

        def _route(self):
            parsed = urlsplit(self.path)
            path = unquote(parsed.path)
            post = self.command == 'POST'
            cfg = service.read_config()

            if post and not self._allowed_post_origin(cfg):
                self.close_connection = True
                return self.reply(403, {'error': '请求来源不匹配'})

            tokens = extract_session_tokens(self.headers.get('Cookie', ''))
            active_token = service.check_tokens(tokens)
            client_ip = self._client_key()
            ua = self.headers.get('User-Agent', '')

            if path == '/login.html' and not post:
                if active_token:
                    service.touch_session(active_token, client_ip, ua)
                    return self.reply(303, b'', headers=[('Location', self._safe_next(parsed.query))])
                login_file = Path(cfg.get('static') or '/srv/jlpt/static') / 'login.html'
                hdrs = self._cookie_headers('', 0, cfg) if tokens else None
                return self.reply(200, login_file.read_bytes(), 'text/html; charset=utf-8', headers=hdrs)

            if path == '/api/login' and post:
                data = self.json_body()
                password = data.get('password')
                with service.auth_lock:
                    now = time.time()
                    service.attempts[client_ip] = [t for t in service.attempts[client_ip] if t > now - 300]
                    if len(service.attempts[client_ip]) >= 10:
                        return self.reply(429, {'error': '尝试过多，请五分钟后再试'})
                    if not isinstance(password, str) or len(password) > 1024 or not verify_password(password, cfg.get('password_hash', '')):
                        service.attempts[client_ip].append(now)
                        return self.reply(401, {'error': '密码错误'})
                    service.attempts[client_ip] = []
                token = service.create_session(client_ip, ua)
                return self.reply(200, {'ok': True}, headers=self._cookie_headers(token, YEAR, cfg))

            if not active_token:
                return self.reply(401, {'error': '请登录'})

            if path == '/auth/check' and not post:
                service.touch_session(active_token, client_ip, ua)
                hdrs = [('X-Turmony-Auth', '1')]
                vpn_cookie = service.get_xui_cookie(active_token)
                if vpn_cookie:
                    hdrs.append(('X-Vpn-Cookie', vpn_cookie))
                return self.reply(200, {'ok': True}, headers=hdrs)

            if path == '/api/session' and not post:
                service.touch_session(active_token, client_ip, ua)
                return self.reply(200, {'ok': True})

            if path == '/api/logout' and post:
                self.json_body()
                service.delete_sessions(tokens)
                return self.reply(200, {'ok': True}, headers=self._cookie_headers('', 0, cfg))

            if path == '/api/auth/sessions' and not post:
                service.touch_session(active_token, client_ip, ua)
                return self.reply(200, {'sessions': service.list_sessions(active_token)})

            if path == '/api/auth/sessions/revoke' and post:
                data = self.json_body()
                scope = str(data.get('scope') or '')
                target_id = str(data.get('id') or '').strip().lower()
                revoked, self_revoked = service.revoke_sessions(
                    active_token,
                    target_id=target_id,
                    scope=scope,
                )
                if scope != 'others' and revoked == 0:
                    return self.reply(404, {'error': '会话不存在或已失效'})
                hdrs = self._cookie_headers('', 0, cfg) if self_revoked else None
                return self.reply(200, {'ok': True, 'revoked': revoked, 'self_revoked': self_revoked}, headers=hdrs)

            if path == '/api/auth/password' and post:
                data = self.json_body()
                current_pw = data.get('current_password')
                new_pw = data.get('new_password')
                with service.auth_lock:
                    now = time.time()
                    service.attempts[client_ip] = [t for t in service.attempts[client_ip] if t > now - 300]
                    if len(service.attempts[client_ip]) >= 10:
                        return self.reply(429, {'error': '尝试过多，请五分钟后再试'})
                    new_token = service.change_password(current_pw, new_pw, client_ip, ua)
                    if not new_token:
                        service.attempts[client_ip].append(now)
                        return self.reply(401, {'error': '当前密码错误'})
                    service.attempts[client_ip] = []
                return self.reply(200, {'ok': True}, headers=self._cookie_headers(new_token, YEAR, cfg))

            return self.reply(404, {'error': '页面不存在'})

    return ThreadingHTTPServer(address, Handler)


def main():
    parser = argparse.ArgumentParser(description='Turmony unified authentication service')
    parser.add_argument('--config', default='/srv/jlpt/state/config.json')
    parser.add_argument('--xui-db', default='/etc/x-ui/x-ui.db')
    parser.add_argument('--password-file', default='/srv/jlpt/state/website-password')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8767)
    args = parser.parse_args()

    service = PortalAuthService(args.config, xui_db=args.xui_db, password_file=args.password_file)
    server = create_server(service, (args.host, args.port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
