"""News reader HTTP routes, SSE streaming and per-stage errors (Task 6)."""
import http.client
import importlib.util
import io
import json
import shutil
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
from server.news_text import TokenizerUnavailable, split_sentences
from server.news_store import image_key
from server.news_yahoo import Yahoo
from tests.server.fake_hub import FakeHub
from tests.server.news_fixture import (ARTICLE_ID, ARTICLE_URL as A, PICKUP_URL as P, article_pages,
                                      fake_fetch, fake_open, load)

HAVE_FUGASHI = importlib.util.find_spec('fugashi') is not None
ORIGIN = 'http://test.local'
KEY = 'sk-news-secret-999'
PASSWORD_HASH = Auth.hash_password('secret')
IMG = 'https://newsatcl-pctr.c.yimg.jp/t/test/photo1.jpg?exp=10800'
POSTER = 'https://newsatcl-pctr.c.yimg.jp/t/test/poster1.jpg'
PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 32
JPEG = b'\xff\xd8\xff\xe0' + b'\x00' * 64
RSS = 'https://news.yahoo.co.jp/rss/topics/domestic.xml'
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


def multi(**over):
    mapping = {P: (200, load('pickup')), A: (200, load('multi_p1')),
               A + '?page=2': (200, load('multi_p2')), A + '?page=3': (200, load('multi_p3'))}
    mapping.update(over)
    return mapping


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
    def use(self, mapping=None, script=None, models=None, select='DeepSeek-Flash', hub=True, **hub_kw):
        self.mapping = dict(mapping if mapping is not None else {A: (200, load('video')), IMG: (200, JPEG), POSTER: (200, PNG)})
        self.fake = None
        h = None
        if hub:
            self.fake = FakeHub(script, models)
            self.addCleanup(self.fake.close)
            kw = {'first_timeout': 0.5, 'total_timeout': 2}
            kw.update(hub_kw)
            h = Hub(self.fake.base_url, KEY, **kw)
        yahoo = Yahoo(fetch=fake_fetch(self.mapping), sleep=lambda s: None, open_image=fake_open(self.mapping))
        self.svc = NewsService(self.config, Path(self.config['state']), yahoo=yahoo, hub=h)
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

    def open_article(self, url=A):
        events = self.sse('/api/news/open', {'url': url})
        self.assertEqual(events[-1][0], 'article', events)
        return events[-1][1]

    def analyze_body(self, sentence=1, start=None, end=None, article=ARTICLE_ID):
        return {'article': article, 'sentence': sentence, 'start': start, 'end': end}


class AccessTests(NewsHTTPBase):
    def test_news_endpoints_need_login_and_same_origin(self):
        self.use()
        for path in ('/api/news/models', '/api/news/feeds?cat=domestic', f'/api/news/image/{ARTICLE_ID}/0'):
            self.assertEqual(self.request(path).status, 401)
        for path in ('/api/news/open', '/api/news/analyze', '/api/news/gloss', '/api/news/settings'):
            self.assertEqual(self.request(path, {}).status, 401)
        self.login()
        for path in ('/api/news/open', '/api/news/analyze', '/api/news/ask', '/api/news/settings'):
            self.assertEqual(self.request(path, {}, origin='https://evil.example').status, 403)
        self.assertEqual(self.json('/api/news/models')['selected'], 'DeepSeek-Flash')

    def test_application_without_llm_reports_gateway_not_configured(self):
        self.login()
        self.assertNotIn('llm', self.config)
        err = self.json('/api/news/models', status=502)['error']
        self.assertEqual((err['stage'], err['reason']), ('gateway', '未配置 qoder2api-hub'))
        err = self.json('/api/news/gloss', {'lemma': '本', 'reading': 'ほん', 'pos': '名詞'}, status=502)['error']
        self.assertEqual(err['stage'], 'gateway')

    def test_unknown_news_path_is_404(self):
        self.use()
        self.login()
        self.assertEqual(self.request('/api/news/nothing').status, 404)


