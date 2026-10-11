import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('prepare_release', Path(__file__).resolve().parents[2]/'scripts/prepare_release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_new_release_reuses_dependencies_and_images_but_keeps_mutable_assets_independent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, base = root/'source', root/'site'
            source.mkdir();base.mkdir()
            current = base/'releases'/'previous'
            app, static = current/'app', current/'static'
            (app/'node_modules').mkdir(parents=True)
            (app/'node_modules'/'runtime.js').write_text('installed runtime')
            (app/'package-lock.json').write_text('same dependency versions')
            (source/'package-lock.json').write_text('same dependency versions')
            (source/'server.py').write_text('new application')
            (static/'grammar'/'images').mkdir(parents=True)
            image = static/'grammar'/'images'/'lesson.png';image.write_bytes(b'course image')
            (static/'index.html').write_text('old website')
            (base/'app').symlink_to(app);(base/'static').symlink_to(static)
            new = release.prepare(source, base, 'new')
            (new/'static'/'index.html').write_text('new website')
            self.assertEqual((static/'index.html').read_text(), 'old website')
            self.assertEqual((new/'app'/'node_modules'/'runtime.js').read_text(), 'installed runtime')
            self.assertEqual((app/'node_modules').resolve(), (new/'app'/'node_modules').resolve())
            self.assertEqual(image.stat().st_ino, (new/'static'/'grammar'/'images'/'lesson.png').stat().st_ino)
