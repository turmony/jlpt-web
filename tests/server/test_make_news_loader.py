"""scripts/make_news_loader.py writes a loader whose file name carries the loader version."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from server.news_sites import LOADER_VERSION, loader_script, sites

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / 'scripts' / 'make_news_loader.py'
ORIGIN = 'https://jlpt.example'


class MakeLoaderTests(unittest.TestCase):
    def make(self, tmp, *extra):
        config = Path(tmp) / 'config.json'
        config.write_text(json.dumps({'origin': ORIGIN, 'password_hash': 'secret-must-not-leak'}), encoding='utf-8')
        done = subprocess.run([sys.executable, str(SCRIPT), '--config', str(config), *extra],
                              capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done

    def test_explicit_out_is_used_as_given_and_matches_the_served_loader(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'out' / 'custom.user.js'
            done = self.make(tmp, '--out', str(out))
            self.assertEqual(out.read_text(encoding='utf-8'), loader_script(ORIGIN, sites({}), debug=True))
            self.assertNotIn('secret-must-not-leak', done.stdout + done.stderr + out.read_text(encoding='utf-8'))
            self.assertIn(out.name, done.stdout)

    def test_default_output_is_named_after_the_version_and_drops_older_copies(self):
        build = ROOT / 'build'
        existed = build.exists()
        stale = build / 'jlpt-news-v1.user.js'
        try:
            build.mkdir(exist_ok=True)
            stale.write_text('old', encoding='utf-8')
            with tempfile.TemporaryDirectory() as tmp:
                self.make(tmp)
            self.assertTrue((build / f'jlpt-news-v{LOADER_VERSION}.user.js').is_file())
            self.assertFalse(stale.exists())
        finally:
            stale.unlink(missing_ok=True)
            if not existed:
                for f in build.glob('*'):
                    f.unlink()
                build.rmdir()


if __name__ == '__main__':
    unittest.main()
