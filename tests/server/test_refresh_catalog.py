import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.refresh_catalog import refresh

CARD = '---\n{\n  "id": "N5-G-0001",\n  "title": "～です（是）"\n}\n---\n\n# 核心\n\n## 功能一：是 A\n\n例句。\n\n# 来源\n\n链接\n'


class RefreshCatalogTests(unittest.TestCase):
    def make_repo(self, tmp, with_images=True):
        repo = Path(tmp)/'study'
        def git(*args): return subprocess.check_output(['git', '-C', str(repo), *args], text=True).strip()
        (repo/'jlpt-notes/grammar/n5').mkdir(parents=True)
        (repo/'jlpt-notes/grammar/n5/N5-G-0001.md').write_text(CARD, encoding='utf-8')
        (repo/'jlpt-notes/grammar/n5/README.txt').write_text('not a card')
        if with_images:
            (repo/'jlpt-notes/assets/grammar/n5').mkdir(parents=True)
            for kind in ('connection', 'example'):
                (repo/f'jlpt-notes/assets/grammar/n5/N5-G-0001-{kind}.png').write_bytes(b'png')
        git('init', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test')
        git('add', '.'); git('commit', '-m', 'cards')
        return repo, git('rev-parse', 'HEAD')

    def test_cards_titles_images_and_core_come_from_the_pinned_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, revision = self.make_repo(tmp)
            catalog = refresh(repo, 'HEAD', {'schema': 1, 'repository': 'o/r', 'revision': 'old', 'cards': []})
        self.assertEqual((catalog['schema'], catalog['repository'], catalog['revision']), (1, 'o/r', revision))
        self.assertEqual(catalog['cards'], [{
            'id': 'N5-G-0001', 'level': 'N5', 'number': 1, 'title': '～です（是）',
            'images': {'connection': f'./images/{revision}/assets/grammar/n5/N5-G-0001-connection.png',
                       'example': f'./images/{revision}/assets/grammar/n5/N5-G-0001-example.png'},
            'core': '## 功能一：是 A\n\n例句。'}])

    def test_a_card_missing_a_screenshot_stops_the_refresh(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, _ = self.make_repo(tmp, with_images=False)
            with self.assertRaises(subprocess.CalledProcessError):
                refresh(repo, 'HEAD', {'cards': []})
