import unittest
import urllib.request
from unittest import mock

from server.news_errors import STAGES, NewsError, new_request_id
from server.news_yahoo import FEEDS, Yahoo, http_fetch, validate_url
from tests.server.news_fixture import ARTICLE_URL as A, PICKUP_URL as P, fake_fetch, fake_open, load


def no_sleep(s):
    pass


def quiet(*a):
    pass


def multi(**over):
    mapping = {P: (200, load('pickup')), A: (200, load('multi_p1')),
               A + '?page=2': (200, load('multi_p2')), A + '?page=3': (200, load('multi_p3'))}
    mapping.update(over)
    return mapping


class YahooTests(unittest.TestCase):
    def test_pickup_resolves_and_multi_page_merges_in_order(self):
        y = Yahoo(fetch=fake_fetch(multi()), sleep=no_sleep)
        art = y.open(P, progress=quiet)
        texts = [b['text'] for b in art['blocks'] if b['type'] == 'paragraph']
        self.assertEqual(texts, ['一頁目の本文。', '二頁目の本文。', '三頁目の本文。'])
        self.assertEqual(art['pages'], {'total': 3, 'fetched': 3, 'missing': []})
        self.assertEqual(art['id'], 'a1b2c3d4e5f60718293a4b5c6d7e8f9001122334')
        self.assertEqual(art['url'], A)
        self.assertEqual(art['title'], '複数ページの見出し')
        self.assertEqual(art['media'], 'テスト通信')
        self.assertEqual(art['published'], '2026-11-08T15:30:00+09:00')
        self.assertEqual(art['author'], '記者 太郎')
        self.assertEqual(art['errors'], [])

    def test_open_article_url_directly_skips_pickup(self):
        f = fake_fetch({A: (200, load('single'))})
        art = Yahoo(fetch=f, sleep=no_sleep).open(A, progress=quiet)
        self.assertEqual(art['pages'], {'total': 1, 'fetched': 1, 'missing': []})

    def test_missing_page_keeps_rest_and_records_error(self):
        y = Yahoo(fetch=fake_fetch(multi(**{A + '?page=3': (503, b'')})), sleep=no_sleep)
        art = y.open(P, progress=quiet)
        texts = [b['text'] for b in art['blocks'] if b['type'] == 'paragraph']
        self.assertEqual(texts, ['一頁目の本文。', '二頁目の本文。'])
        self.assertEqual(art['pages'], {'total': 3, 'fetched': 2, 'missing': [3]})
        self.assertEqual(art['errors'][0]['stage'], 'yahoo')
        self.assertEqual(art['errors'][0]['location'], '第 3 页 / 共 3 页')
        self.assertIn('503', art['errors'][0]['reason'])

    def test_network_exception_on_later_page_is_recorded(self):
        y = Yahoo(fetch=fake_fetch(multi(**{A + '?page=2': TimeoutError('timed out')})), sleep=no_sleep)
        art = y.open(P, progress=quiet)
        self.assertEqual(art['pages']['missing'], [2])
        self.assertEqual(art['errors'][0]['stage'], 'yahoo')
        self.assertTrue(art['errors'][0]['retryable'])

    def test_first_page_failure_raises_yahoo_error(self):
        y = Yahoo(fetch=fake_fetch({P: (200, load('pickup')), A: (404, b'')}), sleep=no_sleep)
        with self.assertRaises(NewsError) as cm:
            y.open(P, progress=quiet)
        self.assertEqual(cm.exception.stage, 'yahoo')
        self.assertEqual(cm.exception.reason, '雅虎返回 404')
        self.assertFalse(cm.exception.retryable)

    def test_image_caption_heading_video_and_unknown_blocks(self):
        y = Yahoo(fetch=fake_fetch({A: (200, load('video'))}), sleep=no_sleep)
        art = y.open(A, progress=quiet)
        types = [b['type'] for b in art['blocks']]
        self.assertIn('video', types)
        self.assertIn('unknown', types)
        self.assertEqual(types, ['heading', 'paragraph', 'video', 'unknown', 'paragraph', 'image'])
        img = next(b for b in art['blocks'] if b['type'] == 'image')
        self.assertEqual(img['caption'], '画像：テスト')
        self.assertEqual(img['credit'], 'テスト提供')
        self.assertTrue(img['src'].startswith('https://newsatcl-pctr.c.yimg.jp/') and 'photo1.jpg' in img['src'])
        self.assertEqual(next(b for b in art['blocks'] if b['type'] == 'heading')['text'], '最初の小見出し')
        video = next(b for b in art['blocks'] if b['type'] == 'video')
        self.assertEqual(video['url'], 'https://news.yahoo.co.jp/video/test/1.m3u8')
        self.assertEqual(next(b for b in art['blocks'] if b['type'] == 'unknown')['url'], A)

    def test_image_falls_back_to_view_uri(self):
        from server.news_yahoo import parse_page
        state = {'articleDetail': {'headline': 'x', 'paragraphs': [
            {'textDetails': [], 'objectItems': [{'view': {'uri': 'https://a/b.jpg'}}]}]}}
        blocks = parse_page(state, A)['blocks']
        self.assertEqual(blocks, [{'type': 'image', 'src': 'https://a/b.jpg', 'caption': '', 'credit': ''}])

    def test_broken_page_raises_parse_stage(self):
        y = Yahoo(fetch=fake_fetch({A: (200, load('broken'))}), sleep=no_sleep)
        with self.assertRaises(NewsError) as cm:
            y.open(A, progress=quiet)
        self.assertEqual(cm.exception.stage, 'parse')

    def test_page_without_state_raises_parse_stage(self):
        y = Yahoo(fetch=fake_fetch({A: (200, b'<html>nothing</html>')}), sleep=no_sleep)
        with self.assertRaises(NewsError) as cm:
            y.open(A, progress=quiet)
        self.assertEqual(cm.exception.stage, 'parse')

    def test_pickup_without_article_raises_parse_stage(self):
        y = Yahoo(fetch=fake_fetch({P: (200, load('single'))}), sleep=no_sleep)
        with self.assertRaises(NewsError) as cm:
            y.open(P, progress=quiet)
        self.assertEqual(cm.exception.stage, 'parse')

    def test_pickup_pointing_off_news_is_final_and_names_host(self):
        # 实测：有的话题（如社交网络帖子汇总）指向 search.yahoo.co.jp 而不是新闻文章。
        page = load('pickup').replace(
            b'https://news.yahoo.co.jp/articles/a1b2c3d4e5f60718293a4b5c6d7e8f9001122334?source=topics',
            b'https://search.yahoo.co.jp/realtime/search/theme/0123abcd?fr=x')
        for body, host in ((page, 'search.yahoo.co.jp'),
                           (load('pickup').replace(b'"url": "https://news', b'"url": 7, "x": "'), '未知地址')):
            y = Yahoo(fetch=fake_fetch({P: (200, body)}), sleep=no_sleep)
            with self.assertRaises(NewsError) as cm:
                y.open(P, progress=quiet)
            e = cm.exception
            self.assertEqual((e.stage, e.location, e.retryable), ('parse', '话题页', False))
            self.assertIn(host, e.reason)

    def test_validate_url_accepts_and_normalizes(self):
        self.assertEqual(validate_url(' https://news.yahoo.co.jp/pickup/123?x=1#y '), 'https://news.yahoo.co.jp/pickup/123')
        self.assertEqual(validate_url(A + '?page=2'), A)

    def test_validate_url_rejects_lookalikes(self):
        for bad in ('https://news.yahoo.co.jp.evil.com/articles/ab', 'http://127.0.0.1/articles/ab',
                    'https://news.yahoo.co.jp/articles/ab/comments', 'https://example.com/pickup/1',
                    'http://news.yahoo.co.jp/pickup/1', 'https://user@news.yahoo.co.jp/pickup/1',
                    'https://news.yahoo.co.jp:8443/pickup/1', 'https://news.yahoo.co.jp/pickup/abc',
                    'https://news.yahoo.co.jp/articles/' + 'a' * 65, '', 'javascript:alert(1)'):
            with self.assertRaises(ValueError, msg=bad) as cm:
                validate_url(bad)
            self.assertEqual(str(cm.exception), '只支持雅虎新闻的链接')

    def test_feed_parses_rss(self):
        y = Yahoo(fetch=fake_fetch({'https://news.yahoo.co.jp/rss/topics/domestic.xml': (200, load('rss'))}))
        items = y.feed('domestic')
        self.assertEqual(items[0], {'title': '見出し一', 'url': 'https://news.yahoo.co.jp/pickup/1', 'time': '2026-11-08T06:51:34+00:00'})
        self.assertEqual(len(items), 2)

    def test_feed_errors(self):
        y = Yahoo(fetch=fake_fetch({'https://news.yahoo.co.jp/rss/topics/world.xml': (200, b'<rss'),
                                    'https://news.yahoo.co.jp/rss/topics/sports.xml': (500, b'')}))
        with self.assertRaises(NewsError) as cm:
            y.feed('world')
        self.assertEqual(cm.exception.stage, 'parse')
        with self.assertRaises(NewsError) as cm:
            y.feed('sports')
        self.assertEqual(cm.exception.stage, 'yahoo')
        with self.assertRaises(ValueError):
            y.feed('nope')

    def test_feeds_order(self):
        self.assertEqual(list(FEEDS), ['top-picks', 'domestic', 'world', 'business', 'entertainment', 'sports', 'it', 'science'])
        self.assertEqual(FEEDS['domestic'], '国内')

    def test_progress_reports_each_page(self):
        calls = []
        Yahoo(fetch=fake_fetch(multi()), sleep=no_sleep).open(P, progress=lambda s, t: calls.append(t))
        self.assertIn('正在抓取雅虎（第 2 / 3 页）…', calls)
        self.assertIn('正在抓取雅虎（第 3 / 3 页）…', calls)

    def test_pages_are_spaced_by_half_a_second(self):
        slept = []
        Yahoo(fetch=fake_fetch(multi()), sleep=slept.append).open(P, progress=quiet)
        self.assertEqual(slept, [0.5, 0.5])

    def test_request_id_format(self):
        self.assertRegex(new_request_id(), r'^n-\d{8}-[0-9a-f]{4}$')


