"""CORS, the login-free news endpoints and the public loader of the news userscript."""
import http.client
import json
import re
import unittest
from pathlib import Path

from tests.server import test_news_http as base

ORIGIN = base.ORIGIN
SITE = 'https://news.example'
EVIL = 'https://evil.example'
CORS = ('Access-Control-Allow-Origin', 'Vary', 'Access-Control-Allow-Headers',
        'Access-Control-Allow-Methods', 'Access-Control-Max-Age')
SITES = [{'name': '测试新闻', 'origin': SITE, 'match': SITE + '/a/*', 'path': '^/a/[0-9]+$', 'parts': ['h1']}]
LOADER = '/api/news/loader.user.js'


class AccessTests(base.NewsHTTPBase):
    def setUp(self):
        super().setUp()
        self.config['news_sites'] = SITES
        self.use()

    # -- helpers -------------------------------------------------------------
    def call(self, method, path, headers=None, data=None, cookie=True):
        hdrs = dict(headers or {})
        if cookie and self.cookie:
            hdrs['Cookie'] = self.cookie
        body = None
        if data is not None:
            body = json.dumps(data).encode()
            hdrs.setdefault('Content-Type', 'application/json')
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        self.addCleanup(conn.close)
        conn.request(method, path, body, hdrs)
        response = conn.getresponse()
        raw = response.read()
        return response.status, response, raw

    # -- tests ---------------------------------------------------------------
    def test_preflight_allows_only_listed_origins(self):
        status, response, raw = self.call('OPTIONS', '/api/news/analyze', {
            'Origin': SITE, 'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization, content-type'}, cookie=False)
        self.assertEqual(status, 204, raw)
        self.assertEqual(raw, b'')
        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), SITE)
        self.assertEqual(response.getheader('Vary'), 'Origin')
        # Loaders installed before tokens were dropped still send Authorization; the preflight must pass.
        self.assertEqual(response.getheader('Access-Control-Allow-Headers'), 'Authorization, Content-Type')
        self.assertEqual(response.getheader('Access-Control-Allow-Methods'), 'GET, POST')
        self.assertEqual(response.getheader('Access-Control-Max-Age'), '600')
        self.assertIsNone(response.getheader('Access-Control-Allow-Credentials'))
        for origin in (EVIL, SITE + '.evil.example', SITE + '/', 'http://news.example'):
            status, response, _raw = self.call('OPTIONS', '/api/news/analyze', {'Origin': origin}, cookie=False)
            self.assertEqual(status, 403, origin)
            for name in CORS:
                self.assertIsNone(response.getheader(name), (origin, name))
        status, response, _raw = self.call('OPTIONS', '/api/news/analyze', cookie=False)
        self.assertEqual(status, 403)
        self.assertIsNone(response.getheader('Access-Control-Allow-Origin'))

    def test_listed_origin_needs_no_login_and_gets_cors_headers(self):
        status, response, raw = self.call('GET', '/api/news/models', {'Origin': SITE}, cookie=False)
        self.assertEqual(status, 200, raw)
        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), SITE)
        self.assertEqual(response.getheader('Vary'), 'Origin')
        self.assertIsNone(response.getheader('Access-Control-Allow-Credentials'))
        status, response, raw = self.call('POST', '/api/news/settings', {'Origin': SITE},
                                          {'model': 'DeepSeek-Flash'}, cookie=False)
        self.assertEqual(status, 200, raw)
        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), SITE)
        self.assertEqual(json.loads(raw), {'selected': 'DeepSeek-Flash'})

    def test_an_authorization_header_from_an_old_loader_is_ignored(self):
        status, _response, raw = self.call('GET', '/api/news/models', {'Origin': SITE, 'Authorization': 'Bearer old'},
                                           cookie=False)
        self.assertEqual(status, 200, raw)
        status, _response, _raw = self.call('GET', '/api/news/models', {'Authorization': 'Bearer old'}, cookie=False)
        self.assertEqual(status, 401)  # a bearer header is not a login

    def test_other_origins_and_other_paths_still_need_login(self):
        for origin in (EVIL, SITE + '.evil.example'):
            status, response, _raw = self.call('POST', '/api/news/settings', {'Origin': origin},
                                               {'model': 'DeepSeek-Flash'}, cookie=False)
            self.assertEqual(status, 403, origin)
            self.assertIsNone(response.getheader('Access-Control-Allow-Origin'))
            status, response, _raw = self.call('GET', '/api/news/models', {'Origin': origin}, cookie=False)
            self.assertEqual(status, 401, origin)
            self.assertIsNone(response.getheader('Access-Control-Allow-Origin'))
        self.assertEqual(self.call('GET', '/api/news/models', cookie=False)[0], 401)
        self.assertEqual(self.call('POST', '/api/news/settings', {}, {'model': 'DeepSeek-Flash'}, cookie=False)[0], 403)
        # A listed origin is not enough outside /api/news/.
        status, _response, _raw = self.call('POST', '/api/review/spaced/submit', {'Origin': SITE}, {'units': []},
                                            cookie=False)
        self.assertEqual(status, 403)
        status, _response, _raw = self.call('GET', '/api/review/spaced', {'Origin': SITE}, cookie=False)
        self.assertEqual(status, 401)

    def test_a_logged_in_browser_still_works_on_the_site_itself(self):
        self.login()
        status, _response, raw = self.call('GET', '/api/news/models')
        self.assertEqual(status, 200, raw)
        status, _response, _raw = self.call('POST', '/api/news/settings', {'Origin': ORIGIN}, {'model': 'DeepSeek-Flash'})
        self.assertEqual(status, 200)
        status, _response, _raw = self.call('POST', '/api/news/settings', {'Origin': EVIL}, {'model': 'DeepSeek-Flash'})
        self.assertEqual(status, 403)

    def test_loader_is_public_and_the_same_for_everyone(self):
        from server.news_sites import LOADER_VERSION, loader_script
        status, response, raw = self.call('GET', LOADER, cookie=False)
        self.assertEqual(status, 200, raw)
        self.assertEqual(response.getheader('Content-Type'), 'text/javascript; charset=utf-8')
        self.assertEqual(response.getheader('Cache-Control'), 'no-store')
        self.assertEqual(response.getheader('Content-Disposition'),
                         f'attachment; filename="jlpt-news-v{LOADER_VERSION}.user.js"')
        script = raw.decode('utf-8')
        self.assertIn('// @updateURL    ' + ORIGIN + LOADER, script)
        self.assertIn('// @downloadURL  ' + ORIGIN + LOADER, script)
        self.assertIn('// @match        ' + SITE + '/a/*', script)
        self.assertNotIn('token', script.lower())
        self.login()
        self.assertEqual(self.call('GET', LOADER)[2], raw)
        self.assertEqual(self.call('HEAD', LOADER, cookie=False)[0], 200)
        # The site's own text for this exact script is what make_news_loader.py writes.
        self.assertEqual(script, loader_script(ORIGIN, SITES, debug=True))

    def test_loader_debug_overlay_follows_news_debug(self):
        _status, _response, raw = self.call('GET', LOADER, cookie=False)
        self.assertIn('"debug": true', raw.decode())
        self.assertIn("'jlpt-news-debug'", raw.decode())
        self.config['news_debug'] = False
        _status, _response, raw = self.call('GET', LOADER, cookie=False)
        self.assertIn('"debug": false', raw.decode())
        self.assertNotIn('jlpt-news-debug', raw.decode())

    def test_startup_refuses_a_news_debug_that_is_not_a_boolean(self):
        for bad in ('false', 0, None):
            with self.subTest(value=bad):
                with self.assertRaisesRegex(ValueError, 'news_debug'):
                    base.Application({**self.config, 'news_debug': bad})
        base.Application({**self.config, 'news_debug': False})

    def test_startup_refuses_a_news_online_update_that_is_not_a_boolean(self):
        for bad in ('false', 0, None):
            with self.subTest(value=bad):
                with self.assertRaisesRegex(ValueError, 'news_online_update'):
                    base.Application({**self.config, 'news_online_update': bad})
        base.Application({**self.config, 'news_online_update': False})

    def test_online_update_off_closes_the_loader_and_the_main_script(self):
        built = Path(self.config['static']) / 'news-script'
        built.mkdir()
        (built / 'client.js').write_text('1;', encoding='utf-8')
        self.config['news_online_update'] = False
        self.assertEqual(self.call('GET', LOADER, cookie=False)[0], 404)
        self.assertEqual(self.call('GET', '/api/news/client.js', {'Origin': SITE}, cookie=False)[0], 404)
        self.assertEqual(self.call('GET', '/api/news/models', {'Origin': SITE}, cookie=False)[0], 200)
        self.config['news_online_update'] = True
        self.assertEqual(self.call('GET', LOADER, cookie=False)[0], 200)
        self.assertEqual(self.call('GET', '/api/news/client.js', {'Origin': SITE}, cookie=False)[0], 200)

    def test_the_token_and_device_endpoints_are_gone(self):
        self.login()
        for method, path in (('GET', '/api/news/install/iPad/jlpt-news.user.js'), ('GET', '/api/news/devices'),
                             ('POST', '/api/news/devices/revoke')):
            headers = {'Origin': ORIGIN} if method == 'POST' else {}
            status, _response, raw = self.call(method, path, headers, {'id': 'x'} if method == 'POST' else None)
            self.assertEqual(status, 404, (path, raw))
        self.assertFalse((Path(self.config['state']) / 'news' / 'devices.json').exists())

    def test_client_js_needs_a_listed_origin_or_login_and_reports_unbuilt(self):
        self.assertEqual(self.call('GET', '/api/news/client.js', cookie=False)[0], 401)
        status, response, raw = self.call('GET', '/api/news/client.js', {'Origin': SITE}, cookie=False)
        self.assertEqual(status, 503, raw)
        self.assertEqual(json.loads(raw), {'error': '主脚本未构建'})
        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), SITE)
        built = Path(self.config['static']) / 'news-script'
        built.mkdir()
        code = 'console.log("客户端");\n'
        (built / 'client.js').write_text(code, encoding='utf-8')
        self.login()
        for headers, cookie in (({'Origin': SITE}, False), ({}, True)):
            status, response, raw = self.call('GET', '/api/news/client.js', headers, cookie=cookie)
            self.assertEqual(status, 200, raw)
            self.assertEqual(response.getheader('Content-Type'), 'text/javascript; charset=utf-8')
            self.assertEqual(raw.decode('utf-8'), code)

    def test_streams_carry_cors_headers_for_listed_origin_requests(self):
        self.use(script=[('chunks', ['<translation>x</translation>'], 0)])
        status, response, raw = self.call('POST', '/api/news/analyze', {'Origin': SITE}, self.analyze_body(), cookie=False)
        self.assertEqual(status, 200, raw)
        self.assertEqual(response.getheader('Content-Type'), 'text/event-stream')
        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), SITE)
        self.assertEqual(response.getheader('Vary'), 'Origin')
        self.assertIn(b'event: done', raw)


if __name__ == '__main__':
    unittest.main()
