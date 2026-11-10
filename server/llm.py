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

R_UNREACHABLE = 'qoder2api-hub 未运行或无法连接'
R_BAD_KEY = 'API Key 无效'
R_QUEUE = '模型排队中，请稍后重试'
R_UNAVAILABLE = '当前模型不可用，请重新选择'
R_NO_OUTPUT = '模型没有返回内容'
R_CUT = 'qoder2api-hub 中途断开'


def _fmt_seconds(s):
    return '%g' % s


class _Deadline(Exception):
    def __init__(self, which):
        self.which = which


class Hub:
    def __init__(self, base_url, api_key, first_timeout=30, total_timeout=120, clock=time.monotonic):
        parts = urlsplit(base_url)
        self._https = parts.scheme == 'https'
        self._host = parts.hostname or '127.0.0.1'
        self._port = parts.port or (443 if self._https else 80)
        self._prefix = parts.path.rstrip('/')
        self._key = api_key or ''
        self.first_timeout = first_timeout
        self.total_timeout = total_timeout
        self._clock = clock
        self._lock = threading.Lock()
        self._models = None
        self._models_at = 0.0

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
            raise NewsError('gateway', R_UNREACHABLE)
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
                return [dict(m) for m in self._models]
        result = self._fetch_models()
        with self._lock:
            self._models = result
            self._models_at = self._clock()
        return [dict(m) for m in result]

    def _fetch_models(self):
        conn, _sock = self._connect(self.first_timeout)
        try:
            try:
                conn.request('GET', self._prefix + '/v1/models', headers=self._headers())
                resp = conn.getresponse()
                body = resp.read(1 << 20)
            except OSError:
                raise NewsError('gateway', R_UNREACHABLE)
            except http.client.HTTPException:
                raise NewsError('gateway', R_UNREACHABLE)
            if resp.status != 200:
                self._raise_http(resp.status, body)
        finally:
            conn.close()
        try:
            data = json.loads(body.decode('utf-8'))['data']
            result = []
            for m in data:
                if not isinstance(m, dict) or not m.get('id') or m.get('enabled') is False:
                    continue
                efforts = [e for e in (m.get('reasoning_efforts') or []) if e in EFFORT_ORDER]
                effort = min(efforts, key=EFFORT_ORDER.index) if efforts else None
                result.append({'id': m['id'], 'name': m.get('name_local') or m['id'], 'effort': effort})
            return result
        except (ValueError, KeyError, TypeError):
            raise NewsError('gateway', 'qoder2api-hub 返回的模型列表无法识别')

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
        if effort:
            body['reasoning_effort'] = effort
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
                    raise NewsError('gateway', R_UNREACHABLE)
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
                    raise NewsError('stream', R_CUT)
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
