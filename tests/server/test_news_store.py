import os
import tempfile
import threading
import unittest
from pathlib import Path

from server.news_store import GLOSS_TTL, NewsStore


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

    def test_cleanup_removes_legacy_article_dirs_and_keeps_settings(self):
        news = Path(self.tmp.name) / 'news'
        legacy = news / 'b2c3d4e5f6a70819' / 'images'
        legacy.mkdir(parents=True)
        os.utime(legacy.parent, (self.clock.t, self.clock.t))  # young: removed anyway
        self.store.save_settings({'model': 'M'})
        self.store.cleanup()
        self.assertFalse(legacy.parent.exists())
        self.assertEqual(self.store.settings()['model'], 'M')
        self.assertTrue((news / 'glossary.sqlite').exists())

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
