"""Glossary and settings storage for the news reader, with expiry cleanup."""
import contextlib
import json
import os
import re
import shutil
import sqlite3
import threading
import time
from pathlib import Path

GLOSS_TTL = 30 * 86400

ID_RE = re.compile(r'[0-9a-f]{8,64}')   # names of the article folders older versions kept
DEFAULT_PROVIDER = 'codebuddy'
DEFAULT_SETTINGS = {'provider': DEFAULT_PROVIDER, 'models': {}, 'efforts': {}, 'model': None}


class NewsStore:
    def __init__(self, root, now=time.time):
        self.root = Path(root)
        self.dir = self.root / 'news'
        self.now = now
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db_path = self.dir / 'glossary.sqlite'
        with self._db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS glossary ('
                       'model TEXT NOT NULL, lemma TEXT NOT NULL, pos TEXT NOT NULL, '
                       'meaning TEXT NOT NULL, ts REAL NOT NULL, PRIMARY KEY (model, lemma, pos))')

    # --- helpers -------------------------------------------------------
    @contextlib.contextmanager
    def _db(self):
        with self._lock:
            conn = sqlite3.connect(str(self._db_path), timeout=10)
            try:
                with conn:
                    yield conn
            finally:
                conn.close()

    def _atomic_write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name('%s.%d.%d.tmp' % (path.name, os.getpid(), threading.get_ident()))
        try:
            tmp.write_bytes(data)
            os.replace(tmp, path)
        finally:
            if tmp.exists():
                tmp.unlink()

    # --- glossary ------------------------------------------------------
    def glossary_get(self, model, lemma, pos):
        with self._db() as db:
            row = db.execute('SELECT meaning, ts FROM glossary WHERE model=? AND lemma=? AND pos=?',
                             (model, lemma, pos)).fetchone()
        if row is None or self.now() - row[1] > GLOSS_TTL:
            return None
        return row[0]

    def glossary_put(self, model, lemma, pos, meaning):
        with self._db() as db:
            db.execute('INSERT OR REPLACE INTO glossary (model, lemma, pos, meaning, ts) '
                       'VALUES (?, ?, ?, ?, ?)', (model, lemma, pos, meaning, self.now()))

    # --- settings ------------------------------------------------------
    def settings(self):
        with self._lock:
            try:
                data = json.loads((self.dir / 'settings.json').read_text(encoding='utf-8'))
            except (FileNotFoundError, ValueError):
                data = {}
        out = {'provider': DEFAULT_PROVIDER, 'models': {}, 'efforts': {}, 'model': None}
        if isinstance(data, dict):
            if isinstance(data.get('provider'), str) and data['provider']:
                out['provider'] = data['provider']
            if isinstance(data.get('models'), dict):
                out['models'] = {
                    str(k): v for k, v in data['models'].items()
                    if isinstance(k, str) and k and isinstance(v, str) and v
                }
            if isinstance(data.get('efforts'), dict):
                efforts = {}
                for pid, inner in data['efforts'].items():
                    if isinstance(pid, str) and pid and isinstance(inner, dict):
                        cleaned = {
                            mid: eff for mid, eff in inner.items()
                            if isinstance(mid, str) and mid and isinstance(eff, str) and eff
                        }
                        if cleaned:
                            efforts[pid] = cleaned
                out['efforts'] = efforts
            if isinstance(data.get('model'), str) and data['model']:
                out['model'] = data['model']
        return out

    def save_settings(self, settings):
        with self._lock:
            self._atomic_write(self.dir / 'settings.json',
                               json.dumps(settings, ensure_ascii=False).encode('utf-8'))

    # --- cleanup -------------------------------------------------------
    def cleanup(self):
        """Delete the article folders older versions left under news/, then expire old glosses."""
        with self._lock:
            for entry in self.dir.iterdir():
                if entry.is_dir() and ID_RE.fullmatch(entry.name):
                    shutil.rmtree(entry, ignore_errors=True)
            with self._db() as db:
                db.execute('DELETE FROM glossary WHERE ts < ?', (self.now() - GLOSS_TTL,))
