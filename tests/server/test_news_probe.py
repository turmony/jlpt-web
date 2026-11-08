"""scripts/news_probe.py against the fake Yahoo (never the real site)."""
import unittest
from unittest import mock

from scripts import news_probe
from server.news_yahoo import FEEDS, Yahoo
from tests.server.news_fixture import ARTICLE_URL as A, PICKUP_URL as P, fake_fetch, load

RSS = 'https://news.yahoo.co.jp/rss/topics/%s.xml'
P2 = 'https://news.yahoo.co.jp/pickup/2'


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
        off_news = load('pickup').replace(b'https://news.yahoo.co.jp/articles/', b'https://search.yahoo.co.jp/x/')
        mapping = {RSS % 'top-picks': load('rss'), P: load('pickup'), A: load('single')}
        (ok, total, skipped), lines, sleeps = run(mapping)
        self.assertEqual((ok, total, skipped), (1, 2, 0))
        self.assertEqual(lines[0], news_probe.HEADER)
        self.assertTrue(lines[1].startswith('主要\t1/1\t'), lines[1])
        self.assertIn('成功', lines[1])
        self.assertIn('失败 stage=yahoo（抓取雅虎） reason=雅虎返回 404（话题页）', lines[2])
        self.assertEqual(lines[-1], '成功 1 / 共 2')
        self.assertEqual(sleeps, [0.5])  # articles are spaced like pages

        mapping[P2] = off_news
        (ok, total, skipped), lines, _ = run(mapping)
        self.assertEqual((ok, total, skipped), (1, 1, 1))
        self.assertIn('跳过 这条话题指向雅虎新闻以外的页面（search.yahoo.co.jp）', lines[2])
        self.assertEqual(lines[-1], '成功 1 / 共 1（跳过 1 篇：话题不指向雅虎新闻文章）')

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
        with mock.patch.object(news_probe, 'run', return_value=(1, 2, 0)):
            self.assertEqual(news_probe.main(['--per-feed', '1']), 1)
        self.assertEqual(set(FEEDS), {'top-picks', 'domestic', 'world', 'business', 'entertainment',
                                      'sports', 'it', 'science'})


if __name__ == '__main__':
    unittest.main()
