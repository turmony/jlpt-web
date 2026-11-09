"""Bearer tokens, CORS and the device endpoints for the news userscript."""
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
INSTALL = '/api/news/install/%s/jlpt-news.user.js'


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

    def bearer(self, token, **extra):
        return dict({'Authorization': 'Bearer ' + token}, **extra)

    def install(self, name='iPad', query=''):
        status, response, raw = self.call('GET', INSTALL % name + query)
        self.assertEqual(status, 200, raw)
        return response, raw.decode('utf-8')

    def install_token(self, name='iPad'):
        _response, script = self.install(name)
        return re.search(r'"token": "([^"]+)"', script).group(1)

    def token_status(self, token, path='/api/news/models'):
        return self.call('GET', path, self.bearer(token), cookie=False)[0]

    # -- tests ---------------------------------------------------------------
    def test_preflight_allows_only_listed_origins(self):
        status, response, raw = self.call('OPTIONS', '/api/news/analyze', {
            'Origin': SITE, 'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization, content-type'}, cookie=False)
        self.assertEqual(status, 204, raw)
        self.assertEqual(raw, b'')
        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), SITE)
        self.assertEqual(response.getheader('Vary'), 'Origin')
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

    def test_token_post_from_listed_origin_is_allowed(self):
        self.login()
        token = self.install_token()
        status, response, raw = self.call('POST', '/api/news/settings', self.bearer(token, Origin=SITE),
                                          {'model': 'DeepSeek-Flash'}, cookie=False)
        self.assertEqual(status, 200, raw)
        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), SITE)
        self.assertEqual(response.getheader('Vary'), 'Origin')
        self.assertIsNone(response.getheader('Access-Control-Allow-Credentials'))
        self.assertEqual(json.loads(raw), {'selected': 'DeepSeek-Flash'})

    def test_cookie_only_post_from_listed_origin_is_refused(self):
        self.login()
        status, _response, raw = self.call('POST', '/api/news/settings', {'Origin': SITE},
                                           {'model': 'DeepSeek-Flash'})
        self.assertEqual(status, 403, raw)
        self.assertEqual(self.app.news.store.settings().get('model'), 'DeepSeek-Flash')

    def test_token_post_from_unlisted_origin_is_refused(self):
        self.login()
        token = self.install_token()
        for origin in (EVIL, SITE + '.evil.example'):
            status, response, _raw = self.call('POST', '/api/news/settings', self.bearer(token, Origin=origin),
                                               {'model': 'DeepSeek-Flash'}, cookie=False)
            self.assertEqual(status, 403, origin)
            self.assertIsNone(response.getheader('Access-Control-Allow-Origin'))
        # A listed origin is not enough outside /api/news/.
        status, _response, _raw = self.call('POST', '/api/review/spaced/submit', self.bearer(token, Origin=SITE),
                                            {'units': []}, cookie=False)
        self.assertEqual(status, 403)

    def test_bad_token_is_401_with_install_link_and_cors(self):
        self.login()
        for method, data in (('GET', None), ('POST', {'model': 'DeepSeek-Flash'})):
            status, response, raw = self.call(
                method, '/api/news/models' if method == 'GET' else '/api/news/settings',
                {'Authorization': 'Bearer nonsense', 'Origin': SITE}, data)  # a valid cookie is sent too
            self.assertEqual(status, 401, (method, raw))
            error = json.loads(raw)['error']
            self.assertEqual(error['stage'], 'client')
            self.assertEqual(error['reason'], '令牌已失效，请重新安装脚本')
            self.assertIs(error['retryable'], False)
            self.assertEqual(error['install'], ORIGIN + '/news-script/')
            self.assertTrue(error['install'].endswith('/news-script/'))
            self.assertEqual(response.getheader('Access-Control-Allow-Origin'), SITE)
        for header in ('Bearer ', 'Basic abc', 'nonsense'):
            status, _response, _raw = self.call('GET', '/api/news/models', {'Authorization': header})
            self.assertEqual(status, 401, header)

    def test_token_cannot_manage_devices(self):
        self.login()
        token = self.install_token()
        for method, path, data in (('GET', INSTALL % 'Phone', None), ('GET', '/api/news/devices', None),
                                   ('POST', '/api/news/devices/revoke', {'id': 'x'})):
            for origin in (SITE, ORIGIN):
                headers = self.bearer(token, Origin=origin) if method == 'POST' else self.bearer(token)
                status, _response, raw = self.call(method, path, headers, data, cookie=False)
                self.assertEqual(status, 403, (path, origin, raw))
                self.assertEqual(json.loads(raw), {'error': '令牌不能管理设备'})
        self.assertEqual(len(self.app.news.devices.list()), 1)

    def test_install_needs_login_and_returns_loader(self):
        status, _response, _raw = self.call('GET', INSTALL % 'iPad')
        self.assertEqual(status, 401)
        self.login()
        response, script = self.install()
        self.assertEqual(response.getheader('Content-Type'), 'text/javascript; charset=utf-8')
        self.assertEqual(response.getheader('Cache-Control'), 'no-store')
        self.assertIsNone(response.getheader('Content-Disposition'))
        self.assertIn('@match', script)
        self.assertIn(SITE + '/a/*', script)
        self.assertIn(ORIGIN, script)
        token = re.search(r'"token": "([^"]+)"', script).group(1)
        status, _response, raw = self.call('GET', '/api/news/models', self.bearer(token), cookie=False)
        self.assertEqual(status, 200, raw)
        self.assertEqual(json.loads(raw)['selected'], 'DeepSeek-Flash')

    def test_install_download_is_an_attachment(self):
        self.login()
        plain, script = self.install()
        first = re.search(r'"token": "([^"]+)"', script).group(1)
        download, script = self.install(query='?download=1')
        second = re.search(r'"token": "([^"]+)"', script).group(1)
        self.assertEqual(download.getheader('Content-Disposition'), 'attachment; filename="jlpt-news.user.js"')
        self.assertEqual(download.getheader('Content-Type'), 'text/javascript; charset=utf-8')
        self.assertIsNone(plain.getheader('Content-Disposition'))
        self.assertNotEqual(first, second)
        self.assertEqual(self.token_status(first), 401)
        self.assertEqual(self.token_status(second), 200)
        self.assertEqual(len(self.app.news.devices.list()), 1)

    def test_install_name_rules(self):
        self.login()
        for name in ('a%2Fb', '%20%20', 'x' * 21, '%FF%FE', '%00x'):
            status, _response, raw = self.call('GET', INSTALL % name)
            self.assertEqual(status, 400, (name, raw))
            self.assertIsInstance(json.loads(raw)['error'], str)
        for name in ('%E6%97%A5%E6%9C%AC', '%F0%9F%93%B1', 'x' * 20):
            status, _response, raw = self.call('GET', INSTALL % name)
            self.assertEqual(status, 200, (name, raw))
        names = [d['name'] for d in self.app.news.devices.list()]
        self.assertEqual(names, ['日本', '📱', 'x' * 20])

    def test_install_refuses_the_eleventh_device(self):
        self.login()
        for i in range(10):
            self.install('d%d' % i)
        status, _response, raw = self.call('GET', INSTALL % 'one-too-many')
        self.assertEqual(status, 400, raw)
        self.assertIn('10', json.loads(raw)['error'])

    def test_devices_list_and_revoke(self):
        self.login()
        ipad, phone = self.install_token('iPad'), self.install_token('iPhone')
        status, _response, raw = self.call('GET', '/api/news/devices')
        self.assertEqual(status, 200, raw)
        devices = json.loads(raw)['devices']
        self.assertEqual([d['name'] for d in devices], ['iPad', 'iPhone'])
        for device in devices:
            self.assertEqual(set(device), {'id', 'name', 'installed', 'last_used'})
        self.assertNotIn(ipad, raw.decode())
        self.assertNotIn(phone, raw.decode())
        status, _response, raw = self.call('POST', '/api/news/devices/revoke', {'Origin': ORIGIN}, {'id': devices[0]['id']})
        self.assertEqual((status, json.loads(raw)), (200, {'ok': True}))
        self.assertEqual(self.token_status(ipad), 401)
        self.assertEqual(self.token_status(phone), 200)
        status, _response, _raw = self.call('POST', '/api/news/devices/revoke', {'Origin': ORIGIN}, {'id': devices[0]['id']})
        self.assertEqual(status, 404)
        status, _response, _raw = self.call('POST', '/api/news/devices/revoke', {'Origin': ORIGIN}, {'id': 'nope'})
        self.assertEqual(status, 404)
        status, _response, _raw = self.call('POST', '/api/news/devices/revoke', {'Origin': EVIL}, {'id': devices[1]['id']})
        self.assertEqual(status, 403)
        status, _response, _raw = self.call('POST', '/api/news/devices/revoke', {'Origin': SITE}, {'id': devices[1]['id']})
        self.assertEqual(status, 403)
        self.assertEqual(self.token_status(phone), 200)
        status, _response, _raw = self.call('POST', '/api/news/devices/revoke', {'Origin': ORIGIN}, {'id': 5})
        self.assertEqual(status, 400)
        status, _response, _raw = self.call('GET', '/api/news/devices', cookie=False)
        self.assertEqual(status, 401)

    def test_client_js_needs_auth_and_reports_unbuilt(self):
        status, _response, _raw = self.call('GET', '/api/news/client.js', cookie=False)
        self.assertEqual(status, 401)
        self.login()
        token = self.install_token()
        status, response, raw = self.call('GET', '/api/news/client.js', self.bearer(token, Origin=SITE), cookie=False)
        self.assertEqual(status, 503, raw)
        self.assertEqual(json.loads(raw), {'error': '主脚本未构建'})
        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), SITE)
        built = Path(self.config['static']) / 'news-script'
        built.mkdir()
        code = 'console.log("客户端");\n'
        (built / 'client.js').write_text(code, encoding='utf-8')
        for headers, cookie in ((self.bearer(token, Origin=SITE), False), ({}, True)):
            status, response, raw = self.call('GET', '/api/news/client.js', headers, cookie=cookie)
            self.assertEqual(status, 200, raw)
            self.assertEqual(response.getheader('Content-Type'), 'text/javascript; charset=utf-8')
            self.assertEqual(raw.decode('utf-8'), code)
        self.assertEqual(self.call('GET', '/api/news/client.js', self.bearer('bad'), cookie=False)[0], 401)

    def test_streams_carry_cors_headers_for_token_requests(self):
        self.use(script=[('chunks', ['<translation>x</translation>'], 0)])
        self.login()
        token = self.install_token()
        status, response, raw = self.call('POST', '/api/news/analyze', self.bearer(token, Origin=SITE),
                                          self.analyze_body(), cookie=False)
        self.assertEqual(status, 200, raw)
        self.assertEqual(response.getheader('Content-Type'), 'text/event-stream')
        self.assertEqual(response.getheader('Access-Control-Allow-Origin'), SITE)
        self.assertEqual(response.getheader('Vary'), 'Origin')
        self.assertIn(b'event: done', raw)

    def test_logs_never_contain_the_token(self):
        self.login()
        good = self.install_token()
        bad = 'bad-token-' + 'z' * 30
        self.assertEqual(self.token_status(bad), 401)
        self.assertEqual(self.token_status(good), 200)
        self.assertEqual(self.token_status(good, '/api/news/client.js'), 503)
        (Path(self.config['state']) / 'news' / 'devices.json').write_text('{"devices": [', encoding='utf-8')
        self.assertEqual(self.token_status(good), 401)  # unreadable device list: fail closed
        news_dir = Path(self.config['state']) / 'news'
        self.assertEqual(len(list(news_dir.glob('devices.json.corrupt-*'))), 1)
        fresh = self.install_token('iPhone')  # and the device can simply be reinstalled
        self.assertEqual(self.token_status(fresh), 200)
        self.assertEqual(self.token_status(good), 401)
        logged = self.stderr.getvalue()
        self.assertIn('令牌已失效', logged)
        for secret in (good, bad, 'Bearer'):
            self.assertNotIn(secret, logged)


if __name__ == '__main__':
    unittest.main()