class OpenTests(NewsHTTPBase):
    def test_open_builds_sentences_images_and_saves(self):
        self.use()
        self.login()
        events = self.sse('/api/news/open', {'url': A})
        names = [e for e, _ in events]
        self.assertEqual(names[-1], 'article')
        self.assertIn('progress', names)
        stages = [d['stage'] for e, d in events if e == 'progress']
        self.assertIn('yahoo', stages)
        self.assertIn('tokenize', stages)
        self.assertIn('image', stages)
        art = events[-1][1]
        self.assertEqual((art['id'], art['title'], art['media']), (ARTICLE_ID, '動画つきの見出し', 'テスト通信'))
        types = [b['type'] for b in art['blocks']]
        self.assertEqual(types, ['heading', 'paragraph', 'video', 'unknown', 'paragraph', 'image'])
        ids = []
        for b in art['blocks']:
            for s in b.get('sentences', []) + b.get('caption_sentences', []):
                ids.append(s['id'])
        self.assertEqual(ids, list(range(len(ids))))
        self.assertEqual(len(ids), 4)
        image = art['blocks'][-1]
        self.assertEqual(image, {'type': 'image', 'index': 1, 'credit': 'テスト提供', 'ok': True, 'key': image_key(IMG)[:16],
                                 'caption_sentences': image['caption_sentences']})
        self.assertEqual(''.join(t['s'] for t in image['caption_sentences'][0]['tokens']), '画像：テスト')
        self.assertEqual(art['blocks'][2], {'type': 'video', 'url': 'https://news.yahoo.co.jp/video/test/1.m3u8',
                                            'cover': 0, 'cover_key': image_key(POSTER)[:16]})
        self.assertEqual(art['errors'], [])
        self.assertEqual(self.svc.store.load_article(ARTICLE_ID)['blocks'], art['blocks'])

        resp = self.request(f'/api/news/image/{ARTICLE_ID}/1')
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers['Content-Type'], 'image/jpeg')
        self.assertEqual(resp.headers['Cache-Control'], 'private, max-age=604800')
        self.assertEqual(resp.read(), JPEG)
        # The video poster is downloaded like any image and served by its index.
        resp = self.request(f'/api/news/image/{ARTICLE_ID}/0')
        self.assertEqual((resp.status, resp.headers['Content-Type'], resp.read()), (200, 'image/png', PNG))

    def test_sse_headers(self):
        self.use()
        self.login()
        resp = self.sse_response('/api/news/open', {'url': A})
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.headers['Content-Type'], 'text/event-stream')
        self.assertEqual(resp.headers['Cache-Control'], 'no-store')
        self.assertEqual(resp.headers['X-Accel-Buffering'], 'no')
        self.assertEqual(resp.headers['Connection'], 'close')
        self.assertIsNone(resp.headers['Content-Length'])
        resp.read()

    def test_failed_image_is_recorded_and_not_served(self):
        self.use({A: (200, load('video')), IMG: (503, b''), POSTER: (200, PNG)})
        self.login()
        art = self.open_article()
        self.assertFalse(art['blocks'][-1]['ok'])
        self.assertIsNone(art['blocks'][-1]['key'])
        err = art['errors'][0]
        self.assertEqual((err['stage'], err['location']), ('image', '第 2 张'))
        self.assertRegex(err['request_id'], r'^n-\d{8}-[0-9a-f]{4}$')
        self.assertEqual(self.request(f'/api/news/image/{ARTICLE_ID}/1').status, 404)
        self.assertEqual(self.request(f'/api/news/image/{ARTICLE_ID}/0').status, 200)

    def test_failed_video_cover_is_null(self):
        self.use({A: (200, load('video')), IMG: (200, JPEG), POSTER: (404, b'')})
        self.login()
        art = self.open_article()
        self.assertIsNone(art['blocks'][2]['cover'])
        self.assertIsNone(art['blocks'][2]['cover_key'])
        self.assertEqual([(e['stage'], e['location']) for e in art['errors']], [('image', '第 1 张')])
        self.assertEqual(self.request(f'/api/news/image/{ARTICLE_ID}/0').status, 404)
        self.assertEqual(self.request(f'/api/news/image/{ARTICLE_ID}/1').status, 200)

    def test_off_host_image_is_refused_without_fetching(self):
        self.use()
        raw = Yahoo(fetch=fake_fetch({A: (200, load('video'))}), sleep=lambda s: None).open(A, lambda *a: None)
        raw['blocks'][-1]['src'] = 'https://evil.example/photo.jpg'
        raw['blocks'][2]['cover'] = 'https://newsatcl-pctr.c.yimg.jp.evil.com/p.jpg'
        self.login()
        with mock.patch.object(self.svc.yahoo, 'open', return_value=raw):
            art = self.open_article()
        self.assertEqual([(e['stage'], e['location']) for e in art['errors']],
                         [('image', '第 1 张'), ('image', '第 2 张')])
        self.assertEqual(self.svc.yahoo._open_image.calls, [])

    def test_non_image_bytes_are_refused(self):
        self.use({A: (200, load('video')), IMG: (200, b'<html><script>alert(1)</script>'), POSTER: (200, PNG)})
        self.login()
        art = self.open_article()
        self.assertFalse(art['blocks'][-1]['ok'])
        self.assertEqual(art['errors'][0]['stage'], 'image')
        self.assertEqual(self.request(f'/api/news/image/{ARTICLE_ID}/1').status, 404)

    def test_image_route_validates_and_requires_live_article(self):
        self.use()
        self.login()
        self.open_article()
        for path in ('/api/news/image/zz/0', f'/api/news/image/{ARTICLE_ID}/2', f'/api/news/image/{ARTICLE_ID}/-1',
                     '/api/news/image/ab12cd34/0'):
            self.assertEqual(self.request(path).status, 404, path)
        later = time.time() + 8 * 86400
        self.svc.store.now = lambda: later
        self.assertEqual(self.request(f'/api/news/image/{ARTICLE_ID}/0').status, 404)

    def test_missing_image_404_is_logged_like_other_errors(self):
        self.use()
        self.login()
        self.open_article()
        path = f'/api/news/image/{ARTICLE_ID}/2'
        resp = self.request(path)
        self.assertEqual(resp.status, 404)
        err = json.loads(resp.read())['error']
        self.assertEqual((err['stage'], err['reason']), ('image', '图片不存在或已过期'))
        line = next((l for l in self.stderr.getvalue().splitlines() if err['request_id'] in l), None)
        self.assertEqual(err['location'], '第 3 张')
        self.assertEqual(line, ' '.join([err['request_id'], 'image', '图片不存在或已过期', '第 3 张', path]))

    def test_pickup_multi_page_and_missing_page(self):
        self.use(multi(**{A + '?page=3': (503, b'')}))
        self.login()
        art = self.open_article(P)
        self.assertEqual(art['pages'], {'total': 3, 'fetched': 2, 'missing': [3]})
        err = art['errors'][0]
        self.assertEqual((err['stage'], err['location']), ('yahoo', '第 3 页 / 共 3 页'))
        self.assertRegex(err['request_id'], r'^n-')
        texts = [''.join(t['s'] for s in b['sentences'] for t in s['tokens']) for b in art['blocks']]
        self.assertEqual(texts, ['一頁目の本文。', '二頁目の本文。'])

    def test_partial_article_is_refetched_on_the_next_open(self):
        # 重试 right after a missing page must fetch again, not get the same partial result back.
        self.use(multi(**{A + '?page=3': (503, b'')}))
        calls = []
        inner = self.svc.yahoo._fetch
        self.svc.yahoo._fetch = lambda url: (calls.append(url), inner(url))[1]
        self.login()
        self.assertEqual(self.open_article()['pages']['missing'], [3])
        self.assertEqual(calls.count(A + '?page=3'), 2)  # tried, then retried once
        self.mapping[A + '?page=3'] = (200, load('multi_p3'))
        art = self.open_article()
        self.assertEqual(art['pages'], {'total': 3, 'fetched': 3, 'missing': []})
        self.assertEqual(art['errors'], [])
        self.assertEqual(calls.count(A + '?page=3'), 3)
        # Only the missing page was fetched again; page 1 came from the stored copy.
        self.assertEqual(calls.count(A), 1)
        # A complete article is still reused by an open right after it.
        self.open_article()
        self.assertEqual(len(calls), 5)

    def test_partial_reopen_fetches_only_missing_pages_and_reuses_images(self):
        img = {n: 'https://newsatcl-pctr.c.yimg.jp/t/test/page%d.jpg?exp=10800' % n for n in (1, 2, 3)}
        data = {n: JPEG + b'page%d' % n for n in (1, 2, 3)}
        mapping = {P: (200, load('pickup')), **article_pages(3, images=img),
                   img[1]: (200, data[1]), img[2]: (200, data[2]), img[3]: (200, data[3])}
        mapping[A + '?page=2'] = (404, b'')
        self.use(mapping)
        self.login()
        first = self.open_article(P)
        self.assertEqual(first['pages'], {'total': 3, 'fetched': 2, 'missing': [2]})
        self.assertEqual([(e['stage'], e['location']) for e in first['errors']], [('yahoo', '第 2 页 / 共 3 页')])
        self.assertEqual([b['index'] for b in first['blocks'] if b['type'] == 'image'], [0, 1])
        before = {b['index']: b['key'] for b in first['blocks'] if b['type'] == 'image'}
        self.assertEqual(before, {0: image_key(img[1])[:16], 1: image_key(img[3])[:16]})
        self.assertEqual(self.request(f'/api/news/image/{ARTICLE_ID}/1').read(), data[3])

        # 重试: page 2 is back; the old image URLs have expired since.
        fetch, opener = self.svc.yahoo._fetch, self.svc.yahoo._open_image
        fetch.calls.clear()
        opener.calls.clear()
        self.mapping[A + '?page=2'] = article_pages(3, images=img)[A + '?page=2']
        self.mapping[img[1]] = self.mapping[img[3]] = (404, b'')
        art = self.open_article(P)
        self.assertEqual(fetch.calls, [A + '?page=2'])
        self.assertEqual(opener.calls, [img[2]])
        self.assertEqual(art['pages'], {'total': 3, 'fetched': 3, 'missing': []})
        self.assertEqual(art['errors'], [])
        self.assertEqual((art['id'], art['url'], art['title']), (ARTICLE_ID, A, '複数ページの見出し'))
        texts = [''.join(t['s'] for s in b.get('sentences', []) + b.get('caption_sentences', []) for t in s['tokens'])
                 for b in art['blocks']]
        self.assertEqual(texts, ['第1頁の本文。', '写真1', '第2頁の本文。', '写真2', '第3頁の本文。', '写真3'])
        ids = [s['id'] for b in art['blocks'] for s in b.get('sentences', []) + b.get('caption_sentences', [])]
        self.assertEqual(ids, list(range(6)))
        images = [b for b in art['blocks'] if b['type'] == 'image']
        self.assertEqual([(b['index'], b['ok']) for b in images], [(0, True), (1, True), (2, True)])
        # Each image names its content, so the page's URL for a shifted index changes too
        # (the browser caches /api/news/image/<id>/<n> for 7 days).
        self.assertEqual([b['key'] for b in images], [image_key(img[n])[:16] for n in (1, 2, 3)])
        self.assertEqual(images[0]['key'], before[0])
        self.assertNotEqual(images[1]['key'], before[1])
        for index, n in ((0, 1), (1, 2), (2, 3)):
            resp = self.request(f'/api/news/image/{ARTICLE_ID}/{index}?v={images[index]["key"]}')
            self.assertEqual((resp.status, resp.read()), (200, data[n]), index)
        self.assertEqual(self.request(f'/api/news/image/{ARTICLE_ID}/3').status, 404)
        self.assertEqual(self.svc.store.load_article(ARTICLE_ID)['blocks'], art['blocks'])
        # Complete now: reused right away, nothing fetched.
        self.assertEqual(self.open_article(P)['blocks'], art['blocks'])
        self.assertEqual(fetch.calls, [A + '?page=2'])

    def test_partial_reopen_retries_failed_images_of_kept_pages(self):
        img = {1: 'https://newsatcl-pctr.c.yimg.jp/t/test/page1.jpg', 2: 'https://newsatcl-pctr.c.yimg.jp/t/test/page2.jpg'}
        mapping = {**article_pages(2, images=img), img[1]: (503, b''), img[2]: (200, PNG)}
        mapping[A + '?page=2'] = (503, b'')
        self.use(mapping)
        self.login()
        first = self.open_article()
        self.assertEqual([e['stage'] for e in first['errors']], ['yahoo', 'image'])
        self.mapping[A + '?page=2'] = article_pages(2, images=img)[A + '?page=2']
        self.mapping[img[1]] = (200, JPEG)
        art = self.open_article()
        self.assertEqual(art['errors'], [])
        self.assertEqual([(b['index'], b['ok']) for b in art['blocks'] if b['type'] == 'image'], [(0, True), (1, True)])
        self.assertEqual(self.request(f'/api/news/image/{ARTICLE_ID}/0').read(), JPEG)
        self.assertEqual(self.request(f'/api/news/image/{ARTICLE_ID}/1').read(), PNG)

    def test_expired_partial_copy_is_fetched_in_full(self):
        mapping = {P: (200, load('pickup')), **article_pages(3)}
        mapping[A + '?page=3'] = (503, b'')
        self.use(mapping)
        self.login()
        self.assertEqual(self.open_article(P)['pages']['missing'], [3])
        self.svc.yahoo._fetch.calls.clear()
        self.mapping[A + '?page=3'] = article_pages(3)[A + '?page=3']
        later = time.time() + 8 * 86400
        self.svc.store.now = lambda: later
        art = self.open_article(P)
        self.assertEqual(self.svc.yahoo._fetch.calls, [P, A, A + '?page=2', A + '?page=3'])
        self.assertEqual(art['pages']['missing'], [])

    def test_damaged_stored_copy_is_fetched_in_full(self):
        self.use(multi(**{A + '?page=3': (503, b'')}))
        self.login()
        self.open_article()
        path = Path(self.config['state']) / 'news' / ARTICLE_ID / 'article.json'
        good = json.loads(path.read_text('utf-8'))
        self.mapping[A + '?page=3'] = (200, load('multi_p3'))
        for damage in ({'images': ['../../settings.json']}, {'source': {**good['cache']['source'], 'page_blocks': [[2, []]]}},
                       {'source': {**good['cache']['source'], 'url': 'https://example.com/x'}}):
            path.write_text(json.dumps(dict(good, cache=dict(good['cache'], **damage))), 'utf-8')
            self.svc.yahoo._fetch.calls.clear()
            art = self.open_article()
            self.assertEqual(self.svc.yahoo._fetch.calls, [A, A + '?page=2', A + '?page=3'], damage)
            self.assertEqual(art['pages']['missing'], [])
            self.svc._recent.clear()

    def test_image_route_still_serves_articles_saved_before_task_13(self):
        self.use()
        self.login()
        self.svc.store.save_article({'id': ARTICLE_ID, 'blocks': [{'type': 'image', 'index': 0, 'ok': True}]})
        self.svc.store.save_image(ARTICLE_ID, 0, JPEG)
        resp = self.request(f'/api/news/image/{ARTICLE_ID}/0')
        self.assertEqual((resp.status, resp.read()), (200, JPEG))

    def test_rejects_non_yahoo_url_before_streaming(self):
        self.use()
        self.login()
        for body in ({'url': 'https://news.yahoo.co.jp.evil.com/articles/abcdef12'}, {'url': 5}, {}):
            err = self.json('/api/news/open', body, status=400)['error']
            self.assertEqual(err['stage'], 'client')
            self.assertFalse(err['retryable'])

    def test_concurrent_opens_fetch_once(self):
        self.use()
        calls = []
        inner = self.svc.yahoo._fetch

        def slow(url):
            calls.append(url)
            time.sleep(0.2)
            return inner(url)
        self.svc.yahoo._fetch = slow
        self.login()
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.open_article())) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual(len(results), 2)
        self.assertEqual(calls.count(A), 1)

    def test_odd_page_shape_becomes_parse_error(self):
        self.use()
        self.login()
        with mock.patch.object(self.svc.yahoo, 'open', side_effect=AttributeError("'list' object has no attribute 'get'")):
            err = self.sse('/api/news/open', {'url': A})[-1]
        self.assertEqual(err[0], 'error')
        self.assertEqual(err[1]['stage'], 'parse')
        self.assertRegex(err[1]['request_id'], r'^n-')

    def test_unexpected_failure_becomes_error_event(self):
        self.use()
        self.login()
        with mock.patch.object(self.svc.store, 'save_article', side_effect=RuntimeError('disk on fire')):
            err = self.sse('/api/news/open', {'url': A})[-1]
        self.assertEqual(err[0], 'error')
        self.assertRegex(err[1]['request_id'], r'^n-')
        self.assertIn(err[1]['request_id'], self.stderr.getvalue())


