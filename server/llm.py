"""Streaming client for qoder2api-hub (OpenAI Chat Completions compatible).

Errors are raised as NewsError with the stage that failed:
  gateway  cannot reach the hub, no valid HTTP answer, or the API key is rejected
  model    the hub answered but the model failed, queued, timed out or produced nothing
  stream   the hub dropped the answer after text had already started
"""
import http.client
import json
import threading
import time
from urllib.parse import urlsplit

from server.news_errors import NewsError

EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max']
MODELS_TTL = 300

DEFAULT_LABEL = 'qoder2api-hub'
R_UNREACHABLE = 'qoder2api-hub 未运行或无法连接'
R_BAD_KEY = 'API Key 无效'
R_QUEUE = '模型排队中，请稍后重试'
R_UNAVAILABLE = '当前模型不可用，请重新选择'
R_TIER_BLOCKED = '当前账号类型暂不支持该模型，请换选其他模型'
R_NO_OUTPUT = '模型没有返回内容'
R_CUT = 'qoder2api-hub 中途断开'

_NON_CHAT_TAGS = {'text-to-image', 'image-to-image', 'text-to-video', 'image-to-video'}
_NON_CHAT_PREFIXES = ('nes-', 'completion-', 'codewise-')
_TOGGLE_HY4_PREFIXES = ('hy4',)
_AUTO_TOGGLE_IDS = {'default-model'}
_FIXED_REASONING_IDS = {'max-model', 'kimi-k3'}


def _fmt_seconds(s):
    return '%g' % s


def _bare_model_id(mid):
    raw = str(mid or '').strip().lower()
    return raw.split(':', 1)[-1] if ':' in raw else raw


def _supported_efforts(model):
    raw = model.get('reasoning_efforts')
    if not raw:
        raw = model.get('reasoning_supported_efforts')
    if not raw and isinstance(model.get('supported_reasoning_levels'), list):
        raw = [item.get('effort') for item in model['supported_reasoning_levels'] if isinstance(item, dict)]
    seen = []
    for e in raw or []:
        if e in EFFORT_ORDER and e not in seen:
            seen.append(e)
    return sorted(seen, key=EFFORT_ORDER.index)


def _thinking_spec(model):
    """Describe thinking configurability: levels (multi-tier), toggle (off/on), fixed, or none."""
    efforts = _supported_efforts(model)
    bare = _bare_model_id(model.get('id'))
    if len(efforts) >= 2:
        return {'mode': 'levels', 'options': efforts, 'default': efforts[0]}
    if len(efforts) == 1:
        if bare not in _FIXED_REASONING_IDS and (
            bare.startswith(_TOGGLE_HY4_PREFIXES) or model.get('reasoning_can_disable') is True
        ):
            # Verified live: hy4* defaults off ('none' upstream) for fast lookup unless switched on.
            return {'mode': 'toggle', 'options': ['off', 'on'], 'default': 'off'}
        return {'mode': 'fixed', 'options': [efforts[0]], 'default': efforts[0]}
    if bare in _AUTO_TOGGLE_IDS:
        return {'mode': 'toggle', 'options': ['off', 'on'], 'default': 'off'}
    return {'mode': 'none', 'options': [], 'default': None}


def _extract_effort(model):
    """Return the default reasoning effort/mode, handling Qoder and CodeBuddy shapes."""
    return _thinking_spec(model)['default']


def _credit_tag(model):
    credits = model.get('credits')
    if not isinstance(credits, str):
        return ''
    cleaned = credits.strip().removesuffix('credits').strip()
    if not cleaned:
        return ''
    return '免费' if cleaned.startswith('x0.00') else cleaned


def _is_non_chat_model(model):
    mid = str(model.get('id') or '').strip().lower()
    if mid.startswith(_NON_CHAT_PREFIXES):
        return True
    tags = model.get('tags')
    if isinstance(tags, list):
        for tag in tags:
            if isinstance(tag, str) and tag.strip().lower() in _NON_CHAT_TAGS:
                return True
    return False


def _copy_model(item):
    t = item['thinking']
    return {**item, 'thinking': {'mode': t['mode'], 'options': list(t['options']), 'default': t['default']}}


def _format_models(data, on_efforts=None):
    parsed = []
    name_counts = {}
    for m in data:
        if not isinstance(m, dict) or not m.get('id') or m.get('enabled') is False or _is_non_chat_model(m):
            continue
        base = m.get('name_local') or m.get('name') or m['id']
        tag = _credit_tag(m)
        label = f'{base}（{tag}）' if tag else base
        name_counts[label] = name_counts.get(label, 0) + 1
        thinking = _thinking_spec(m)
        if on_efforts is not None and thinking['mode'] == 'toggle':
            efforts = _supported_efforts(m)
            if efforts:
                on_efforts[m['id']] = efforts[0]
        parsed.append({'id': m['id'], 'name': label, 'effort': thinking['default'], 'thinking': thinking})
    for item in parsed:
        if name_counts[item['name']] > 1 and item['name'] != item['id']:
            item['name'] = f"{item['name']}（{item['id']}）"
    return parsed


