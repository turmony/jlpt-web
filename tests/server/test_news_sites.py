import copy
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from server.news_sites import DEFAULT_SITES, allowed_origins, loader_script, sites


def site(**changes):
    entry = copy.deepcopy(DEFAULT_SITES[0])
    entry.update(changes)
    return entry


class SitesTests(unittest.TestCase):
    def test_default_sites_and_allowed_origins(self):
        self.assertEqual(sites({}), DEFAULT_SITES)
        self.assertEqual(allowed_origins({}), {'https://news.yahoo.co.jp'})

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

    def test_loader_has_metadata_matches_and_config(self):
        second = site(name='NHK', origin='https://www3.nhk.or.jp', match='https://www3.nhk.or.jp/news/*')
        text = loader_script('https://jlpt.example', 'tok-123', [DEFAULT_SITES[0], second])
        self.assertTrue(text.startswith('// ==UserScript==\n'))
        self.assertIn('// @name         JLPT 新闻查词', text)
        self.assertIn('// @namespace    https://jlpt.example', text)
        self.assertIn('// @match        https://news.yahoo.co.jp/articles/*', text)
        self.assertIn('// @match        https://www3.nhk.or.jp/news/*', text)
        self.assertIn('// @run-at       document-start', text)
        self.assertIn('// @inject-into  content', text)
        self.assertIn('// @noframes', text)
        self.assertIn('// ==/UserScript==', text)
        self.assertIn('tok-123', text)
        self.assertIn('/api/news/client.js', text)
        self.assertIn('https://jlpt.example/news-script/', text)
        for words in ('加载主脚本失败：', '令牌已失效，请重新安装脚本', '服务器返回 ', '网络连接失败'):
            self.assertIn(words, text)

    def test_loader_escapes_script_end(self):
        evil = site(name='</script>\n// @match evil', match='https://news.yahoo.co.jp/a\n// @grant GM_xmlhttpRequest')
        text = loader_script('https://jlpt.example', 'tok', [evil])
        self.assertNotIn('</script>', text.lower())
        head = text.split('// ==/UserScript==')[0]
        for line in head.splitlines():
            self.assertTrue(line.startswith('//'), line)
        self.assertNotIn('\n// @grant', text)

    def test_loader_is_valid_javascript(self):
        for name in ('雅虎新闻', '</script>'):
            text = loader_script('https://jlpt.example', 'tok', [site(name=name)])
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'loader.user.js'
                path.write_text(text, encoding='utf-8')
                done = subprocess.run(['node', '--check', str(path)], capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)


HARNESS = Path(__file__).with_name('news_loader_harness.mjs')
COUNT = "globalThis.__runs = (globalThis.__runs || 0) + 1; globalThis.__token = JLPT_NEWS.token;"


class LoaderRunTests(unittest.TestCase):
    """Executes the generated loader in Node with a stubbed fetch and DOM."""

    def run_loader(self, **scenario):
        text = loader_script('https://jlpt.example', 'tok-run', [DEFAULT_SITES[0]])
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
        self.assertEqual(report['requests'], [{'url': 'https://jlpt.example/api/news/client.js',
                                               'authorization': 'Bearer tok-run'}])
        self.assertEqual((report['runs'], report['injected'], report['failures']), (1, 0, []))
        self.assertEqual(report['token'], 'tok-run')

    def test_revoked_token_shows_reason_and_install_link(self):
        report = self.run_loader(status=401, body=COUNT)
        self.assertEqual(report['runs'], 0)
        self.assertEqual(report['failures'], [{'text': '加载主脚本失败：令牌已失效，请重新安装脚本',
                                               'links': ['https://jlpt.example/news-script/']}])

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
        self.assertEqual(report['token'], 'tok-run')

    def test_unparsable_main_script_is_reported(self):
        report = self.run_loader(body='this is not javascript (')
        self.assertEqual(report['runs'], 0)
        self.assertEqual(len(report['failures']), 1)
        self.assertTrue(report['failures'][0]['text'].startswith('加载主脚本失败：'), report['failures'])


if __name__ == '__main__':
    unittest.main()
