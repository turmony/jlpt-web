import copy
import hashlib
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from server import news_sites
from server.news_sites import DEFAULT_SITES, LOADER_VERSION, allowed_origins, debug_enabled, loader_script, online_update_enabled, sites

# SHA-256 of the loader template (header, body and both overlay variants, placeholders unfilled) per version.
KNOWN_LOADERS = {2: '19e433483d126383af0f7af072df19ee6051eaaba533980b72461a385b23bc0d',
                 3: 'acdd610b9232cd8d05e05ddea98a4fc59273e8fbb007eab7378a6e3debb5899c',
                 # v4 only adds the Asahi sites: the generated @match lines changed, the template did not.
                 4: 'acdd610b9232cd8d05e05ddea98a4fc59273e8fbb007eab7378a6e3debb5899c',
                 # v5 only adds Yahoo Expert (/expert/articles/*): template unchanged.
                 5: 'acdd610b9232cd8d05e05ddea98a4fc59273e8fbb007eab7378a6e3debb5899c'}


def site(**changes):
    entry = copy.deepcopy(DEFAULT_SITES[0])
    entry.update(changes)
    return entry


class SitesTests(unittest.TestCase):
    def test_default_sites_and_allowed_origins(self):
        self.assertEqual(sites({}), DEFAULT_SITES)
        self.assertEqual(allowed_origins({}), {'https://news.yahoo.co.jp', 'https://www.asahi.com'})

    def test_config_sites_override_and_bad_entries_are_refused(self):
        other = site(name='NHK', origin='http://example.jp:8080', match='http://example.jp:8080/n/*')
        self.assertEqual(sites({'news_sites': [other]}), [other])
        self.assertEqual(allowed_origins({'news_sites': [other]}), {'http://example.jp:8080'})
        no_parts = site()
        del no_parts['parts']
        for bad in (
            no_parts,
            site(origin='https://news.yahoo.co.jp/articles'),
            site(origin='https://news.yahoo.co.jp?x=1'),
            site(origin='ftp://news.yahoo.co.jp'),
            site(path='^/articles/(['),
            site(parts=[]),
            site(parts=['h1', 3]),
            site(name=''),
        ):
            with self.assertRaises(ValueError, msg=bad):
                sites({'news_sites': [bad]})

    def test_wrap_is_optional_and_must_be_load_or_parsed(self):
        for good in ('load', 'parsed'):
            self.assertEqual(sites({'news_sites': [site(wrap=good)]})[0]['wrap'], good)
        self.assertNotIn('wrap', sites({'news_sites': [site()]})[0])
        for bad in ('', 'ready', 'Parsed', None, True, 1):
            with self.subTest(wrap=bad):
                with self.assertRaisesRegex(ValueError, 'wrap'):
                    sites({'news_sites': [site(wrap=bad)]})

    def test_asahi_sites_cover_both_editions_and_only_article_pages(self):
        asahi = [entry for entry in DEFAULT_SITES if entry['origin'] == 'https://www.asahi.com']
        self.assertEqual({entry['match'] for entry in asahi},
                         {'https://www.asahi.com/sp/articles/*', 'https://www.asahi.com/articles/*'})
        rx = [re.compile(entry['path']) for entry in asahi]
        for path in ('/articles/ASVC9368KVC9UTIL01KM.html', '/sp/articles/ASVC9368KVC9UTIL01KM.html'):
            self.assertEqual(sum(bool(r.search(path)) for r in rx), 1, path)
        for path in ('/articles/', '/articles/ASVC9368KVC9UTIL01KM.html/x', '/sp/', '/articles/ASVC9368KVC9UTIL01KM',
                     '/aj/articles/ASVC9368KVC9UTIL01KM.html'):
            self.assertFalse(any(r.search(path) for r in rx), path)
        for entry in asahi:
            self.assertEqual(entry['wrap'], 'parsed')
            self.assertEqual(entry['parts'], ['main#main h1', 'main#main div:has(> p):not(h1 ~ div *)'])
        self.assertEqual(sites({}), DEFAULT_SITES)  # every default entry passes the same checks as a configured one
        sites({'news_sites': DEFAULT_SITES})

    def test_origin_must_be_exactly_scheme_host_and_port(self):
        for good in ('https://a.com', 'http://a.com', 'https://a.com:8443', 'http://127.0.0.1:1',
                     'http://a.com:65535'):
            with self.subTest(origin=good):
                self.assertEqual(allowed_origins({'news_sites': [site(origin=good)]}), {good})
        for bad in ('https://a.com\n', 'https://a.com ', ' https://a.com', 'https://a.com/', 'https://a.com/x',
                    'https://a.com?x=1', 'https://a.com:65536', 'https://a.com:99999', 'https://a.com:0',
                    'https://a.com:', 'https://a.com:8443\n'):
            with self.subTest(origin=bad):
                with self.assertRaises(ValueError):
                    sites({'news_sites': [site(origin=bad)]})

    def test_default_path_rejects_image_and_comment_pages(self):
        rx = re.compile(DEFAULT_SITES[0]['path'])
        self.assertTrue(rx.search('/articles/bd93f19234247d18f21aadb475e5de44c0e759b3'))
        self.assertFalse(rx.search('/articles/bd93f19234247d18f21aadb475e5de44c0e759b3/images/000'))
        self.assertFalse(rx.search('/articles/bd93f19234247d18f21aadb475e5de44c0e759b3/comments'))

    def test_yahoo_expert_site_covers_expert_articles_and_rejects_other_paths(self):
        expert = [entry for entry in DEFAULT_SITES if entry['match'] == 'https://news.yahoo.co.jp/expert/articles/*']
        self.assertEqual(len(expert), 1)
        entry = expert[0]
        self.assertEqual(entry['origin'], 'https://news.yahoo.co.jp')
        self.assertEqual(entry['parts'], ['#uamods-article h1', '#uamods-article section'])
        rx = re.compile(entry['path'])
        self.assertTrue(rx.search('/expert/articles/8f49b78c4f0f09f06dfef2de41d26e6b88bbb9ef'))
        for other in (
            '/articles/8f49b78c4f0f09f06dfef2de41d26e6b88bbb9ef',
            '/expert/articles/',
            '/expert/articles/8f49b78c4f0f09f06dfef2de41d26e6b88bbb9ef/comments',
            '/expert/articles/8f49b78c4f0f09f06dfef2de41d26e6b88bbb9ef/images/000',
        ):
            self.assertFalse(rx.search(other), other)

    def test_loader_has_metadata_matches_and_config(self):
        second = site(name='NHK', origin='https://www3.nhk.or.jp', match='https://www3.nhk.or.jp/news/*')
        text = loader_script('https://jlpt.example', [DEFAULT_SITES[0], second])
        self.assertTrue(text.startswith('// ==UserScript==\n'))
        self.assertIn(f'\n// @name         JLPT 新闻查词 v{LOADER_VERSION}\n', text)
        self.assertIn(f'\n// @version      {LOADER_VERSION}\n', text)
        self.assertIn(f'加载器已运行 v{LOADER_VERSION} 页面 ', text)
        self.assertNotIn('@VERSION@', text)
        self.assertIn('// @namespace    https://jlpt.example', text)
        self.assertIn('// @match        https://news.yahoo.co.jp/articles/*', text)
        self.assertIn('// @match        https://www3.nhk.or.jp/news/*', text)
        self.assertIn('// @run-at       document-start', text)
        self.assertIn('// @inject-into  content', text)
        self.assertIn('// @noframes', text)
        self.assertIn('// ==/UserScript==', text)
        self.assertIn('// @updateURL    https://jlpt.example/api/news/loader.user.js\n', text)
        self.assertIn('// @downloadURL  https://jlpt.example/api/news/loader.user.js\n', text)
        self.assertNotIn('token', text.lower())
        self.assertNotIn('Authorization', text)
        self.assertIn('/api/news/client.js', text)
        self.assertNotIn('/news-script/', text)
        for words in ('加载主脚本失败：', '服务器返回 ', '网络连接失败'):
            self.assertIn(words, text)

    def test_loader_escapes_script_end(self):
        evil = site(name='</script>\n// @match evil', match='https://news.yahoo.co.jp/a\n// @grant GM_xmlhttpRequest')
        text = loader_script('https://jlpt.example', [evil])
        self.assertNotIn('</script>', text.lower())
        head = text.split('// ==/UserScript==')[0]
        for line in head.splitlines():
            self.assertTrue(line.startswith('//'), line)
        self.assertNotIn('\n// @grant', text)

    def test_loader_is_valid_javascript(self):
        for name, debug in (('雅虎新闻', True), ('</script>', True), ('@DEBUG@', True), ('雅虎新闻', False)):
            text = loader_script('https://jlpt.example', [site(name=name)], debug=debug)
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'loader.user.js'
                path.write_text(text, encoding='utf-8')
                done = subprocess.run(['node', '--check', str(path)], capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)

    def test_debug_switch_controls_the_overlay_and_config(self):
        on = loader_script('https://jlpt.example', [DEFAULT_SITES[0]])
        off = loader_script('https://jlpt.example', [DEFAULT_SITES[0]], debug=False)
        self.assertIs(config_of(on)['debug'], True)
        self.assertIs(config_of(off)['debug'], False)
        for marker in ("'jlpt-news-debug'", "mode: 'open'", 'JLPT 调试', '2147483647', 'safe-area-inset-top'):
            self.assertIn(marker, on)
        for marker in ('jlpt-news-debug', "mode: 'open'", 'JLPT 调试', 'safe-area-inset-top'):
            self.assertNotIn(marker, off)
        # A site name that looks like the placeholder stays a name.
        named = loader_script('https://jlpt.example', [site(name='@DEBUG@')], debug=False)
        self.assertEqual(config_of(named)['sites'][0]['name'], '@DEBUG@')

    def test_values_that_look_like_placeholders_stay_text(self):
        for fake in ('@VERSION@', '@BASE@', '@MATCHES@', '@CONFIG@'):
            for debug in (True, False):
                with self.subTest(fake=fake, debug=debug):
                    text = loader_script('https://jlpt.example/' + fake, [site(name=fake, match='https://a.example/' + fake)],
                                         debug=debug)
                    self.assertEqual(config_of(text)['sites'][0]['name'], fake)
                    self.assertEqual(config_of(text)['base'], 'https://jlpt.example/' + fake)
                    self.assertIn(f'\n// @name         JLPT 新闻查词 v{LOADER_VERSION}\n', text)
                    self.assertIn(f'\n// @version      {LOADER_VERSION}\n', text)
                    self.assertIn('\n// @namespace    https://jlpt.example/' + fake + '\n', text)
                    self.assertIn('\n// @match        https://a.example/' + fake + '\n', text)
                    self.assertEqual(text.count('// @match'), 1)

    def test_loader_version_is_bumped_when_the_loader_changes(self):
        template = ''.join(getattr(news_sites, name) for name in ('_HEADER', '_BODY', '_DEBUG_ON', '_DEBUG_OFF'))
        digest = hashlib.sha256(template.encode('utf-8')).hexdigest()
        self.assertEqual(max(KNOWN_LOADERS), LOADER_VERSION)
        self.assertEqual(
            KNOWN_LOADERS.get(LOADER_VERSION), digest,
            f'loader text changed: bump LOADER_VERSION in server/news_sites.py and add the new hash here '
            f'(KNOWN_LOADERS[{LOADER_VERSION + 1}] = {digest!r}); current LOADER_VERSION={LOADER_VERSION}')

    def test_news_debug_must_be_a_boolean(self):
        self.assertIs(debug_enabled({}), True)
        self.assertIs(debug_enabled({'news_debug': True}), True)
        self.assertIs(debug_enabled({'news_debug': False}), False)
        for bad in ('false', 'true', '0', 'no', None, 0, 1, [], {}):
            with self.subTest(value=bad):
                with self.assertRaisesRegex(ValueError, 'news_debug'):
                    debug_enabled({'news_debug': bad})

    def test_the_loader_carries_no_credentials_and_its_debug_lines_hide_the_config(self):
        for debug in (True, False):
            text = loader_script('https://jlpt.example', [DEFAULT_SITES[0]], debug=debug)
            self.assertNotIn('token', json.dumps(config_of(text)))
            body = text.split('// ==/UserScript==')[1]
            for line in body.splitlines():
                if 'debug(' in line:
                    for secret in ('Authorization', 'cookie', 'CONFIG)', 'CONFIG.base'):
                        self.assertNotIn(secret, line)

    def test_online_update_must_be_a_boolean(self):
        self.assertIs(online_update_enabled({}), True)
        self.assertIs(online_update_enabled({'news_online_update': False}), False)
        for bad in ('false', 0, None, []):
            with self.subTest(value=bad):
                with self.assertRaisesRegex(ValueError, 'news_online_update'):
                    online_update_enabled({'news_online_update': bad})


