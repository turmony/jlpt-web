"""Dependency sharing must preserve deployed files during a source reinstall."""
import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from server.papers import safe_file


ROOT = Path(__file__).resolve().parents[2]


class DependencyStorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = Path(self.tmp.name) / 'source'
        self.deployed = Path(self.tmp.name) / 'deployed'
        for app in (self.source, self.deployed):
            (app / 'node_modules/pkg').mkdir(parents=True)
            (app / 'package-lock.json').write_text('same lock')
            (app / 'node_modules/pkg/runtime.js').write_text('same runtime')
            (app / 'node_modules/.bin').mkdir()
            (app / 'node_modules/.bin/tool').symlink_to('../pkg/runtime.js')

    def share(self, **kwargs):
        path = ROOT / 'scripts/share-dependencies.py'
        self.assertTrue(path.is_file(), 'dependency sharing command is missing')
        spec = importlib.util.spec_from_file_location('share_dependencies', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.share(self.source, self.deployed, **kwargs)

    def test_share_preserves_real_directories_and_source_reinstall_keeps_deployment(self):
        source_file = self.source / 'node_modules/pkg/runtime.js'
        deployed_file = self.deployed / 'node_modules/pkg/runtime.js'
        self.share(apply=True)
        self.assertFalse((self.source / 'node_modules').is_symlink())
        self.assertEqual(source_file.stat().st_ino, deployed_file.stat().st_ino)
        source_file.unlink()
        source_file.write_text('new source dependency')
        self.assertEqual(deployed_file.read_text(), 'same runtime')
        self.assertEqual(os.readlink(self.source / 'node_modules/.bin/tool'), '../pkg/runtime.js')

    def test_default_preview_does_not_change_files(self):
        before = (self.source / 'node_modules/pkg/runtime.js').stat().st_ino
        self.share()
        self.assertEqual((self.source / 'node_modules/pkg/runtime.js').stat().st_ino, before)

    def test_mismatched_lock_or_file_is_rejected_before_any_changes(self):
        good = self.source / 'node_modules/pkg/runtime.js'
        for mismatch in ('package-lock.json', 'node_modules/pkg/other.js'):
            with self.subTest(mismatch=mismatch):
                for app in (self.source, self.deployed):
                    (app / 'package-lock.json').write_text('same lock')
                    (app / 'node_modules/pkg/other.js').write_text('same other file')
                (self.deployed / mismatch).write_text('different')
                before = good.stat().st_ino
                with self.assertRaises(ValueError):
                    self.share(apply=True)
                self.assertEqual(good.stat().st_ino, before)


class StaticStorageTests(unittest.TestCase):
    MARKER = 'copied-tree-marker-7f3a'

    def source_tree(self, root):
        """A minimal copy of the repository that build-server.mjs can build on its own."""
        for directory in ('scripts', 'web', 'mobile', 'data'):
            (root / directory).mkdir(parents=True)
        for name in ('scripts/build-server.mjs', 'scripts/build-core.mjs', 'scripts/build-news-client.mjs',
                     'mobile/core-markdown.jsx'):
            (root / name).write_bytes((ROOT / name).read_bytes())
        (root / 'news-client').mkdir()
        for source in (ROOT / 'news-client').iterdir():
            if source.is_file():
                (root / 'news-client' / source.name).write_bytes(source.read_bytes())
        # Proves the build bundles this tree's client, not the one in the current directory.
        with (root / 'news-client/main.mjs').open('a') as main:
            main.write("\nglobalThis.__buildMarker = '%s';\n" % self.MARKER)
        (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        for name, content in {'web/papers.html': 'papers', 'mobile/index.html': '<main class="shell">',
                              'mobile/image-proxy.mjs': 'cloudflare only', 'data/catalog.json': '{}'}.items():
            (root / name).write_text(content)

    def test_build_copies_pages_and_adds_navigation_without_linking_sources(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as elsewhere:
            root = Path(tmp)
            self.source_tree(root)
            deployed = root / 'deployment/static'
            subprocess.run(['node', str(root / 'scripts/build-server.mjs'), str(deployed)], check=True,
                           capture_output=True, cwd=elsewhere)
            self.assertEqual(safe_file(deployed, 'papers.html').read_text(), 'papers')
            self.assertFalse(os.path.samefile(deployed / 'papers.html', root / 'web/papers.html'))
            self.assertFalse((deployed / 'grammar/image-proxy.mjs').exists())
            self.assertTrue((deployed / 'grammar/core-markdown.mjs').is_file())
            client = (deployed / 'news-script/client.js').read_text()
            self.assertIn('JLPT_NEWS', client)
            self.assertIn(self.MARKER, client)
            page = (deployed / 'grammar/index.html').read_text()
            self.assertIn('<a href="/review/">今日安排</a><a href="/papers.html">做题</a>', page)
            self.assertNotIn('/code/', page)


class NewsClientBuildTests(unittest.TestCase):
    def test_repository_build_works_from_another_directory(self):
        with tempfile.TemporaryDirectory() as elsewhere, tempfile.TemporaryDirectory() as out:
            done = subprocess.run(['node', str(ROOT / 'scripts/build-server.mjs'), out], capture_output=True,
                                  text=True, cwd=elsewhere)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn('JLPT_NEWS', (Path(out) / 'news-script/client.js').read_text())

    def test_failed_client_build_exits_loudly_and_leaves_no_stale_client(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as elsewhere:
            root = Path(tmp)
            StaticStorageTests().source_tree(root)
            (root / 'news-client/main.mjs').write_text('import {missing} from "./nowhere.mjs";\n')
            deployed = root / 'deployment/static'
            (deployed / 'news-script').mkdir(parents=True)
            (deployed / 'news-script/client.js').write_text('stale JLPT_NEWS build')
            done = subprocess.run(['node', str(root / 'scripts/build-server.mjs'), str(deployed)],
                                  capture_output=True, text=True, cwd=elsewhere)
            self.assertNotEqual(done.returncode, 0)
            self.assertIn('news-script/client.js', done.stderr)
            self.assertFalse((deployed / 'news-script/client.js').exists())
