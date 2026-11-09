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
DEFAULT_SETTINGS = {'model': None}


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
        out = dict(DEFAULT_SETTINGS)
        if isinstance(data, dict):
            out.update(data)
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