def config_of(text):
    return json.loads(re.search(r'^  const CONFIG = (.*);$', text, re.M)[1])


HARNESS = Path(__file__).with_name('news_loader_harness.mjs')
COUNT = "globalThis.__runs = (globalThis.__runs || 0) + 1; globalThis.__base = JLPT_NEWS.base;"


class LoaderRunTests(unittest.TestCase):
    """Executes the generated loader in Node with a stubbed fetch and DOM."""

    def run_loader(self, debug=True, **scenario):
        text = loader_script('https://jlpt.example', [DEFAULT_SITES[0]], debug=debug)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'loader.user.js'
            path.write_text(text, encoding='utf-8')
            done = subprocess.run(['node', str(HARNESS), str(path), json.dumps(scenario)],
                                  capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        report = json.loads(done.stdout)
        self.assertEqual(report['unhandled'], [], 'every failure must reach the failure button')
        return report

    def test_success_runs_the_main_script_once_with_the_config(self):
        report = self.run_loader(body=COUNT)
        self.assertEqual(report['requests'], [{'url': 'https://jlpt.example/api/news/client.js'}])  # no Authorization
        self.assertEqual((report['runs'], report['injected'], report['failures']), (1, 0, []))
        self.assertEqual(report['base'], 'https://jlpt.example')

    def test_a_refusal_is_an_ordinary_server_error(self):
        report = self.run_loader(status=401, body=COUNT)
        self.assertEqual(report['runs'], 0)
        self.assertEqual(report['failures'], [{'text': '加载主脚本失败：服务器返回 401', 'links': []}])

    def test_server_error_and_network_error(self):
        report = self.run_loader(status=500, body=COUNT)
        self.assertEqual(report['failures'], [{'text': '加载主脚本失败：服务器返回 500', 'links': []}])
        report = self.run_loader(networkError=True)
        self.assertEqual(report['failures'], [{'text': '加载主脚本失败：网络连接失败', 'links': []}])

    def test_main_script_error_shows_the_failure_button(self):
        report = self.run_loader(body=COUNT + " throw new Error('boom');")
        self.assertEqual(report['runs'], 1)
        self.assertEqual(report['failures'], [{'text': '主脚本出错：boom', 'links': []}])

    def test_eval_error_thrown_by_a_running_main_script_does_not_run_it_again(self):
        report = self.run_loader(body=COUNT + " throw new EvalError('later');")
        self.assertEqual((report['runs'], report['injected']), (1, 0))
        self.assertEqual(report['failures'], [{'text': '主脚本出错：later', 'links': []}])

    def test_without_eval_the_main_script_is_injected_once(self):
        report = self.run_loader(body=COUNT, noEval=True)
        self.assertEqual((report['runs'], report['injected'], report['failures']), (1, 1, []))
        self.assertEqual(report['base'], 'https://jlpt.example')

    def test_unparsable_main_script_is_reported(self):
        report = self.run_loader(body='this is not javascript (')
        self.assertEqual(report['runs'], 0)
        self.assertEqual(len(report['failures']), 1)
        self.assertTrue(report['failures'][0]['text'].startswith('加载主脚本失败：'), report['failures'])


# The main script's debug helper (news-client/debug.mjs) in a few lines: the loader's function when
# it ran the script with new Function, the event when the script went through an injected <script>.
SAY = ("(typeof JLPT_NEWS.debug === 'function' ? JLPT_NEWS.debug('来自主脚本', 'ok') : "
       "document.dispatchEvent(new CustomEvent('jlpt-news-debug', "
       "{detail: JSON.stringify({message: '来自主脚本', level: 'ok'})})));")
START = [(f'加载器已运行 v{LOADER_VERSION} 页面 /articles/abc123 readyState=loading', ''), ('匹配的网站: 雅虎新闻', 'ok'),
         ('正在取主脚本…', '')]


class LoaderDebugTests(unittest.TestCase):
    """The on-screen debug lines of the generated loader, read from its <jlpt-news-debug> overlay."""
    run_loader = LoaderRunTests.run_loader

    def lines(self, report):
        self.assertEqual(report['debug']['mode'], 'open')
        self.assertEqual(report['debug']['count'], 1)
        out = []
        for line in report['debug']['lines']:
            found = re.fullmatch(r'\+(\d+)ms (.*)', line['text'], re.S)
            self.assertTrue(found, line)
            out.append((found[2], line['level']))
        return out

    def fetched(self, body):
        return [(f'主脚本已取到: {len(body.encode())} 字节', 'ok')]

    def test_success_lists_every_step_in_order(self):
        body = COUNT + SAY
        report = self.run_loader(body=body)
        self.assertEqual(self.lines(report), START + self.fetched(body) + [
            ('执行方式: new Function', ''), ('来自主脚本', 'ok'), ('主脚本已执行', 'ok')])
        self.assertEqual(report['failures'], [])

    def test_failed_fetches_are_red_lines_beside_the_failure_button(self):
        for scenario, line in (({'status': 401}, '加载主脚本失败: 服务器返回 401'),
                               ({'status': 500}, '加载主脚本失败: 服务器返回 500'),
                               ({'networkError': True}, '加载主脚本失败: 网络连接失败（Failed to fetch）')):
            with self.subTest(scenario=scenario):
                report = self.run_loader(body=COUNT, **scenario)
                self.assertEqual(self.lines(report), START + [(line, 'error')])
                self.assertEqual(len(report['failures']), 1)
                self.assertEqual(report['runs'], 0)

    def test_main_script_error_is_a_red_line(self):
        body = COUNT + " throw new Error('boom');"
        report = self.run_loader(body=body)
        self.assertEqual(self.lines(report), START + self.fetched(body) + [
            ('执行方式: new Function', ''), ('主脚本出错: boom', 'error')])
        self.assertEqual(report['failures'], [{'text': '主脚本出错：boom', 'links': []}])

    def test_without_eval_the_injected_script_reports_through_events(self):
        body = COUNT + SAY
        report = self.run_loader(body=body, noEval=True)
        self.assertEqual(self.lines(report), START + self.fetched(body) + [
            ('执行方式: 注入 <script>（eval 被禁用）', ''), ('来自主脚本', 'ok'), ('主脚本已执行', 'ok')])
        self.assertEqual((report['runs'], report['injected'], report['failures']), (1, 1, []))

    def test_without_eval_an_error_in_the_injected_script_is_a_red_line(self):
        body = COUNT + " throw new Error('boom');"
        report = self.run_loader(body=body, noEval=True)
        self.assertEqual(self.lines(report)[-2:], [('执行方式: 注入 <script>（eval 被禁用）', ''), ('主脚本出错: boom', 'error')])
        # Still thrown in the page, as before.
        self.assertEqual(report['pageErrors'], ['boom'])

    def test_an_injected_script_that_never_runs_is_named(self):
        report = self.run_loader(body=COUNT, noEval=True, noScript=True)
        self.assertEqual(self.lines(report)[-2:], [('执行方式: 注入 <script>（eval 被禁用）', ''),
                                                   ('注入的主脚本没有运行（可能被网页的安全策略拦截）', 'error')])
        self.assertEqual(report['runs'], 0)

    def test_a_page_outside_the_site_table_says_so(self):
        report = self.run_loader(body=COUNT, url='https://news.yahoo.co.jp/articles/abc123/images/000?token=x')
        lines = self.lines(report)
        self.assertEqual(lines[:2], [(f'加载器已运行 v{LOADER_VERSION} 页面 /articles/abc123/images/000 readyState=loading', ''),
                                     ('当前页面不在网站表内', 'warn')])
        self.assertNotIn('token=x', json.dumps(report['debug'], ensure_ascii=False))

    def test_the_overlay_waits_for_the_document_element(self):
        body = COUNT
        report = self.run_loader(body=body, lateRoot=True)
        self.assertEqual(self.lines(report)[0], (f'加载器已运行 v{LOADER_VERSION} 页面 /articles/abc123 readyState=loading', ''))
        self.assertEqual(self.lines(report)[-1], ('主脚本已执行', 'ok'))
        # A first readystatechange may still come without the root: the overlay waits for the next one.
        report = self.run_loader(body=body, lateRoot='twice')
        self.assertEqual(report['listenerErrors'], [])
        self.assertEqual(self.lines(report)[-1], ('主脚本已执行', 'ok'))
        self.assertEqual(report['runs'], 1)

    def test_an_overlay_that_cannot_be_built_never_stops_loading(self):
        for broken in ('shadow', 'append'):
            with self.subTest(broken=broken):
                report = self.run_loader(body=COUNT + SAY, brokenOverlay=broken)
                self.assertIsNone(report['debug'])
                self.assertEqual(len(report['requests']), 1)
                self.assertEqual((report['runs'], report['failures'], report['pageErrors']), (1, [], []))
                self.assertEqual(report['base'], 'https://jlpt.example')
                report = self.run_loader(body=COUNT, noEval=True, brokenOverlay=broken)
                self.assertEqual((report['runs'], report['injected'], report['failures']), (1, 1, []))
                report = self.run_loader(status=401, brokenOverlay=broken)
                self.assertEqual(report['failures'], [{'text': '加载主脚本失败：服务器返回 401', 'links': []}])
                report = self.run_loader(networkError=True, brokenOverlay=broken)
                self.assertEqual(report['failures'], [{'text': '加载主脚本失败：网络连接失败', 'links': []}])

    def test_unknown_levels_are_plain_lines(self):
        say = lambda level: ("JLPT_NEWS.debug('x " + level + "', '" + level + "');")
        report = self.run_loader(body=''.join(say(level) for level in ('constructor', 'toString', 'ok')))
        lines = self.lines(report)
        self.assertIn(('x constructor', ''), lines)
        self.assertIn(('x toString', ''), lines)
        self.assertIn(('x ok', 'ok'), lines)

    def test_debug_off_makes_no_overlay_and_gives_a_quiet_function(self):
        report = self.run_loader(debug=False, body=COUNT + ' globalThis.__debugType = typeof JLPT_NEWS.debug;' + SAY)
        self.assertIsNone(report['debug'])
        self.assertEqual((report['runs'], report['failures'], report['debugType']), (1, [], 'function'))
        report = self.run_loader(debug=False, status=500)
        self.assertIsNone(report['debug'])
        self.assertEqual(len(report['failures']), 1)
        report = self.run_loader(debug=False, body=COUNT + SAY, noEval=True)
        self.assertIsNone(report['debug'])
        self.assertEqual((report['runs'], report['failures'], report['pageErrors']), (1, [], []))


if __name__ == '__main__':
    unittest.main()