@unittest.skipUnless(HAVE_FUGASHI, 'fugashi is not installed')
class RealTokenTests(NewsHTTPBase):
    patch_tokens = False

    def test_open_streams_progress_then_article_with_tokens(self):
        self.use({A: (200, load('single'))})
        self.login()
        events = self.sse('/api/news/open', {'url': A})
        self.assertEqual(events[-1][0], 'article')
        self.assertIn('progress', [e for e, _ in events])
        tok = events[-1][1]['blocks'][0]['sentences'][0]['tokens'][0]
        self.assertIn('r', tok)
        self.assertEqual(tok['s'], '単独')


class FeedTests(NewsHTTPBase):
    def test_feeds_fall_back_to_stale_cache(self):
        self.use({RSS: (200, load('rss'))})
        self.login()
        first = self.json('/api/news/feeds?cat=domestic')
        self.assertEqual([i['title'] for i in first['items']], ['見出し一', '見出し二'])
        self.assertIsNone(first['stale_minutes'])
        self.mapping[RSS] = (503, b'')
        self.svc.yahoo._fetch = fake_fetch(self.mapping)
        # Within 10 minutes the cached list is served without fetching.
        self.assertIsNone(self.json('/api/news/feeds?cat=domestic')['stale_minutes'])
        start = time.time()
        self.svc.clock = lambda: start + 12 * 60 + 5
        logged = self.stderr.getvalue()
        stale = self.json('/api/news/feeds?cat=domestic')
        self.assertEqual(len(self.stderr.getvalue().splitlines()) - len(logged.splitlines()), 1)
        self.assertEqual(stale['items'], first['items'])
        self.assertIsInstance(stale['stale_minutes'], int)
        self.assertEqual(stale['stale_minutes'], 12)

    def test_feed_failure_without_cache_and_unknown_category(self):
        self.use({RSS: (503, b'')})
        self.login()
        err = self.json('/api/news/feeds?cat=domestic', status=502)['error']
        self.assertEqual((err['stage'], err['location']), ('yahoo', '新闻列表'))
        self.assertEqual(self.stderr.getvalue().count(err['request_id']), 1)  # logged once
        self.assertEqual(self.json('/api/news/feeds?cat=nope', status=400)['error']['stage'], 'client')
        self.assertEqual(self.json('/api/news/feeds', status=400)['error']['stage'], 'client')


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
        self.open_article()
        err = self.sse('/api/news/analyze', self.analyze_body())[-1]
        self.assertEqual(err[0], 'error')
        self.assertEqual((err[1]['stage'], err[1]['reason'], err[1]['retryable']),
                         ('model', '请先在页头选择模型', False))
        err = self.json('/api/news/gloss', {'lemma': '本', 'reading': 'ほん', 'pos': '名詞'}, status=502)['error']
        self.assertEqual(err['reason'], '请先在页头选择模型')
        self.assertEqual(self.fake.requests, [])

    def test_selected_model_gone_reports_unavailable(self):
        self.use(select='Retired')
        self.login()
        self.open_article()
        err = self.sse('/api/news/analyze', self.analyze_body())[-1][1]
        self.assertEqual((err['stage'], err['reason'], err['retryable']), ('model', '当前模型不可用，请重新选择', False))
        self.assertEqual(self.fake.requests, [])


