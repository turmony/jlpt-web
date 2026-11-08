"""scripts/news_probe.py against the fake Yahoo (never the real site)."""
import unittest
from unittest import mock

from scripts import news_probe
from server.news_yahoo import FEEDS, Yahoo
from tests.server.news_fixture import ARTICLE_URL as A, PICKUP_URL as P, fake_fetch, load

RSS = 'https://news.yahoo.co.jp/rss/topics/%s.xml'
P2 = 'https://news.yahoo.co.jp/pickup/2'
OFF_NEWS = load('pickup').replace(b'https://news.yahoo.co.jp/articles/', b'https://search.yahoo.co.jp/x/')


def rss(n):
    """A self-written RSS feed listing pickup/1 .. pickup/n."""
    items = ''.join('<item><title>見出し%d</title><link>https://news.yahoo.co.jp/pickup/%d</link></item>' % (i, i)
                    for i in range(1, n + 1))
    return ('<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>t</title>%s'
            '</channel></rss>' % items).encode('utf-8')


def pickup(i):
    return 'https://news.yahoo.co.jp/pickup/%d' % i


def fake_sentences(text, start_id):
    return [{'id': start_id, 'tokens': [{'s': text}]}] if text.strip() else []


def run(mapping, per_feed=2, feeds=('top-picks',)):
    lines, sleeps = [], []
    yahoo = Yahoo(fetch=fake_fetch(mapping), sleep=lambda s: None)
    with mock.patch.object(news_probe, 'to_sentences', fake_sentences):
        result = news_probe.run(yahoo, per_feed, out=lines.append, sleep=sleeps.append, feeds=list(feeds))
    return result, lines, sleeps


class ProbeTests(unittest.TestCase):
    def test_success_failure_skip_and_summary(self):
        mapping = {RSS % 'top-picks': load('rss'), P: load('pickup'), A: load('single')}
        (ok, total, skipped), lines, sleeps = run(mapping)
        self.assertEqual((ok, total, skipped), (1, 2, 0))
        self.assertEqual(lines[0], news_probe.HEADER)
        self.assertTrue(lines[1].startswith('主要\t1/1\t'), lines[1])
        self.assertIn('成功', lines[1])
        self.assertIn('失败 stage=yahoo（抓取雅虎） reason=雅虎返回 404（话题页）', lines[2])
        self.assertEqual(lines[-1], '成功 1 / 共 2；未通过：有 1 篇失败')
        self.assertEqual(sleeps, [0.5])  # articles are spaced like pages
        self.assertEqual(news_probe.verdict(ok, total, skipped), (False, '有 1 篇失败'))

    def test_a_few_skips_pass(self):
        mapping = {RSS % 'top-picks': rss(3), pickup(1): load('pickup'), pickup(2): load('pickup'),
                   pickup(3): OFF_NEWS, A: load('single')}
        (ok, total, skipped), lines, _ = run(mapping, per_feed=3)
        self.assertEqual((ok, total, skipped), (2, 2, 1))
        self.assertIn('跳过 这条话题指向雅虎新闻以外的页面（search.yahoo.co.jp）', lines[3])
        self.assertEqual(lines[-1], '成功 2 / 共 2（跳过 1 篇：话题不指向雅虎新闻文章）')
        self.assertEqual(news_probe.verdict(ok, total, skipped), (True, ''))

    def test_many_skips_fail(self):
        # 1 of 2 opened topics skipped (> 1/3): the topic page has probably changed.
        mapping = {RSS % 'top-picks': rss(2), pickup(1): load('pickup'), pickup(2): OFF_NEWS, A: load('single')}
        (ok, total, skipped), lines, _ = run(mapping)
        self.assertEqual((ok, total, skipped), (1, 1, 1))
        self.assertEqual(lines[-1], '成功 1 / 共 1（跳过 1 篇：话题不指向雅虎新闻文章）'
                                    '；未通过：跳过的话题超过三分之一（1 / 2），话题页可能改版')
        self.assertFalse(news_probe.verdict(ok, total, skipped)[0])

    def test_all_skipped_is_not_a_vacuous_pass(self):
        mapping = {RSS % 'top-picks': rss(2), RSS % 'it': rss(2), pickup(1): OFF_NEWS, pickup(2): OFF_NEWS}
        (ok, total, skipped), lines, _ = run(mapping, feeds=('top-picks', 'it'))
        self.assertEqual((ok, total, skipped), (0, 0, 4))
        self.assertEqual(lines[-1], '成功 0 / 共 0（跳过 4 篇：话题不指向雅虎新闻文章）；未通过：没有检查到任何文章')
        self.assertEqual(news_probe.verdict(0, 0, 0), (False, '没有检查到任何文章'))

    def test_empty_feed_fails_and_short_feed_prints_count(self):
        mapping = {RSS % 'top-picks': rss(0), RSS % 'it': rss(1), pickup(1): load('pickup'), A: load('single')}
        (ok, total, skipped), lines, _ = run(mapping, per_feed=3, feeds=('top-picks', 'it'))
        self.assertEqual((ok, total, skipped), (1, 4, 0))
        self.assertEqual(lines[1], '主要\t-\t-\t-\t-\t失败 stage=parse（解析正文） reason=列表为空（新闻列表）（计 3 篇失败）')
        self.assertEqual(lines[2], 'IT\t-\t-\t-\t-\t列表只有 1 篇（要求 3 篇）')
        self.assertTrue(lines[3].startswith('IT\t1/1\t'), lines[3])
        self.assertEqual(lines[-1], '成功 1 / 共 4；未通过：有 3 篇失败')

    def test_feed_failure_counts_planned_articles(self):
        (ok, total, skipped), lines, _ = run({}, per_feed=3, feeds=('top-picks', 'it'))
        self.assertEqual((ok, total, skipped), (0, 6, 0))
        self.assertIn('失败 stage=yahoo（抓取雅虎） reason=雅虎返回 404（新闻列表）（列表，计 3 篇失败）', lines[1])

    def test_image_hosts_counted_and_exit_code(self):
        mapping = {RSS % 'top-picks': load('rss'), P: load('pickup'), A: load('video')}
        _r, lines, _s = run(mapping, per_feed=1)
        cols = lines[1].split('\t')
        self.assertEqual((cols[2], cols[3]), ('2', '0'), lines[1])  # photo + video poster, both yimg.jp
        mapping[A] = load('video').replace(b'https://newsatcl-pctr.c.yimg.jp/t/test/poster1.jpg',
                                           b'https://cdn.example.com/poster1.jpg')
        _r, lines, _s = run(mapping, per_feed=1)
        self.assertEqual(lines[1].split('\t')[2:4], ['2', '1'], lines[1])
        with mock.patch.object(news_probe, 'run', return_value=(2, 2, 1)):
            self.assertEqual(news_probe.main(['--per-feed', '1']), 0)
        for result in ((1, 2, 0), (0, 0, 0), (0, 0, 3), (2, 2, 2)):
            with mock.patch.object(news_probe, 'run', return_value=result):
                self.assertEqual(news_probe.main(['--per-feed', '1']), 1, result)
        self.assertEqual(set(FEEDS), {'top-picks', 'domestic', 'world', 'business', 'entertainment',
                                      'sports', 'it', 'science'})


if __name__ == '__main__':
    unittest.main()
