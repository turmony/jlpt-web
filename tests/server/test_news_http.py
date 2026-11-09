"""News reader HTTP routes, SSE streaming and per-stage errors (Task 6)."""
import http.client
import importlib.util
import io
import json
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

from server.app import Application, create_server
from server.auth import Auth
from server.llm import Hub
from server.news import NewsService, match_card, start_cleanup
from server import news_text
from server.news_text import TokenizerUnavailable, split_sentences
from tests.server.fake_hub import FakeHub

HAVE_FUGASHI = importlib.util.find_spec('fugashi') is not None
ORIGIN = 'http://test.local'
KEY = 'sk-news-secret-999'
PASSWORD_HASH = Auth.hash_password('secret')
CATALOG = {'cards': [
    {'level': 'N2', 'number': 7, 'title': '～おそれがある（有……的危险）'},
    {'level': 'N1', 'number': 2, 'title': '～いかん・～いかんによって：取决于'},
    {'level': 'N3', 'number': 12, 'title': 'ばかりか／ばかりでなく(不仅)'},
    {'level': 'N4', 'number': 3, 'title': 'つ〜つ（…来…去）'},
]}
ANALYSIS = ['<analysis><selection><reading>どうが</reading><role>主语</role>',
            '<meaning>视频</meaning></selection><transla', 'tion>视频之前的正文。</translation><grammar>',
            '<item related="true"><form>〜おそれがある</form><level>N2</level><brief>可能</brief>',
            '<connection>名词+の</connection><usage>表示担心</usage></item>',
            '<item related="false"><form>〜ている</form><level>N5</level><brief>持续</brief>',
            '<connection>て形</connection><usage>状态</usage></item></grammar></analysis>']


def fake_sentences(text, start_id):
    """One token per character: lets everything but real tokenizing run without fugashi."""
    return [{'id': start_id + i, 'tokens': [{'s': c, 'r': c, 'l': c, 'p': '名詞', 't': True} for c in s]}
            for i, s in enumerate(split_sentences(text))]


class NewsHTTPBase(unittest.TestCase):
    patch_tokens = True

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.static = root / 'static'
        (self.static / 'grammar').mkdir(parents=True)
        (self.static / 'index.html').write_text('private home')
        (self.static / 'grammar' / 'catalog.json').write_text(json.dumps(CATALOG, ensure_ascii=False))
        self.config = {'state': str(root), 'study': str(root / 'study'), 'static': str(self.static),
                       'origin': ORIGIN, 'secure_cookie': False,
                       'password_hash': PASSWORD_HASH}
        self.app = Application(self.config)
        self.server = create_server(self.app, ('127.0.0.1', 0))
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_port
        self.url = f'http://127.0.0.1:{self.port}'
        self.cookie = ''
        if self.patch_tokens:
            p = mock.patch('server.news.to_sentences', fake_sentences)
            p.start()
            self.addCleanup(p.stop)
        self.stderr = io.StringIO()
        p = mock.patch('server.news.sys.stderr', self.stderr)
        p.start()
        self.addCleanup(p.stop)

    # -- wiring --------------------------------------------------------------
    def use(self, script=None, models=None, select='DeepSeek-Flash', hub=True, **hub_kw):
        self.fake = None
        h = None
        if hub:
            self.fake = FakeHub(script, models)
            self.addCleanup(self.fake.close)
            kw = {'first_timeout': 0.5, 'total_timeout': 2}
            kw.update(hub_kw)
            h = Hub(self.fake.base_url, KEY, **kw)
        self.svc = NewsService(self.config, Path(self.config['state']), hub=h)
        self.app.news = self.svc
        if select:
            self.svc.store.save_settings({'model': select})
        return self.svc

    def login(self):
        response = self.request('/api/login', {'password': 'secret'})
        self.assertEqual(response.status, 200)
        self.cookie = response.headers['Set-Cookie'].split(';')[0]

    def request(self, path, data=None, origin=ORIGIN):
        headers = {'Cookie': self.cookie}
        if data is not None:
            headers.update({'Content-Type': 'application/json', 'Origin': origin})
        req = urllib.request.Request(self.url + path, data=None if data is None else json.dumps(data).encode(),
                                     headers=headers)
        try:
            return urllib.request.urlopen(req, timeout=10)
        except urllib.error.HTTPError as error:
            return error

    def json(self, path, data=None, status=200):
        resp = self.request(path, data)
        body = json.loads(resp.read())
        self.assertEqual(resp.status, status, body)
        return body

    @staticmethod
    def parse_events(raw):
        events = []
        for frame in raw.decode('utf-8').split('\n\n'):
            name, data = None, []
            for line in frame.split('\n'):
                if line.startswith('event: '):
                    name = line[7:]
                elif line.startswith('data: '):
                    data.append(line[6:])
            if name:
                events.append((name, json.loads('\n'.join(data))))
        return events

    def sse_response(self, path, body):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=15)
        self.addCleanup(conn.close)
        conn.request('POST', path, json.dumps(body), {'Cookie': self.cookie, 'Origin': ORIGIN,
                                                     'Content-Type': 'application/json'})
        return conn.getresponse()

    def sse(self, path, body):
        resp = self.sse_response(path, body)
        raw = resp.read()
        self.assertEqual(resp.status, 200, raw)
        return self.parse_events(raw)

    PARAGRAPH = '昨日は雨だった。動画の前の本文。'
    SENTENCE = '動画の前の本文。'

    def analyze_body(self, start=None, end=None, paragraph=None, tokens=None):
        """A sentence as the userscript sends it: its paragraph, the sentence's token surfaces
        (one per character here) and the selected token range."""
        return {'paragraph': self.PARAGRAPH if paragraph is None else paragraph,
                'tokens': list(self.SENTENCE) if tokens is None else tokens, 'start': start, 'end': end}


