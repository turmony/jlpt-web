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
    def test_build_copies_pages_and_adds_navigation_without_linking_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for directory in ('scripts', 'web', 'mobile', 'data'):
                (root / directory).mkdir(parents=True)
            for name in ('scripts/build-server.mjs', 'scripts/build-core.mjs', 'mobile/core-markdown.jsx'):
                (root / name).write_bytes((ROOT / name).read_bytes())
            (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            for name, content in {'web/papers.html': 'papers', 'mobile/index.html': '<main class="shell">',
                                  'mobile/image-proxy.mjs': 'cloudflare only', 'data/catalog.json': '{}'}.items():
                (root / name).write_text(content)
            deployed = root / 'deployment/static'
            subprocess.run(['node', str(root / 'scripts/build-server.mjs'), str(deployed)], check=True, capture_output=True)
            self.assertEqual(safe_file(deployed, 'papers.html').read_text(), 'papers')
            self.assertFalse(os.path.samefile(deployed / 'papers.html', root / 'web/papers.html'))
            self.assertFalse((deployed / 'grammar/image-proxy.mjs').exists())
            self.assertTrue((deployed / 'grammar/core-markdown.mjs').is_file())
            page = (deployed / 'grammar/index.html').read_text()
            self.assertIn('<a href="/papers.html">做题</a><a href="/code/">云开发</a>', page)