class AnalyzeTests(NewsHTTPBase):
    def test_analyze_streams_sections_and_links_card(self):
        self.use(script=[('chunks', ANALYSIS, 0)])
        self.login()
        self.open_article()
        # sentence 1 is 動画の前の本文。 ; select 動画 (characters 0..1 with fake tokens)
        events = self.sse('/api/news/analyze', self.analyze_body(1, 0, 1))
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

    def test_analyze_whole_sentence_has_no_selection_and_caption_sentences_work(self):
        self.use(script=[('chunks', ['<translation>图片说明</translation>'], 0)])
        self.login()
        self.open_article()
        events = self.sse('/api/news/analyze', self.analyze_body(3))
        self.assertEqual([n for n, _ in events if n != 'progress'], ['translation', 'done'])
        user = self.fake.requests[0]['messages'][-1]['content']
        self.assertIn('画像：テスト', user)
        self.assertNotIn('选中部分', user)

    def test_analyze_after_article_expired_reports_reopen(self):
        self.use()
        self.login()
        err = self.sse('/api/news/analyze', self.analyze_body(0, article='ab12cd34'))[-1]
        self.assertEqual(err[0], 'error')
        self.assertEqual((err[1]['stage'], err[1]['reason'], err[1]['retryable']),
                         ('parse', '文章缓存已过期，请重新打开', False))
        self.assertRegex(err[1]['request_id'], r'^n-')
        # An article that was saved but has aged past seven days reports the same.
        self.open_article()
        later = time.time() + 8 * 86400
        self.svc.store.now = lambda: later
        err = self.sse('/api/news/analyze', self.analyze_body(0))[-1]
        self.assertEqual((err[0], err[1]['reason']), ('error', '文章缓存已过期，请重新打开'))
        self.assertEqual(self.fake.requests, [])

    def test_unparsable_reply_reports_format_after_raw_text(self):
        self.use(script=[('chunks', ['完全没有标签的回答'], 0)])
        self.login()
        self.open_article()
        events = self.sse('/api/news/analyze', self.analyze_body(0))
        self.assertEqual(events[-2], ('extra', {'text': '完全没有标签的回答'}))
        self.assertEqual(events[-1][1]['stage'], 'format')

    def test_bad_selection_bodies_are_400(self):
        self.use()
        self.login()
        self.open_article()
        bad = [self.analyze_body(1, 0, None), self.analyze_body(1, 2, 1), self.analyze_body(1, -1, 0),
               self.analyze_body(1, 0, 99), self.analyze_body(99), self.analyze_body('1'),
               self.analyze_body(1, True, True), self.analyze_body(article='../x')]
        for body in bad:
            err = self.json('/api/news/analyze', body, status=400)['error']
            self.assertEqual(err['stage'], 'client', body)
        ask = {**self.analyze_body(1), 'analysis': '', 'history': [], 'question': 'x' * 501}
        self.assertEqual(self.json('/api/news/ask', ask, status=400)['error']['stage'], 'client')
        for history in ([{'q': 'a'}], [{'q': 1, 'a': 'b'}], 'no', [None]):
            body = {**ask, 'question': '为什么？', 'history': history}
            self.assertEqual(self.json('/api/news/ask', body, status=400)['error']['stage'], 'client', history)
        self.assertEqual(self.fake.requests, [])