class AccessTests(NewsHTTPBase):
    def test_news_endpoints_need_login_and_same_origin(self):
        self.use()
        for path in ('/api/news/models', '/api/news/client.js'):
            self.assertEqual(self.request(path).status, 401)
        for path in ('/api/news/tokenize', '/api/news/analyze', '/api/news/gloss', '/api/news/settings'):
            self.assertEqual(self.request(path, {}).status, 401)
        self.login()
        for path in ('/api/news/tokenize', '/api/news/analyze', '/api/news/ask', '/api/news/settings'):
            self.assertEqual(self.request(path, {}, origin='https://evil.example').status, 403)
        self.assertEqual(self.json('/api/news/models')['selected'], 'DeepSeek-Flash')

    def test_application_without_llm_reports_gateway_not_configured(self):
        self.login()
        self.assertNotIn('llm', self.config)
        err = self.json('/api/news/models', status=502)['error']
        self.assertEqual((err['stage'], err['reason']), ('gateway', '未配置 qoder2api-hub'))
        err = self.json('/api/news/gloss', {'lemma': '本', 'reading': 'ほん', 'pos': '名詞'}, status=502)['error']
        self.assertEqual(err['stage'], 'gateway')

    def test_removed_routes_are_404(self):
        self.use()
        self.login()
        self.assertEqual(self.request('/api/news/feeds?cat=domestic').status, 404)
        self.assertEqual(self.request('/api/news/open', {}).status, 404)
        self.assertEqual(self.request('/api/news/image/abcdef12/0').status, 404)

    def test_unknown_news_path_is_404(self):
        self.use()
        self.login()
        self.assertEqual(self.request('/api/news/nothing').status, 404)


