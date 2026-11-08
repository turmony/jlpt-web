import unittest
import urllib.request
from unittest import mock

from server.news_errors import STAGES, NewsError, new_request_id
from server.news_yahoo import FEEDS, OffNewsTopic, Yahoo, http_fetch, validate_url
from tests.server.news_fixture import (ARTICLE_URL as A, PICKUP_URL as P, article_page, article_pages,
                                      fake_fetch, fake_open, load)


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

    def test_network_exception_on_later_page_stops_and_is_recorded(self):
        y = Yahoo(fetch=fake_fetch(multi(**{A + '?page=2': TimeoutError('timed out')})), sleep=no_sleep)
        art = y.open(P, progress=quiet)
        self.assertEqual(art['pages']['missing'], [2, 3])
        self.assertEqual(len(art['errors']), 1)
        self.assertEqual(art['errors'][0]['stage'], 'yahoo')
        self.assertEqual(art['errors'][0]['location'], '第 2–3 页 / 共 3 页')
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
            self.assertIsInstance(e, OffNewsTopic)

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


class Clock:
    """A fake clock; its sleep advances time and is recorded."""
    def __init__(self):
        self.t = 0.0
        self.slept = []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


def page(n):
    return A if n == 1 else A + '?page=%d' % n


class PageRuleTests(unittest.TestCase):
    """Task 13: page cap, per-page retry, failure classes, page sanity, time budget, refill."""

    def open(self, mapping, url=A, clock=None, known=None, fetch=None):
        clock = clock or Clock()
        f = fetch or fake_fetch(mapping)
        y = Yahoo(fetch=f, sleep=clock.sleep, clock=clock)
        art = y.open(url, quiet, known=known) if known else y.open(url, quiet)
        return art, f.calls, clock

    def texts(self, art):
        return [b['text'] for b in art['blocks'] if b['type'] == 'paragraph']

    def test_constants(self):
        from server import news_yahoo
        self.assertEqual((news_yahoo.MAX_PAGES, news_yahoo.PAGE_RETRY_DELAY, news_yahoo.OPEN_BUDGET), (6, 1.5, 30))

    def test_more_than_six_pages_fetches_six_and_records_one_cap_error(self):
        art, calls, _ = self.open(article_pages(8))
        self.assertEqual(calls, [page(n) for n in range(1, 7)])
        self.assertEqual(art['pages'], {'total': 8, 'fetched': 6, 'missing': []})
        self.assertEqual(self.texts(art), ['第%d頁の本文。' % n for n in range(1, 7)])
        self.assertEqual(len(art['errors']), 1)
        err = art['errors'][0]
        self.assertEqual((err['stage'], err['location'], err['reason'], err['retryable']),
                         ('yahoo', '第 7–8 页 / 共 8 页', '这篇文章共 8 页，只显示前 6 页，其余请看原文', False))
        self.assertRegex(err['request_id'], r'^n-\d{8}-[0-9a-f]{4}$')

    def test_absurd_page_count_is_fast_and_bounded(self):
        import time
        import tracemalloc
        total = 10 ** 9
        tracemalloc.start()
        began = time.monotonic()
        try:
            art, calls, _ = self.open(article_pages(total, upto=6))
            _size, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(time.monotonic() - began, 2)
        self.assertLess(peak, 2 * 1024 * 1024)
        self.assertEqual(calls, [page(n) for n in range(1, 7)])
        self.assertEqual(art['pages'], {'total': total, 'fetched': 6, 'missing': []})
        self.assertEqual([(e['location'], e['reason']) for e in art['errors']],
                         [('第 7–1000000000 页 / 共 1000000000 页', '这篇文章共 1000000000 页，只显示前 6 页，其余请看原文')])

    def test_failed_page_is_retried_once_after_a_pause(self):
        mapping = article_pages(6)
        mapping[page(3)] = [(503, b''), mapping[page(3)]]
        art, calls, clock = self.open(mapping)
        self.assertEqual(calls, [page(1), page(2), page(3), page(3), page(4), page(5), page(6)])
        self.assertEqual(art['pages'], {'total': 6, 'fetched': 6, 'missing': []})
        self.assertEqual(art['errors'], [])
        self.assertEqual(clock.slept, [0.5, 0.5, 1.5, 0.5, 0.5, 0.5])

    def test_first_page_is_retried_once_too(self):
        mapping = article_pages(1)
        mapping[A] = [TimeoutError('timed out'), mapping[A]]
        art, calls, clock = self.open(mapping)
        self.assertEqual(calls, [A, A])
        self.assertEqual(clock.slept, [1.5])
        self.assertEqual(self.texts(art), ['第1頁の本文。'])
        with self.assertRaises(NewsError) as cm:
            self.open({A: (503, b'')})
        self.assertEqual((cm.exception.stage, cm.exception.reason), ('yahoo', '雅虎返回 503'))

    def test_site_wide_failure_stops_and_marks_the_rest_missing(self):
        for answer, reason in (((503, b''), '雅虎返回 503'), ((500, b''), '雅虎返回 500'),
                               ((403, b''), '雅虎返回 403'), ((429, b''), '雅虎返回 429'),
                               (TimeoutError('timed out'), '连接雅虎失败：timed out'),
                               (ConnectionResetError('reset'), '连接雅虎失败：reset')):
            mapping = article_pages(6)
            mapping[page(3)] = answer
            art, calls, _ = self.open(mapping)
            self.assertEqual(calls, [page(1), page(2), page(3), page(3)], reason)
            self.assertEqual(art['pages'], {'total': 6, 'fetched': 2, 'missing': [3, 4, 5, 6]})
            self.assertEqual(self.texts(art), ['第1頁の本文。', '第2頁の本文。'])
            self.assertEqual([(e['stage'], e['location'], e['reason'], e['retryable']) for e in art['errors']],
                             [('yahoo', '第 3–6 页 / 共 6 页', reason, True)], reason)

    def test_page_specific_failure_skips_that_page_only(self):
        broken = (200, b'<html>no data</html>')
        for answer, stage, retryable in (((404, b''), 'yahoo', False), ((410, b''), 'yahoo', False),
                                         (broken, 'parse', True),
                                         ((200, load('multi_p1').replace(b'"paragraphs"', b'"nothing"')), 'parse', True)):
            mapping = article_pages(6)
            mapping[page(3)] = answer
            art, calls, _ = self.open(mapping)
            self.assertEqual(calls, [page(1), page(2), page(3), page(3), page(4), page(5), page(6)], answer)
            self.assertEqual(art['pages'], {'total': 6, 'fetched': 5, 'missing': [3]})
            self.assertEqual(self.texts(art), ['第%d頁の本文。' % n for n in (1, 2, 4, 5, 6)])
            self.assertEqual([(e['stage'], e['location'], e['retryable']) for e in art['errors']],
                             [(stage, '第 3 页 / 共 6 页', retryable)], answer)

    def test_page_with_wrong_number_stops_with_parse_error(self):
        mapping = article_pages(6)
        mapping[page(4)] = (200, article_page(4, 6, current=1))  # Yahoo ignored ?page=
        art, calls, _ = self.open(mapping)
        self.assertEqual(calls, [page(1), page(2), page(3), page(4)])
        self.assertEqual(art['pages'], {'total': 6, 'fetched': 3, 'missing': [4, 5, 6]})
        self.assertEqual(self.texts(art), ['第1頁の本文。', '第2頁の本文。', '第3頁の本文。'])
        self.assertEqual([(e['stage'], e['location'], e['reason']) for e in art['errors']],
                         [('parse', '第 4 页 / 共 6 页', '第 4 页内容与页码不符，已停止抓取后续页')])

    def test_time_budget_stops_fetching(self):
        clock = Clock()
        inner = fake_fetch(article_pages(6))

        def slow(url):  # every request takes 8 s
            clock.t += 8
            return inner(url)
        slow.calls = inner.calls
        art, calls, _ = self.open(None, clock=clock, fetch=slow)
        # 0→8 (p1) 8.5→16.5 (p2) 17→25 (p3) 25.5→33.5 (p4); at 34 s the budget is spent.
        self.assertEqual(calls, [page(1), page(2), page(3), page(4)])
        self.assertEqual(art['pages'], {'total': 6, 'fetched': 4, 'missing': [5, 6]})
        self.assertEqual([(e['stage'], e['location'], e['reason'], e['retryable']) for e in art['errors']],
                         [('yahoo', '第 5–6 页 / 共 6 页', '抓取超过 30 秒，已停止', True)])

    def test_budget_is_injectable(self):
        clock = Clock()
        y = Yahoo(fetch=fake_fetch(article_pages(3)), sleep=clock.sleep, clock=clock, budget=0.7)
        art = y.open(A, quiet)
        # 0.5 s gap before page 2 is within 0.7 s; after the gap before page 3 (1.0 s) it is not.
        self.assertEqual(art['pages']['missing'], [3])
        self.assertEqual(art['errors'][0]['reason'], '抓取超过 0.7 秒，已停止')

    def test_known_pages_are_kept_and_only_missing_pages_fetched(self):
        mapping = article_pages(6)
        mapping[page(3)] = (404, b'')
        first, _calls, _ = self.open(mapping)
        self.assertEqual(first['pages']['missing'], [3])
        self.assertEqual(first['page_blocks'][0][0], 1)
        mapping = article_pages(6)
        art, calls, clock = self.open(mapping, url=P, known=first)
        self.assertEqual(calls, [page(3)])
        self.assertEqual(clock.slept, [0.5])
        self.assertEqual(art['pages'], {'total': 6, 'fetched': 6, 'missing': []})
        self.assertEqual(self.texts(art), ['第%d頁の本文。' % n for n in range(1, 7)])
        self.assertEqual(art['errors'], [])
        self.assertEqual((art['id'], art['url'], art['title']), (first['id'], first['url'], first['title']))

    def test_refill_applies_the_same_rules_and_keeps_the_cap_error(self):
        mapping = article_pages(9)
        mapping[page(3)] = (503, b'')
        first, _calls, _ = self.open(mapping)
        self.assertEqual(first['pages']['missing'], [3, 4, 5, 6])
        self.assertEqual([e['location'] for e in first['errors']], ['第 3–6 页 / 共 9 页', '第 7–9 页 / 共 9 页'])
        mapping = article_pages(9)
        mapping[page(5)] = (503, b'')
        art, calls, _ = self.open(mapping, known=first)
        self.assertEqual(calls, [page(3), page(4), page(5), page(5)])
        self.assertEqual(art['pages'], {'total': 9, 'fetched': 4, 'missing': [5, 6]})
        self.assertEqual([e['location'] for e in art['errors']], ['第 5–6 页 / 共 9 页', '第 7–9 页 / 共 9 页'])

    def test_range_location_skips_pages_already_fetched(self):
        mapping = article_pages(6)
        mapping[page(3)] = (404, b'')
        mapping[page(5)] = (404, b'')
        first, _calls, _ = self.open(mapping)
        self.assertEqual(first['pages']['missing'], [3, 5])
        mapping = article_pages(6)
        mapping[page(3)] = (503, b'')
        art, calls, _ = self.open(mapping, known=first)
        self.assertEqual(calls, [page(3), page(3)])
        self.assertEqual(art['pages']['missing'], [3, 5])
        self.assertEqual([e['location'] for e in art['errors']], ['第 3、5 页 / 共 6 页'])


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