class AskTests(NewsHTTPBase):
    def ask_body(self, question='为什么用这个形式？', history=None):
        return {**self.analyze_body(1, 0, 1), 'analysis': '<translation>x</translation>',
                'history': history or [], 'question': question}

    def test_ask_streams_deltas_and_sends_last_six_rounds(self):
        self.use(script=[('chunks', ['因为', '是持续。'], 0)])
        self.login()
        self.open_article()
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
        self.open_article()
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
        self.open_article()
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
        self.open_article()
        events = self.sse('/api/news/analyze', self.analyze_body(1))
        self.assertEqual(events[-1], ('done', {'analysis_text': ''.join(ANALYSIS)}), events)
        self.assertNotIn('思考', json.dumps(events, ensure_ascii=False))

    def test_ask_after_thinking_sends_no_empty_deltas(self):
        self.use(script=[('reasoning', 0.8, ['因为', '是持续。'])])
        self.login()
        self.open_article()
        body = {**self.analyze_body(1, 0, 1), 'analysis': '', 'history': [], 'question': '为什么？'}
        events = self.sse('/api/news/ask', body)
        self.assertEqual([(n, d) for n, d in events if n != 'progress'],
                         [('delta', {'text': '因为'}), ('delta', {'text': '是持续。'}), ('done', {})])

    def test_client_gone_while_model_thinks_is_noticed_and_frees_the_slot(self):
        self.use(script=[('reasoning', 10, ['never']), ('chunks', ANALYSIS, 0)],
                 first_timeout=5, total_timeout=20)
        self.svc.slots = threading.BoundedSemaphore(1)  # a leaked slot would queue the next request
        self.login()
        self.open_article()
        sock = socket.create_connection(('127.0.0.1', self.port), timeout=10)
        body = json.dumps(self.analyze_body(1)).encode()
        sock.sendall(('POST /api/news/analyze HTTP/1.1\r\nHost: x\r\nOrigin: %s\r\nCookie: %s\r\n'
                      'Content-Type: application/json\r\nContent-Length: %d\r\n\r\n'
                      % (ORIGIN, self.cookie, len(body))).encode() + body)
        self.assertTrue(self.fake.wait_requests(1))
        time.sleep(0.3)  # the model is thinking
        sock.close()
        self.assertTrue(self.fake.wait_disconnect(timeout=3))
        events = self.sse('/api/news/analyze', self.analyze_body(1))
        self.assertEqual(events[-1][0], 'done', events)
        self.assertNotIn(('progress', {'stage': 'model', 'text': '排队中…'}), events)