class ModelTests(NewsHTTPBase):
    def test_models_and_settings(self):
        self.use(select=None)
        self.login()
        body = self.json('/api/news/models')
        self.assertIsNone(body['selected'])
        self.assertEqual([m['id'] for m in body['models']], ['Auto', 'DeepSeek-Flash', 'DeepSeek-V4-Pro'])
        self.assertEqual(self.json('/api/news/settings', {'model': 'DeepSeek-V4-Pro'})['selected'], 'DeepSeek-V4-Pro')
        self.assertEqual(self.json('/api/news/models')['selected'], 'DeepSeek-V4-Pro')
        err = self.json('/api/news/settings', {'model': 'Gone'}, status=502)['error']
        self.assertEqual((err['stage'], err['reason']), ('model', '当前模型不可用，请重新选择'))
        self.assertEqual(self.json('/api/news/settings', {'model': 7}, status=400)['error']['stage'], 'client')

    def test_gloss_cached_second_call_hits_no_hub(self):
        self.use(script=[('chunks', ['<gloss><meaning>', '书；书本</meaning></gloss>'], 0)])
        self.login()
        word = {'lemma': '本', 'reading': 'ほん', 'pos': '名詞'}
        self.assertEqual(self.json('/api/news/gloss', word), {'meaning': '书；书本'})
        self.assertEqual(self.json('/api/news/gloss', word), {'meaning': '书；书本'})
        self.assertEqual(len(self.fake.requests), 1)
        self.assertEqual(self.fake.requests[0]['reasoning_effort'], 'low')
        self.assertEqual(self.fake.requests[0]['model'], 'DeepSeek-Flash')

    def test_gloss_bad_format_is_not_cached(self):
        self.use(script=[('chunks', ['只是文字'], 0), ('chunks', ['<meaning>书</meaning>'], 0)])
        self.login()
        word = {'lemma': '本', 'reading': 'ほん', 'pos': '名詞'}
        err = self.json('/api/news/gloss', word, status=502)['error']
        self.assertEqual((err['stage'], err['location']), ('format', '查词：本'))
        self.assertEqual(self.json('/api/news/gloss', word), {'meaning': '书'})
        self.assertEqual(len(self.fake.requests), 2)

    def test_gloss_rejects_bad_body(self):
        self.use()
        self.login()
        for body in ({'lemma': '', 'reading': '', 'pos': ''}, {'lemma': 1, 'reading': 'a', 'pos': 'b'},
                     {'lemma': 'x' * 200, 'reading': 'a', 'pos': 'b'}):
            self.assertEqual(self.json('/api/news/gloss', body, status=400)['error']['stage'], 'client')
        resp = self.request('/api/news/gloss', None)
        self.assertEqual(resp.status, 404)  # GET is not a route

    def test_no_model_selected_reports_model_stage(self):
        self.use(select=None)
        self.login()
        err = self.sse('/api/news/analyze', self.analyze_body())[-1]
        self.assertEqual(err[0], 'error')
        self.assertEqual((err[1]['stage'], err[1]['reason'], err[1]['retryable']),
                         ('model', '请先点右下角按钮，在菜单里选择模型', False))
        err = self.json('/api/news/gloss', {'lemma': '本', 'reading': 'ほん', 'pos': '名詞'}, status=502)['error']
        self.assertEqual(err['reason'], '请先点右下角按钮，在菜单里选择模型')
        self.assertEqual(self.fake.requests, [])

    def test_selected_model_gone_reports_unavailable(self):
        self.use(select='Retired')
        self.login()
        err = self.sse('/api/news/analyze', self.analyze_body())[-1][1]
        self.assertEqual((err['stage'], err['reason'], err['retryable']), ('model', '当前模型不可用，请重新选择', False))
        self.assertEqual(self.fake.requests, [])


class TokenizeTests(NewsHTTPBase):
    def test_tokenize_returns_sentences_per_paragraph(self):
        self.use()
        self.login()
        paragraphs = ['今日は晴れ。明日は雨。', '「はい。」と言った。']
        body = self.json('/api/news/tokenize', {'paragraphs': paragraphs})
        self.assertEqual([len(p) for p in body['paragraphs']], [2, 1])
        for text, sentences in zip(paragraphs, body['paragraphs']):
            for sentence in sentences:
                self.assertEqual(list(sentence), ['tokens'])  # no sentence ids
                self.assertEqual(set(sentence['tokens'][0]), {'s', 'r', 'l', 'p', 't'})
            self.assertEqual(''.join(t['s'] for s in sentences for t in s['tokens']), text)
        self.assertEqual(''.join(t['s'] for t in body['paragraphs'][0][1]['tokens']), '明日は雨。')

    def test_tokenize_limits(self):
        self.use()
        self.login()
        too_many = {'paragraphs': ['あ'] * 201}
        too_long = {'paragraphs': ['あ' * 10000, 'あ' * 10001]}
        for body in (too_many, too_long):
            err = self.json('/api/news/tokenize', body, status=400)['error']
            self.assertEqual((err['stage'], err['reason']), ('client', '分词请求超过 200 段或 2 万字'))
        self.assertEqual(len(self.json('/api/news/tokenize', {'paragraphs': ['あ'] * 200})['paragraphs']), 200)
        for body in ({'paragraphs': [1]}, {'paragraphs': ['あ', None]}, {'paragraphs': 'あ'}, {}):
            err = self.json('/api/news/tokenize', body, status=400)['error']
            self.assertEqual((err['stage'], err['reason']), ('client', '分词请求格式不对'), body)

    def test_tokenize_unavailable_names_the_paragraph(self):
        self.use()
        self.login()
        with mock.patch('server.news.to_sentences', side_effect=TokenizerUnavailable('ImportError: fugashi')):
            err = self.json('/api/news/tokenize', {'paragraphs': ['今日は晴れ。']}, status=502)['error']
        self.assertEqual((err['stage'], err['location'], err['retryable']), ('tokenize', '第 1 段', False))
        self.assertRegex(err['request_id'], r'^n-\d{8}-[0-9a-f]{4}$')

    @unittest.skipUnless(HAVE_FUGASHI, 'fugashi not installed')
    def test_tokenize_with_the_real_tokenizer(self):
        self.use()
        self.login()
        paragraphs = ['今日は晴れ。\n明日は雨。']
        with mock.patch('server.news.to_sentences', news_text.to_sentences):
            body = self.json('/api/news/tokenize', {'paragraphs': paragraphs})
        # A line break is a sentence boundary and is not part of either sentence.
        self.assertEqual([''.join(t['s'] for t in s['tokens']) for s in body['paragraphs'][0]],
                         ['今日は晴れ。', '明日は雨。'])


