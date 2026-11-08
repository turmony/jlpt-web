"""A fake qoder2api-hub for tests: OpenAI-compatible /v1/models and streaming chat completions.

FakeHub(script, models=None) listens on a random local port. `script` is a list of behaviours,
one per chat request in arrival order (the last one repeats once the list is used up). Items
are JSON-representable (lists work as well as tuples) so a script can be loaded from JSON:

    ['chunks', ['<a>', 'b</a>'], delay]   stream each text with `delay` seconds before it, then [DONE]
    ['status', 429, body]                 answer with this HTTP status; body is str or JSON-able
    ['silent', seconds]                   accept the request, send nothing for `seconds`, then close
    ['cut_after', ['部分'], delay]         stream the texts, then drop the connection without [DONE]
    ['trickle', interval, seconds, texts] stream `texts` normally, then dribble an 'x' every `interval`
                                          seconds for `seconds` seconds with no newline (a stalled line)
    ['sse', ['raw text', ...]]            200 event-stream; write the given raw strings verbatim, then close
    ['reasoning', seconds, texts, field]  stream a thinking delta (`field`, default 'reasoning_content')
                                          every 0.1 s for `seconds`, then `texts` as content, then [DONE]
    ['pings', seconds]                    200 event-stream; write a `: ping` comment every 0.1 s for
                                          `seconds`, then close (a hub that is itself still queued)

Recorded for assertions: `requests` (parsed chat bodies), `request_headers`, `max_concurrent`
(most simultaneous in-flight chat requests) and `disconnects` (chat requests whose client went away
before the hub finished answering; `wait_disconnect()` blocks until one is seen).
"""
import json
import select
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_MODELS = [
    {'id': 'Auto', 'enabled': True},
    {'id': 'DeepSeek-Flash', 'name_local': 'DeepSeek-V4-Flash', 'enabled': True,
     'reasoning_efforts': ['low', 'high', 'max']},
    {'id': 'DeepSeek-V4-Pro', 'enabled': True, 'reasoning_efforts': ['high', 'max']},
]


def _chunk(delta):
    return 'data: ' + json.dumps({'choices': [{'index': 0, 'delta': delta}]}, ensure_ascii=False) + '\n\n'


class FakeHub:
    def __init__(self, script=None, models=None):
        self.script = list(script) if script else [['chunks', ['ok'], 0]]
        self.models = list(DEFAULT_MODELS if models is None else models)
        self.requests = []
        self.request_headers = []
        self.max_concurrent = 0
        self.disconnects = 0
        self._active = 0
        self._served = 0
        self._cond = threading.Condition()
        hub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path.split('?')[0] == '/v1/models':
                    self._send_json(200, {'object': 'list', 'data': hub.models})
                else:
                    self._send_json(404, {'error': 'not found'})

            def do_POST(self):
                if self.path.split('?')[0] != '/v1/chat/completions':
                    return self._send_json(404, {'error': 'not found'})
                length = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(length) if length else b''
                with hub._cond:
                    hub.requests.append(json.loads(raw.decode('utf-8')))
                    hub.request_headers.append(dict(self.headers))
                    step = hub.script[min(hub._served, len(hub.script) - 1)]
                    hub._served += 1
                    hub._active += 1
                    hub.max_concurrent = max(hub.max_concurrent, hub._active)
                    hub._cond.notify_all()
                gone = False
                try:
                    gone = not self._run(step)
                except (BrokenPipeError, ConnectionError, OSError):
                    gone = True
                finally:
                    with hub._cond:
                        hub._active -= 1
                        if gone:
                            hub.disconnects += 1
                        hub._cond.notify_all()

            # -- helpers -------------------------------------------------
            def _send_json(self, status, obj):
                self._send_raw(status, json.dumps(obj, ensure_ascii=False), 'application/json')

            def _send_raw(self, status, body, ctype):
                data = body.encode('utf-8')
                self.send_response(status)
                self.send_header('Content-Type', ctype + '; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _alive(self, seconds):
                """Sleep up to `seconds`; return False as soon as the client has hung up."""
                end = time.monotonic() + seconds
                while True:
                    left = end - time.monotonic()
                    ready, _, _ = select.select([self.connection], [], [], max(0.0, min(left, 0.05)))
                    if ready:
                        try:
                            if self.connection.recv(1, socket.MSG_PEEK) == b'':
                                return False
                        except OSError:
                            return False
                    if left <= 0:
                        return True

            def _stream_headers(self):
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.flush()

            def _emit(self, text):
                self.wfile.write(text.encode('utf-8'))
                self.wfile.flush()

            def _run(self, step):
                """Return False when the client disconnected early."""
                kind = step[0]
                if kind == 'status':
                    body = step[2] if len(step) > 2 else ''
                    if isinstance(body, (dict, list)):
                        self._send_json(step[1], body)
                    else:
                        self._send_raw(step[1], str(body), 'text/plain')
                    return True
                if kind == 'silent':
                    return self._alive(float(step[1]))
                if kind in ('chunks', 'cut_after'):
                    texts = step[1]
                    delay = float(step[2]) if len(step) > 2 and step[2] else 0.0
                    self._stream_headers()
                    self._emit(_chunk({'role': 'assistant'}))
                    for text in texts:
                        if delay and not self._alive(delay):
                            return False
                        self._emit(_chunk({'content': text}))
                    if kind == 'cut_after':
                        self.connection.shutdown(socket.SHUT_RDWR)
                        return True
                    self._emit('data: ' + json.dumps({'choices': [], 'usage': {'total_tokens': 1}}) + '\n\n')
                    self._emit('data: [DONE]\n\n')
                    return True
                if kind == 'sse':
                    self._stream_headers()
                    for raw in step[1]:
                        self._emit(raw)
                    return True
                if kind == 'reasoning':
                    seconds, texts = float(step[1]), step[2]
                    field = step[3] if len(step) > 3 else 'reasoning_content'
                    self._stream_headers()
                    self._emit(_chunk({'role': 'assistant'}))
                    end = time.monotonic() + seconds
                    while time.monotonic() < end:
                        self._emit(_chunk({field: '思考'}))
                        if not self._alive(0.1):
                            return False
                    for text in texts:
                        self._emit(_chunk({'content': text}))
                    self._emit('data: [DONE]\n\n')
                    return True
                if kind == 'pings':
                    self._stream_headers()
                    end = time.monotonic() + float(step[1])
                    while time.monotonic() < end:
                        self._emit(': ping\n\n')
                        if not self._alive(0.1):
                            return False
                    return True
                if kind == 'trickle':
                    interval, seconds, texts = float(step[1]), float(step[2]), step[3]
                    self._stream_headers()
                    for text in texts:
                        self._emit(_chunk({'content': text}))
                    end = time.monotonic() + seconds
                    while time.monotonic() < end:
                        if not self._alive(interval):
                            return False
                        self._emit('x')
                    return True
                self._send_json(500, {'error': 'unknown script step %r' % (kind,)})
                return True

        self._server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        self.base_url = 'http://127.0.0.1:%d' % self.port
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self._thread.start()

    def wait_disconnect(self, count=1, timeout=3.0):
        """Block until `count` client disconnects were observed; True if they were."""
        with self._cond:
            return self._cond.wait_for(lambda: self.disconnects >= count, timeout)

    def wait_requests(self, count, timeout=3.0):
        with self._cond:
            return self._cond.wait_for(lambda: len(self.requests) >= count, timeout)

    def close(self):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(2)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