class StageErrorTests(NewsHTTPBase):
    def stage_of_open(self, mapping, url=A):
        self.use(mapping)
        self.login()
        return self.sse('/api/news/open', {'url': url})[-1]

    def test_every_stage_error_has_request_id_and_location(self):
        self.login()
        errors = []

        # Yahoo 503 on page 3: the article opens and records the page error.
        self.use(multi(**{A + '?page=3': (503, b'')}))
        errors.append(('yahoo', self.open_article(P)['errors'][0]))
        # The cases below open the same article afresh, not as a refill of this partial copy.
        shutil.rmtree(Path(self.config['state']) / 'news' / ARTICLE_ID)
        # Yahoo times out on the first page: the whole open fails.
        self.use({A: TimeoutError('timed out')})
        errors.append(('yahoo', self.sse('/api/news/open', {'url': A})[-1][1]))
        # Tokenizer missing.
        self.use()
        with mock.patch('server.news.to_sentences', side_effect=TokenizerUnavailable('ImportError: fugashi')):
            errors.append(('tokenize', self.sse('/api/news/open', {'url': A})[-1][1]))
        # Image download failed.
        self.use({A: (200, load('video')), IMG: TimeoutError('timed out'), POSTER: (200, PNG)})
        errors.append(('image', self.open_article()['errors'][0]))

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
            self.open_article()
            errors.append((stage, self.sse('/api/news/analyze', self.analyze_body(1))[-1][1]))
        # qoder2api-hub stopped.
        self.use()
        self.open_article()
        self.fake.close()
        errors.append(('gateway', self.sse('/api/news/analyze', self.analyze_body(1))[-1][1]))

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
        line = next(l for l in log.splitlines() if errors[1][1]['request_id'] in l)
        self.assertIn('yahoo', line)
        self.assertIn(A, line)

    def test_tokenize_unavailable_via_real_splitter(self):
        self.use()
        self.login()
        # The real splitter with a tokenizer that reports the component missing.
        from server import news_text
        with mock.patch('server.news.to_sentences', news_text.to_sentences), \
                mock.patch('server.news_text.tokenize', side_effect=TokenizerUnavailable('ImportError')):
            err = self.sse('/api/news/open', {'url': A})[-1]
        self.assertEqual((err[0], err[1]['stage'], err[1]['retryable']), ('error', 'tokenize', False))


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

    def test_construction_cleans_up_once_and_does_no_network(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch('server.news.NewsStore.cleanup') as cleanup, \
                mock.patch('server.news_yahoo.http_fetch', side_effect=AssertionError('network')):
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