class AnalyzeTests(NewsHTTPBase):
    def test_analyze_streams_sections_and_links_card(self):
        self.use(script=[('chunks', ANALYSIS, 0)])
        self.login()
        # select 動画 (characters 0..1 with fake tokens)
        events = self.sse('/api/news/analyze', self.analyze_body(0, 1))
        names = [e for e, _ in events]
        self.assertEqual([n for n in names if n != 'progress'], ['selection', 'translation', 'grammar', 'grammar', 'done'])
        ev = dict((n, d) for n, d in events if n in ('selection', 'translation', 'done'))
        self.assertEqual(ev['selection']['meaning'], '视频')
        self.assertEqual(ev['translation']['text'], '视频之前的正文。')
        grammar = [d for n, d in events if n == 'grammar']
        self.assertEqual(grammar[0]['card'], '/grammar/#N2/7-7')
        self.assertTrue(grammar[0]['related'])
        self.assertIsNone(grammar[1]['card'])
        self.assertEqual(ev['done']['analysis_text'], ''.join(ANALYSIS))
        req = self.fake.requests[0]
        self.assertEqual(req['reasoning_effort'], 'low')
        user = req['messages'][-1]['content']
        self.assertIn('動画の前の本文。', user)
        self.assertIn('选中部分：\n動画', user)

    def test_analyze_takes_sentence_from_body(self):
        self.use(script=[('chunks', ['<translation>x</translation>'], 0)])
        self.login()
        paragraph = '第一句。\n「ゆうべは雨だった」と彼は言った。'
        tokens = ['「', 'ゆうべ', 'は', '雨', 'だった', '」']
        events = self.sse('/api/news/analyze', {'paragraph': paragraph, 'tokens': tokens, 'start': 1, 'end': 2})
        self.assertEqual(events[-1][0], 'done', events)
        user = self.fake.requests[0]['messages'][-1]['content']
        self.assertIn(paragraph, user)
        self.assertIn('原句：\n「ゆうべは雨だった」', user)
        self.assertIn('选中部分：\nゆうべは', user)

    def test_analyze_whole_sentence_has_no_selection(self):
        self.use(script=[('chunks', ['<translation>图片说明</translation>'], 0)])
        self.login()
        events = self.sse('/api/news/analyze', self.analyze_body())
        self.assertEqual([n for n, _ in events if n != 'progress'], ['translation', 'done'])
        user = self.fake.requests[0]['messages'][-1]['content']
        self.assertIn('動画の前の本文。', user)
        self.assertNotIn('选中部分', user)

    def test_unparsable_reply_reports_format_after_raw_text(self):
        self.use(script=[('chunks', ['完全没有标签的回答'], 0)])
        self.login()
        events = self.sse('/api/news/analyze', self.analyze_body())
        self.assertEqual(events[-2], ('extra', {'text': '完全没有标签的回答'}))
        self.assertEqual(events[-1][1]['stage'], 'format')

    def test_bad_selection_bodies_are_400(self):
        self.use()
        self.login()
        bad = [self.analyze_body(0, None), self.analyze_body(2, 1), self.analyze_body(-1, 0),
               self.analyze_body(0, 99), self.analyze_body(True, True), self.analyze_body(0.0, 1.0),
               self.analyze_body(0, 8)]
        for body in bad:
            err = self.json('/api/news/analyze', body, status=400)['error']
            self.assertEqual(err['stage'], 'client', body)
        ask = {**self.analyze_body(), 'analysis': '', 'history': [], 'question': 'x' * 501}
        self.assertEqual(self.json('/api/news/ask', ask, status=400)['error']['stage'], 'client')
        for history in ([{'q': 'a'}], [{'q': 1, 'a': 'b'}], 'no', [None]):
            body = {**ask, 'question': '为什么？', 'history': history}
            self.assertEqual(self.json('/api/news/ask', body, status=400)['error']['stage'], 'client', history)
        self.assertEqual(self.fake.requests, [])

    def test_bad_sentence_bodies_are_400(self):
        self.use()
        self.login()
        cases = [
            (self.analyze_body(tokens=['全然', '違う']), '句子不在段落中'),
            (self.analyze_body(tokens=['あ'] * 401, paragraph='あ' * 500), None),
            (self.analyze_body(paragraph='あ' * 4001, tokens=['あ']), None),
            (self.analyze_body(0, 8), '选中范围超出句子'),
            (self.analyze_body(tokens=['あ' * 101], paragraph='あ' * 101), None),
            (self.analyze_body(tokens=[]), None),
            (self.analyze_body(paragraph=''), None),
            (self.analyze_body(tokens='動画'), None),
            (self.analyze_body(tokens=['動画', 1]), None),
            (self.analyze_body(tokens=['']), '句子无效'),
            (self.analyze_body(tokens=['動画', '', 'の']), '句子无效'),
            (self.analyze_body(paragraph=5), None),
            ({'tokens': ['動画']}, None),
        ]
        for body, reason in cases:
            err = self.json('/api/news/analyze', body, status=400)['error']
            self.assertEqual(err['stage'], 'client', body)
            if reason:
                self.assertEqual(err['reason'], reason)
        empty = {**self.analyze_body(tokens=['動画', '']), 'analysis': '', 'history': [], 'question': '为什么？'}
        self.assertEqual(self.json('/api/news/ask', empty, status=400)['error']['reason'], '句子无效')
        # The limits themselves are allowed.
        ok = self.analyze_body(paragraph='あ' * 4000, tokens=['あ'] * 400)
        self.use(script=[('chunks', ['<translation>x</translation>'], 0)])
        self.assertEqual(self.sse('/api/news/analyze', ok)[-1][0], 'done')
        self.assertEqual(self.json('/api/news/ask', {**ok, 'analysis': '', 'history': [], 'question': 'x' * 501},
                                   status=400)['error']['stage'], 'client')