class ErrorTests(unittest.TestCase):
    def test_stages(self):
        self.assertEqual(list(STAGES), ['client', 'yahoo', 'parse', 'tokenize', 'image', 'gateway', 'model', 'format', 'stream'])
        self.assertEqual(STAGES['yahoo'], '抓取雅虎')

    def test_to_dict(self):
        e = NewsError('image', '图片超过 5 MB', '第 2 张')
        d = e.to_dict()
        self.assertEqual(set(d), {'stage', 'stage_label', 'location', 'reason', 'retryable', 'request_id', 'time'})
        self.assertEqual((d['stage'], d['stage_label'], d['location'], d['reason'], d['retryable']),
                         ('image', '下载图片', '第 2 张', '图片超过 5 MB', True))
        self.assertRegex(d['request_id'], r'^n-\d{8}-[0-9a-f]{4}$')
        self.assertRegex(d['time'], r'^\d\d:\d\d:\d\d$')
        self.assertEqual(str(e), '图片超过 5 MB')

    def test_unknown_stage_rejected_and_request_id_kept(self):
        with self.assertRaises(ValueError):
            NewsError('nope', 'x')
        self.assertEqual(NewsError('model', 'x', request_id='n-20261108-abcd').to_dict()['request_id'], 'n-20261108-abcd')


