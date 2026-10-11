"""Dependency sharing must preserve deployed files during a source reinstall."""
import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from server.artifacts import safe_file


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
    def test_local_build_aliases_chat_and_deployment_remains_independent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for directory in ('scripts', 'chat/dist/assets', 'web', 'mobile', 'data', 'vendor/aionui'):
                (root / directory).mkdir(parents=True)
            (root / 'scripts/build-server.mjs').write_bytes((ROOT / 'scripts/build-server.mjs').read_bytes())
            for name, content in {
                'chat/dist/chat.mjs': 'old chat', 'chat/dist/chat.css': 'old css',
                'chat/dist/assets/font.woff': 'font', 'chat/dist/chat.mjs.map': 'debug only',
                'chat/dist/uno-config.mjs': 'build only', 'vendor/aionui/LICENSE': 'license',
                'vendor/aionui/README.md': 'source', 'web/index.html': 'site',
                'mobile/index.html': '<main class="shell">', 'data/catalog.json': '{}',
            }.items():
                (root / name).write_text(content)
            subprocess.run(['node', str(root / 'scripts/build-server.mjs')], check=True, capture_output=True)
            local = root / 'server-public'
            self.assertEqual(safe_file(local, 'chat.mjs').read_text(), 'old chat')
            self.assertFalse((local / 'chat.mjs').is_symlink())
            self.assertTrue(os.path.samefile(local / 'chat.mjs', root / 'chat/dist/chat.mjs'))
            self.assertTrue(os.path.samefile(local / 'assets/font.woff', root / 'chat/dist/assets/font.woff'))
            self.assertFalse((local / 'chat.mjs.map').exists())
            self.assertFalse((local / 'uno-config.mjs').exists())
            deployed = root / 'deployment/static'
            subprocess.run(['node', str(root / 'scripts/build-server.mjs'), str(deployed)], check=True, capture_output=True)
            self.assertFalse((deployed / 'chat.mjs').is_symlink())
            (root / 'chat/dist/chat.mjs').write_text('new chat')
            self.assertEqual((local / 'chat.mjs').read_text(), 'new chat')
            self.assertEqual((deployed / 'chat.mjs').read_text(), 'old chat')
