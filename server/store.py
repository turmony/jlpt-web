import sqlite3
from contextlib import contextmanager


class Conflict(ValueError):
    pass


class Store:
    """Login sessions. Older databases keep their unused agent-task tables untouched."""

    def __init__(self, path):
        self.path = str(path)
        with self.connect() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires REAL);
            ''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()