class AskTests(NewsHTTPBase):
    def ask_body(self, question='为什么用这个形式？', history=None):
        return {**self.analyze_body(0, 1), 'analysis': '<translation>x</translation>',
                'history': history or [], 'question': question}

    def test_ask_streams_deltas_and_sends_last_six_rounds(self):
        self.use(script=[('chunks', ['因为', '是持续。'], 0)])
        self.login()
        history = [{'q': 'q%d' % i, 'a': 'a%d' % i} for i in range(8)]
        events = self.sse('/api/news/ask', self.ask_body(history=history))
        self.assertEqual([(n, d) for n, d in events if n != 'progress'],
                         [('delta', {'text': '因为'}), ('delta', {'text': '是持续。'}), ('done', {})])
        msgs = self.fake.requests[0]['messages']
        self.assertEqual([m['content'] for m in msgs if m['role'] == 'user'][:-1], ['q%d' % i for i in range(2, 8)])
        self.assertEqual(msgs[-1]['content'], '为什么用这个形式？')
        self.assertIn('動画', msgs[0]['content'])

    def test_at_most_three_model_requests_at_once(self):
        self.use(script=[('chunks', ['a', 'b'], 0.4)], first_timeout=5)
        self.login()
        # Count open upstream streams on our side too: exact, unlike the hub's count, which lags
        # a moment behind a finished answer.
        lock, active, peak = threading.Lock(), [0], [0]
        stream = self.svc.hub.stream

        def counting(*args, **kwargs):
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            try:
                yield from stream(*args, **kwargs)
            finally:
                with lock:
                    active[0] -= 1
        self.svc.hub.stream = counting
        results = []

        def one():
            results.append(self.sse('/api/news/ask', self.ask_body()))
        threads = [threading.Thread(target=one) for _ in range(5)]
        for t in threads:
            t.start()
        self.assertTrue(self.fake.wait_requests(3))
        time.sleep(0.2)  # the other two are queued, not sent
        self.assertEqual((len(self.fake.requests), self.fake.max_concurrent), (3, 3))
        for t in threads:
            t.join(15)
        self.assertEqual(len(results), 5)
        self.assertEqual(len(self.fake.requests), 5)
        self.assertEqual(peak[0], 3)
        self.assertTrue(all(r[-1][0] == 'done' for r in results), results)
        queued = [r for r in results if ('progress', {'stage': 'model', 'text': '排队中…'}) in r]
        self.assertEqual(len(queued), 2)

    def test_client_disconnect_cancels_upstream(self):
        self.use(script=[('chunks', ['字'] * 60, 0.05), ('chunks', ['ok'], 0)])
        self.login()
        sock = socket.create_connection(('127.0.0.1', self.port), timeout=10)
        body = json.dumps(self.ask_body()).encode()
        sock.sendall(('POST /api/news/ask HTTP/1.1\r\nHost: x\r\nOrigin: %s\r\nCookie: %s\r\n'
                      'Content-Type: application/json\r\nContent-Length: %d\r\n\r\n'
                      % (ORIGIN, self.cookie, len(body))).encode() + body)
        got = b''
        while b'event: delta' not in got:
            chunk = sock.recv(4096)
            self.assertTrue(chunk)
            got += chunk
        sock.close()
        self.assertTrue(self.fake.wait_disconnect(timeout=5))
        # The slot was released: three more requests can still run at once.
        events = self.sse('/api/news/ask', self.ask_body())
        self.assertEqual(events[-1][0], 'done')
        deadline = time.time() + 2
        while self.svc.slots._value != 3 and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(self.svc.slots._value, 3)


