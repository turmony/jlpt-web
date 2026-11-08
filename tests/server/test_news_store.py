import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from server import news_store
from server.news_errors import NewsError
from server.news_store import (ARTICLE_TTL, GLOSS_TTL, IMAGE_MAX, NewsStore, image_key)

AID = 'abcdef0123456789'


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.clock = Clock()
        self.store = NewsStore(Path(self.tmp.name), now=self.clock)

    def test_article_roundtrip_and_missing(self):
        self.store.save_article({'id': AID, 'title': 'タイトル'})
        self.assertEqual(self.store.load_article(AID)['title'], 'タイトル')
        with self.assertRaises(KeyError):
            self.store.load_article('00000000')

    def test_articles_expire_after_7_days(self):
        self.store.save_article({'id': AID, 'title': 't'})
        self.clock.t += ARTICLE_TTL
        self.assertEqual(self.store.load_article(AID)['title'], 't')
        self.clock.t += 1
        with self.assertRaises(KeyError):
            self.store.load_article(AID)
        self.store.cleanup()
        self.assertFalse((Path(self.tmp.name) / 'news' / AID).exists())

    def test_glossary_expires_after_30_days_and_is_keyed_by_model(self):
        self.store.glossary_put('m1', '走る', '動詞', 'run')
        self.store.glossary_put('m2', '走る', '動詞', 'dash')
        self.assertEqual(self.store.glossary_get('m1', '走る', '動詞'), 'run')
        self.assertEqual(self.store.glossary_get('m2', '走る', '動詞'), 'dash')
        self.assertIsNone(self.store.glossary_get('m3', '走る', '動詞'))
        self.assertIsNone(self.store.glossary_get('m1', '走る', '名詞'))
        self.clock.t += GLOSS_TTL + 1
        self.assertIsNone(self.store.glossary_get('m1', '走る', '動詞'))
        self.store.glossary_put('m2', '走る', '動詞', 'fresh')
        self.store.cleanup()
        self.assertEqual(self.store.glossary_get('m2', '走る', '動詞'), 'fresh')
        self.assertIsNone(self.store.glossary_get('m1', '走る', '動詞'))

    def test_total_size_cap_deletes_oldest_first(self):
        ids = ['a0000001', 'a0000002', 'a0000003']
        with mock.patch.object(news_store, 'TOTAL_MAX', 3000):
            for i in ids:
                self.store.save_article({'id': i, 'pad': 'x' * 1500})
                path = Path(self.tmp.name) / 'news' / i / 'article.json'
                self.assertGreater(path.stat().st_size, 1500)
                os.utime(path, (self.clock.t, self.clock.t))
                self.clock.t += 10
            self.store.cleanup()
        news = Path(self.tmp.name) / 'news'
        self.assertFalse((news / ids[0]).exists())
        self.assertFalse((news / ids[1]).exists())
        self.assertTrue((news / ids[2]).exists())

    def test_cap_counts_images(self):
        with mock.patch.object(news_store, 'TOTAL_MAX', 3000):
            self.store.save_article({'id': 'b0000001'})
            self.store.save_image('b0000001', 0, b'x' * 2990)
            self.clock.t += 10
            self.store.save_article({'id': 'b0000002'})
            self.store.cleanup()
        with self.assertRaises(KeyError):
            self.store.load_article('b0000001')
        self.assertTrue(self.store.load_article('b0000002'))

    def test_oversized_image_rejected_with_image_stage(self):
        self.store.save_article({'id': AID})
        with self.assertRaises(NewsError) as cm:
            self.store.save_image(AID, 1, b'x' * (IMAGE_MAX + 1))
        self.assertEqual(cm.exception.stage, 'image')
        self.assertEqual(cm.exception.reason, '图片超过 5 MB')
        self.assertEqual(cm.exception.location, '第 2 张')
        self.store.save_image(AID, 0, b'x' * IMAGE_MAX)
        self.assertEqual(self.store.image_path(AID, 0).stat().st_size, IMAGE_MAX)

    def test_images_saved_by_source_key_and_pruned(self):
        # Task 13: images are kept per source URL so a rebuilt article can re-index them.
        key = image_key('https://newsatcl-pctr.c.yimg.jp/t/a.jpg?exp=10800')
        self.assertRegex(key, r'^[0-9a-f]{40}$')
        self.assertEqual(key, image_key('https://newsatcl-pctr.c.yimg.jp/t/a.jpg?exp=10800'))
        self.assertNotEqual(key, image_key('https://newsatcl-pctr.c.yimg.jp/t/b.jpg?exp=10800'))
        other = image_key('https://newsatcl-pctr.c.yimg.jp/t/b.jpg')
        self.store.save_article({'id': AID})
        self.store.save_image(AID, key, b'a')
        self.store.save_image(AID, other, b'b')
        self.store.save_image(AID, 0, b'legacy')
        images = Path(self.tmp.name) / 'news' / AID / 'images'
        self.assertEqual(self.store.image_path(AID, key), images / key)
        self.assertEqual((images / key).read_bytes(), b'a')
        self.store.prune_images(AID, {key})
        self.assertEqual(sorted(p.name for p in images.iterdir()), [key])
        self.store.prune_images('abcdef0123456780', set())  # no such article: nothing to do
        with self.assertRaises(NewsError) as cm:
            self.store.save_image(AID, key, b'x' * (IMAGE_MAX + 1), '第 4 张')
        self.assertEqual((cm.exception.stage, cm.exception.location), ('image', '第 4 张'))
        for bad in ('A' * 40, 'a' * 39, '../' + 'a' * 37, key + '0'):
            with self.assertRaises(ValueError):
                self.store.image_path(AID, bad)

    def test_image_path_layout(self):
        p = self.store.image_path(AID, 3)
        self.assertEqual(p, Path(self.tmp.name) / 'news' / AID / 'images' / '3')

    def test_invalid_ids_and_index(self):
        for bad in ('../x', 'ABCDEF01', 'abc', 'g' * 8, 'a' * 65, '', 'abcdef01/..'):
            with self.assertRaises(ValueError):
                self.store.load_article(bad)
            with self.assertRaises(ValueError):
                self.store.image_path(bad, 0)
            with self.assertRaises(ValueError):
                self.store.save_image(bad, 0, b'x')
            with self.assertRaises(ValueError):
                self.store.save_article({'id': bad})
        for bad in (-1, '0', 1.5, None, True):
            with self.assertRaises(ValueError):
                self.store.image_path(AID, bad)

    def test_single_flight_runs_once(self):
        calls = []
        done = {}

        def work():
            with self.store.single_flight('k'):
                if 'v' not in done:
                    calls.append(1)
                    time.sleep(0.1)
                    done['v'] = 1

        ts = [threading.Thread(target=work) for _ in range(2)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(len(calls), 1)
        with self.store.single_flight('k'):
            pass

    def test_single_flight_different_keys_do_not_block(self):
        with self.store.single_flight('a'):
            got = []
            t = threading.Thread(target=lambda: (self.store.single_flight('b').__enter__(), got.append(1)))
            t.start()
            t.join(2)
            self.assertEqual(got, [1])

    def test_settings_default_and_roundtrip(self):
        self.assertEqual(self.store.settings(), {'model': None})
        self.store.save_settings({'model': 'GLM-5.3-Flash'})
        self.assertEqual(self.store.settings(), {'model': 'GLM-5.3-Flash'})
        self.assertEqual(NewsStore(Path(self.tmp.name)).settings(), {'model': 'GLM-5.3-Flash'})

    def test_concurrent_access_is_safe(self):
        errors = []

        def work(n):
            try:
                for i in range(30):
                    self.store.glossary_put('m', 'w%d' % n, 'p', str(i))
                    self.store.glossary_get('m', 'w%d' % n, 'p')
                    self.store.cleanup()
            except Exception as e:  # pragma: no cover
                errors.append(e)

        ts = [threading.Thread(target=work, args=(n,)) for n in range(4)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(errors, [])


if __name__ == '__main__':
    unittest.main()