class _Deadline(Exception):
    def __init__(self, which):
        self.which = which


class Hub:
    def __init__(self, base_url, api_key, first_timeout=30, total_timeout=120,
                 clock=time.monotonic, label=DEFAULT_LABEL):
        parts = urlsplit(base_url)
        self._https = parts.scheme == 'https'
        self._host = parts.hostname or '127.0.0.1'
        self._port = parts.port or (443 if self._https else 80)
        self._prefix = parts.path.rstrip('/')
        self._key = api_key or ''
        self.label = label or DEFAULT_LABEL
        self.first_timeout = first_timeout
        self.total_timeout = total_timeout
        self._clock = clock
        self._lock = threading.Lock()
        self._models = None
        self._models_at = 0.0
        self._on_efforts = {}

    def _unreachable_msg(self):
        return '%s 未运行或无法连接' % self.label

    def _cut_msg(self):
        return '%s 中途断开' % self.label

    def _bad_models_msg(self):
        return '%s 返回的模型列表无法识别' % self.label

    # -- messages ----------------------------------------------------------
    def _first_msg(self):
        return '模型 %s 秒内没有输出' % _fmt_seconds(self.first_timeout)

    def _total_msg(self):
        t = self.total_timeout
        if t >= 60 and t % 60 == 0:
            return '回答超过 %d 分钟' % (t // 60)
        return '回答超过 %s 秒' % _fmt_seconds(t)

    def _scrub(self, text):
        return text.replace(self._key, '***') if self._key else text

    # -- plumbing ----------------------------------------------------------
    def _connect(self, timeout):
        cls = http.client.HTTPSConnection if self._https else http.client.HTTPConnection
        conn = cls(self._host, self._port, timeout=timeout)
        try:
            conn.connect()
        except OSError:
            conn.close()
            raise NewsError('gateway', self._unreachable_msg())
        return conn, conn.sock

    def _headers(self):
        h = {'Content-Type': 'application/json', 'Accept': 'text/event-stream'}
        if self._key:
            h['Authorization'] = 'Bearer ' + self._key
        return h

    def _raise_http(self, status, body):
        text = self._scrub(body.decode('utf-8', 'replace'))
        if status == 401:
            raise NewsError('gateway', R_BAD_KEY)
        if '11158' in text or 'not allowed for user type' in text.lower():
            raise NewsError('model', R_TIER_BLOCKED, retryable=False)
        if status == 429 or '10605' in text:
            raise NewsError('model', R_QUEUE)
        if status in (400, 404) and 'model' in text.lower():
            raise NewsError('model', R_UNAVAILABLE, retryable=False)
        raise NewsError('model', '模型返回 %d：%s' % (status, text[:200]))

    def _raise_in_band(self, err):
        """An error reported inside a 200 answer (SSE `error` payload or a JSON error body)."""
        raw = json.dumps(err, ensure_ascii=False) if not isinstance(err, str) else err
        msg = err.get('message') if isinstance(err, dict) else err
        msg = self._scrub(str(msg if msg else raw))
        raw = self._scrub(raw)
        if '11158' in raw or 'not allowed for user type' in raw.lower():
            raise NewsError('model', R_TIER_BLOCKED, retryable=False)
        if '10605' in raw:
            raise NewsError('model', R_QUEUE)
        if 'model' in raw.lower():
            raise NewsError('model', R_UNAVAILABLE, retryable=False)
        raise NewsError('model', '模型返回错误：%s' % msg[:200])

    def _raise_stray(self, text):
        try:
            obj = json.loads(text)
        except ValueError:
            obj = None
        if isinstance(obj, dict) and obj.get('error'):
            self._raise_in_band(obj['error'])
        text = self._scrub(text)
        if '10605' in text:
            raise NewsError('model', R_QUEUE)
        raise NewsError('model', '模型返回 200：%s' % text[:200])

    # -- models ------------------------------------------------------------
    def models(self):
        with self._lock:
            now = self._clock()
            if self._models is not None and now - self._models_at < MODELS_TTL:
                return [_copy_model(m) for m in self._models]
        on_efforts = {}
        result = self._fetch_models(on_efforts)
        with self._lock:
            self._models = result
            self._on_efforts = on_efforts
            self._models_at = self._clock()
        return [_copy_model(m) for m in result]

    def _fetch_models(self, on_efforts=None):
        conn, _sock = self._connect(self.first_timeout)
        try:
            try:
                conn.request('GET', self._prefix + '/v1/models', headers=self._headers())
                resp = conn.getresponse()
                body = resp.read(1 << 20)
            except OSError:
                raise NewsError('gateway', self._unreachable_msg())
            except http.client.HTTPException:
                raise NewsError('gateway', self._unreachable_msg())
            if resp.status != 200:
                self._raise_http(resp.status, body)
        finally:
            conn.close()
        try:
            data = json.loads(body.decode('utf-8'))['data']
            return _format_models(data, on_efforts)
        except (ValueError, KeyError, TypeError):
            raise NewsError('gateway', self._bad_models_msg())

    def _resolve_upstream_effort(self, model, effort):
        if effort == 'off':
            return 'none' if _bare_model_id(model).startswith(_TOGGLE_HY4_PREFIXES) else None
        if effort == 'on':
            with self._lock:
                return self._on_efforts.get(model) or 'high'
        return effort

    # -- chat --------------------------------------------------------------
    def complete(self, model, messages, effort=None):
        return ''.join(chunk for chunk in self.stream(model, messages, effort) if chunk)

    def stream(self, model, messages, effort=None):
        """Yield the text deltas of a chat completion. Closing the generator drops the upstream
        connection. While the model only thinks (reasoning deltas) an empty string '' is yielded as
        a heartbeat, never the reasoning itself: consumers skip '' for content but may use it to
        ping their own client. Deadlines: first output (text or reasoning) within first_timeout,
        whole answer within total_timeout. SSE comment lines (`: ping`) are not output."""
        body = {'model': model, 'messages': messages, 'stream': True}
        upstream_effort = self._resolve_upstream_effort(model, effort)
        if upstream_effort:
            body['reasoning_effort'] = upstream_effort
        payload = json.dumps(body, ensure_ascii=False).encode('utf-8')
        start = self._clock()
        conn, sock = self._connect(min(self.first_timeout, self.total_timeout))
        resp = None
        got_text = False
        got_output = False  # text or reasoning: switches from the first-output to the total deadline
        which = 'first'
        try:
            def arm():
                """Socket timeout = time left until the applicable deadline."""
                now = self._clock()
                total_left = start + self.total_timeout - now
                first_left = start + self.first_timeout - now
                if total_left <= 0:
                    raise _Deadline('total')
                if not got_output and first_left <= 0:
                    raise _Deadline('first')
                if not got_output and first_left < total_left:
                    sock.settimeout(first_left)
                    return 'first'
                sock.settimeout(total_left)
                return 'total'

            try:
                try:
                    which = arm()
                    conn.request('POST', self._prefix + '/v1/chat/completions', body=payload,
                                 headers=self._headers())
                    which = arm()
                    resp = conn.getresponse()
                except TimeoutError:
                    raise _Deadline(which)
                except (OSError, http.client.HTTPException):
                    raise NewsError('gateway', self._unreachable_msg())
                if resp.status != 200:
                    try:
                        err = resp.read(4096)
                    except (OSError, http.client.HTTPException):
                        err = b''
                    self._raise_http(resp.status, err)
                done = False
                buf = b''
                stray = []  # non-SSE lines: a JSON/plain body answered with 200
                eof = False
                while not done:
                    nl = buf.find(b'\n')
                    if nl < 0:
                        if eof or len(buf) > (1 << 20):
                            if not buf:
                                break
                            nl, eof = len(buf), True
                        else:
                            # Read in pieces and re-check the deadline between them, so a server
                            # that dribbles bytes without finishing a line is still cut off.
                            if resp.isclosed():
                                eof = True
                                continue
                            which = arm()
                            try:
                                piece = resp.read1(65536)
                            except TimeoutError:
                                raise _Deadline(which)
                            except (OSError, http.client.HTTPException):
                                piece = b''
                            if not piece:
                                eof = True
                            buf += piece
                            continue
                    line, buf = buf[:nl], buf[nl + 1:]
                    line = line.decode('utf-8', 'replace').strip()
                    if not line.startswith('data:'):
                        if line and not line.startswith(':') and sum(map(len, stray)) < 4096:
                            stray.append(line)
                        continue
                    data = line[5:].strip()
                    if data == '[DONE]':
                        done = True
                        break
                    try:
                        obj = json.loads(data)
                    except ValueError:
                        continue
                    if not isinstance(obj, dict):
                        continue
                    if obj.get('error'):
                        self._raise_in_band(obj['error'])
                    if obj.get('qoder_queue'):
                        # The hub waits out an upstream queue in-stream (60 s rounds); that never
                        # fits the first-output deadline, so say so now instead of timing out.
                        raise NewsError('model', R_QUEUE)
                    text, reasoning = _delta(obj)
                    if text:
                        got_text = got_output = True
                        yield text
                    elif reasoning:
                        got_output = True
                        yield ''
                if not got_text:
                    if stray:
                        self._raise_stray(''.join(stray))
                    raise NewsError('model', R_NO_OUTPUT)
                if not done:
                    raise NewsError('stream', self._cut_msg())
            except _Deadline as d:
                raise NewsError('model', self._first_msg() if d.which == 'first' else self._total_msg())
        finally:
            if resp is not None:
                resp.close()
            conn.close()
            sock.close()


def _delta(obj):
    """(content, reasoning) strings of a chunk's first choice; None where absent."""
    try:
        delta = obj['choices'][0]['delta']
        content = delta.get('content')
        reasoning = delta.get('reasoning_content') or delta.get('reasoning')
    except (KeyError, IndexError, TypeError, AttributeError):
        return None, None
    return (content if isinstance(content, str) else None,
            reasoning if isinstance(reasoning, str) else None)