class RedirectTests(unittest.TestCase):
    def test_redirect_to_other_host_or_http_refused(self):
        from server.news_yahoo import _SameHostRedirect
        h = _SameHostRedirect()
        req = urllib.request.Request('https://news.yahoo.co.jp/articles/ab')
        for bad in ('https://evil.example.com/x', 'http://news.yahoo.co.jp/x', 'https://news.yahoo.co.jp.evil.com/x'):
            with self.assertRaises(Exception, msg=bad):
                h.redirect_request(req, None, 302, 'Found', {}, bad)
        ok = h.redirect_request(req, None, 302, 'Found', {}, 'https://news.yahoo.co.jp/articles/cd')
        self.assertEqual(ok.full_url, 'https://news.yahoo.co.jp/articles/cd')


JPEG = b'\xff\xd8\xff\xe0' + b'\x00' * 16
PHOTO = 'https://newsatcl-pctr.c.yimg.jp/t/a.jpg'
LIMIT = 5 * 1024 * 1024


class ImageFetchTests(unittest.TestCase):
    def yahoo(self, mapping):
        opener = fake_open(mapping)
        return Yahoo(fetch=fake_fetch({}), sleep=no_sleep, open_image=opener), opener

    def assertImageError(self, ctx, reason=None):
        self.assertEqual((ctx.exception.stage, ctx.exception.location), ('image', '第 1 张'))
        if reason:
            self.assertEqual(ctx.exception.reason, reason)

    def test_fetches_yimg_and_yahoo_hosts(self):
        y, opener = self.yahoo({PHOTO: JPEG, 'https://news.yahoo.co.jp/p.jpg': JPEG})
        self.assertEqual(y.image(PHOTO, '第 1 张'), JPEG)
        self.assertEqual(y.image('https://news.yahoo.co.jp/p.jpg', '第 1 张'), JPEG)
        self.assertEqual(opener.reads, [LIMIT + 1, LIMIT + 1])

    def test_off_host_src_refused_without_fetching(self):
        y, opener = self.yahoo({})
        for bad in ('https://evil.example/a.jpg', 'http://newsatcl-pctr.c.yimg.jp/a.jpg',
                    'https://newsatcl-pctr.c.yimg.jp.evil.com/a.jpg', 'https://yimg.jp.evil/a.jpg',
                    'https://user@s.yimg.jp/a.jpg', 'https://s.yimg.jp:8443/a.jpg', '', None,
                    'https://news.yahoo.co.jp.evil.com/a.jpg'):
            with self.assertRaises(NewsError, msg=bad) as ctx:
                y.image(bad, '第 1 张')
            self.assertImageError(ctx)
        self.assertEqual(opener.calls, [])

    def test_oversize_body_stops_reading_at_limit(self):
        y, opener = self.yahoo({PHOTO: b'\xff\xd8\xff' + b'x' * (LIMIT + 4096)})
        with self.assertRaises(NewsError) as ctx:
            y.image(PHOTO, '第 1 张')
        self.assertImageError(ctx, '图片超过 5 MB')
        self.assertEqual(opener.reads, [LIMIT + 1])

    def test_redirects_followed_only_within_allowed_hosts(self):
        moved = 'https://s.yimg.jp/b.jpg'
        y, opener = self.yahoo({PHOTO: (302, b'', {'Location': moved}), moved: JPEG})
        self.assertEqual(y.image(PHOTO, '第 1 张'), JPEG)
        self.assertEqual(opener.calls, [PHOTO, moved])
        y, opener = self.yahoo({PHOTO: (301, b'', {'Location': '/c.jpg'}),
                                'https://newsatcl-pctr.c.yimg.jp/c.jpg': JPEG})
        self.assertEqual(y.image(PHOTO, '第 1 张'), JPEG)
        for bad in ('https://evil.example/b.jpg', 'http://s.yimg.jp/b.jpg'):
            y, opener = self.yahoo({PHOTO: (302, b'', {'Location': bad}), bad: JPEG})
            with self.assertRaises(NewsError, msg=bad) as ctx:
                y.image(PHOTO, '第 1 张')
            self.assertImageError(ctx)
            self.assertEqual(opener.calls, [PHOTO])

    def test_redirect_loop_and_errors(self):
        y, _ = self.yahoo({PHOTO: (302, b'', {'Location': PHOTO})})
        with self.assertRaises(NewsError) as ctx:
            y.image(PHOTO, '第 1 张')
        self.assertImageError(ctx)
        y, _ = self.yahoo({PHOTO: (404, b'')})
        with self.assertRaises(NewsError) as ctx:
            y.image(PHOTO, '第 1 张')
        self.assertImageError(ctx, '图片返回 404')
        self.assertFalse(ctx.exception.retryable)
        y, _ = self.yahoo({PHOTO: TimeoutError('timed out')})
        with self.assertRaises(NewsError) as ctx:
            y.image(PHOTO, '第 1 张')
        self.assertImageError(ctx)
        self.assertTrue(ctx.exception.retryable)

    def test_default_opener_uses_timeout_and_never_redirects_itself(self):
        from server.news_yahoo import TIMEOUT, _NoRedirect, open_image
        self.assertIsNone(_NoRedirect().redirect_request(
            urllib.request.Request(PHOTO), None, 302, 'Found', {}, 'https://evil.example/'))
        opener = mock.Mock()
        with mock.patch('server.news_yahoo.urllib.request.build_opener', return_value=opener) as build:
            open_image(PHOTO)
        self.assertTrue(any(isinstance(h, _NoRedirect) for h in build.call_args.args))
        self.assertEqual(opener.open.call_args.kwargs['timeout'], TIMEOUT)


if __name__ == '__main__':
    unittest.main()