class ReasoningHTTPTests(NewsHTTPBase):
    """A model that thinks before answering: thinking keeps the request alive and lets the server
    notice a browser that went away."""

    def test_analysis_after_long_thinking_succeeds(self):
        self.use(script=[('reasoning', 0.8, ANALYSIS)])  # first_timeout 0.5
        self.login()
        events = self.sse('/api/news/analyze', self.analyze_body())
        self.assertEqual(events[-1], ('done', {'analysis_text': ''.join(ANALYSIS)}), events)
        self.assertNotIn('思考', json.dumps(events, ensure_ascii=False))

    def test_ask_after_thinking_sends_no_empty_deltas(self):
        self.use(script=[('reasoning', 0.8, ['因为', '是持续。'])])
        self.login()
        body = {**self.analyze_body(0, 1), 'analysis': '', 'history': [], 'question': '为什么？'}
        events = self.sse('/api/news/ask', body)
        self.assertEqual([(n, d) for n, d in events if n != 'progress'],
                         [('delta', {'text': '因为'}), ('delta', {'text': '是持续。'}), ('done', {})])

    def test_client_gone_while_model_thinks_is_noticed_and_frees_the_slot(self):
        self.use(script=[('reasoning', 10, ['never']), ('chunks', ANALYSIS, 0)],
                 first_timeout=5, total_timeout=20)
        self.svc.slots = threading.BoundedSemaphore(1)  # a leaked slot would queue the next request
        self.login()
        sock = socket.create_connection(('127.0.0.1', self.port), timeout=10)
        body = json.dumps(self.analyze_body()).encode()
        sock.sendall(('POST /api/news/analyze HTTP/1.1\r\nHost: x\r\nOrigin: %s\r\nCookie: %s\r\n'
                      'Content-Type: application/json\r\nContent-Length: %d\r\n\r\n'
                      % (ORIGIN, self.cookie, len(body))).encode() + body)
        self.assertTrue(self.fake.wait_requests(1))
        time.sleep(0.3)  # the model is thinking
        sock.close()
        self.assertTrue(self.fake.wait_disconnect(timeout=3))
        events = self.sse('/api/news/analyze', self.analyze_body())
        self.assertEqual(events[-1][0], 'done', events)
        self.assertNotIn(('progress', {'stage': 'model', 'text': '排队中…'}), events)


