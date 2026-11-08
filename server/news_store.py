"""Article, image, glossary and settings storage for the news reader, with expiry cleanup."""
import contextlib
import json
import os
import re
import shutil
import sqlite3
import threading
import time
from pathlib import Path

from server.news_errors import NewsError

ARTICLE_TTL = 7 * 86400
GLOSS_TTL = 30 * 86400
IMAGE_MAX = 5 * 1024 * 1024
TOTAL_MAX = 300 * 1024 * 1024

ID_RE = re.compile(r'[0-9a-f]{8,64}')
DEFAULT_SETTINGS = {'model': None}


def _check_id(article_id):
    if not isinstance(article_id, str) or not ID_RE.fullmatch(article_id):
        raise ValueError('invalid article id')
    return article_id


def _check_index(index):
    if type(index) is not int or index < 0:
        raise ValueError('invalid image index')
    return index


class NewsStore:
    def __init__(self, root, now=time.time):
        self.root = Path(root)
        self.dir = self.root / 'news'
        self.now = now
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._flights = {}
        self._flights_mutex = threading.Lock()
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

    def _article_dir(self, article_id):
        return self.dir / _check_id(article_id)

    # --- articles ------------------------------------------------------
    def save_article(self, article):
        article_id = _check_id(article.get('id'))
        path = self.dir / article_id / 'article.json'
        with self._lock:
            self._atomic_write(path, json.dumps(article, ensure_ascii=False).encode('utf-8'))
            stamp = self.now()
            os.utime(path, (stamp, stamp))

    def load_article(self, article_id):
        path = self._article_dir(article_id) / 'article.json'
        with self._lock:
            try:
                age = self.now() - path.stat().st_mtime
                if age > ARTICLE_TTL:
                    raise KeyError(article_id)
                return json.loads(path.read_text(encoding='utf-8'))
            except (FileNotFoundError, ValueError):
                raise KeyError(article_id) from None

    # --- images --------------------------------------------------------
    def image_path(self, article_id, index):
        return self._article_dir(article_id) / 'images' / str(_check_index(index))

    def save_image(self, article_id, index, data):
        path = self.image_path(article_id, index)
        if len(data) > IMAGE_MAX:
            raise NewsError('image', '图片超过 5 MB', '第 %d 张' % (index + 1))
        with self._lock:
            self._atomic_write(path, data)

    # --- single flight -------------------------------------------------
    @contextlib.contextmanager
    def single_flight(self, key):
        with self._flights_mutex:
            entry = self._flights.setdefault(key, [threading.Lock(), 0])
            entry[1] += 1
        entry[0].acquire()
        try:
            yield
        finally:
            entry[0].release()
            with self._flights_mutex:
                entry[1] -= 1
                if entry[1] == 0:
                    self._flights.pop(key, None)

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
    @staticmethod
    def _dir_size(path):
        total = 0
        for base, _dirs, files in os.walk(path):
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(base, name))
                except OSError:
                    pass
        return total

    def cleanup(self):
        with self._lock:
            now = self.now()
            articles = []
            for entry in self.dir.iterdir():
                if not entry.is_dir() or not ID_RE.fullmatch(entry.name):
                    continue
                marker = entry / 'article.json'
                try:
                    mtime = (marker if marker.exists() else entry).stat().st_mtime
                except OSError:
                    continue
                if now - mtime > ARTICLE_TTL:
                    shutil.rmtree(entry, ignore_errors=True)
                else:
                    articles.append((mtime, entry.name, entry))
            articles.sort()
            sizes = {e: self._dir_size(e) for _, _, e in articles}
            total = sum(sizes.values())
            for _mtime, _name, entry in articles:
                if total <= TOTAL_MAX:
                    break
                shutil.rmtree(entry, ignore_errors=True)
                total -= sizes[entry]
            with self._db() as db:
                db.execute('DELETE FROM glossary WHERE ts < ?', (now - GLOSS_TTL,))