class StageErrorTests(NewsHTTPBase):
    def test_every_stage_error_has_request_id_and_location(self):
        self.login()
        errors = []

        # Tokenizer missing.
        self.use()
        with mock.patch('server.news.to_sentences', side_effect=TokenizerUnavailable('ImportError: fugashi')):
            errors.append(('tokenize', self.json('/api/news/tokenize', {'paragraphs': ['今日は晴れ。']}, status=502)['error']))

        # Model-side failures, all through sentence analysis.
        cases = [
            ('model', [('status', 429, {'error': {'message': 'rate limited'}})], {}),
            ('model', [('status', 404, {'error': {'message': 'model not found'}})], {}),
            ('model', [('sse', ['data: {"error": {"code": 10605, "message": "queue"}}\n\n'])], {}),
            ('stream', [('cut_after', ['<translation>半'], 0)], {}),
            ('model', [('silent', 2)], {}),
            ('format', [('chunks', ['没有标签'], 0)], {}),
        ]
        for stage, script, kw in cases:
            self.use(script=script, **kw)
            errors.append((stage, self.sse('/api/news/analyze', self.analyze_body())[-1][1]))
        # qoder2api-hub stopped.
        self.use()
        self.fake.close()
        errors.append(('gateway', self.sse('/api/news/analyze', self.analyze_body())[-1][1]))

        # The hub cut off mid-answer: told apart from the browser's own network drop (回答中断).
        self.assertEqual([e['reason'] for s, e in errors if s == 'stream'], ['qoder2api-hub 中途断开'])
        for stage, err in errors:
            self.assertEqual(err['stage'], stage, err)
            self.assertRegex(err['request_id'], r'^n-\d{8}-[0-9a-f]{4}$')
            self.assertTrue(err['location'], err)
            self.assertTrue(err['reason'])
        log = self.stderr.getvalue()
        for _stage, err in errors:
            self.assertIn(err['request_id'], log)
        self.assertNotIn(KEY, log)
        line = next(l for l in log.splitlines() if errors[0][1]['request_id'] in l)
        self.assertIn('tokenize', line)
        self.assertIn('/api/news/tokenize', line)

    def test_tokenize_unavailable_via_real_splitter(self):
        self.use()
        self.login()
        # The real splitter with a tokenizer that reports the component missing.
        with mock.patch('server.news.to_sentences', news_text.to_sentences), \
                mock.patch('server.news_text.tokenize', side_effect=TokenizerUnavailable('ImportError')):
            err = self.json('/api/news/tokenize', {'paragraphs': ['今日は晴れ。']}, status=502)['error']
        self.assertEqual((err['stage'], err['retryable']), ('tokenize', False))


class UnitTests(unittest.TestCase):
    def test_match_card(self):
        cards = CATALOG['cards']
        self.assertEqual(match_card('〜おそれがある', cards), '/grammar/#N2/7-7')
        self.assertEqual(match_card(' おそれがある ', cards), '/grammar/#N2/7-7')
        self.assertEqual(match_card('～いかんによって', cards), '/grammar/#N1/2-2')
        self.assertEqual(match_card('いかん', cards), '/grammar/#N1/2-2')
        self.assertEqual(match_card('ばかりでなく', cards), '/grammar/#N3/12-12')
        self.assertEqual(match_card('つ〜つ', cards), '/grammar/#N4/3-3')
        self.assertIsNone(match_card('おそれ', cards))
        self.assertIsNone(match_card('取决于', cards))
        self.assertIsNone(match_card('', cards))
        self.assertIsNone(match_card('〜', cards))
        self.assertIsNone(match_card('おそれがある', None))

    def test_missing_catalog_links_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            svc = NewsService({'state': tmp, 'static': str(Path(tmp) / 'nope')}, Path(tmp))
            self.assertIsNone(svc.card_for('おそれがある'))

    def test_construction_cleans_up_once(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch('server.news.NewsStore.cleanup') as cleanup:
            NewsService({'state': tmp, 'static': tmp, 'llm': {'base_url': 'http://127.0.0.1:9', 'api_key': 'k'}},
                        Path(tmp))
            self.assertEqual(cleanup.call_count, 1)

    def test_start_cleanup_runs_periodically(self):
        calls = []

        class Store:
            def cleanup(self):
                calls.append(1)
                if len(calls) == 1:
                    raise OSError('busy')
        svc = mock.Mock(store=Store())
        stop = threading.Event()
        with mock.patch('server.news.sys.stderr', io.StringIO()):
            thread = start_cleanup(svc, interval=0.01, stop=stop)
            self.assertTrue(thread.daemon)
            deadline = time.time() + 2
            while len(calls) < 3 and time.time() < deadline:
                time.sleep(0.01)
            stop.set()
            thread.join(1)
        self.assertGreaterEqual(len(calls), 3)


if __name__ == '__main__':
    unittest.main()
