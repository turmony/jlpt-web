import hashlib
import hmac
import secrets
import time

YEAR = 365 * 86400


class Auth:
    def __init__(self, store, password_hash):
        self.store = store
        self.password_hash = password_hash

    @staticmethod
    def hash_password(password):
        salt = secrets.token_hex(16)
        digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
        return f'scrypt${salt}${digest}'

    def verify(self, password):
        _, salt, expected = self.password_hash.split('$')
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
        return hmac.compare_digest(actual, expected)

    @staticmethod
    def digest(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def login(self, password, now=None):
        if not isinstance(password, str) or len(password) > 1024 or not self.verify(password):
            return None
        token = secrets.token_urlsafe(32)
        with self.store.connect() as db:
            db.execute('INSERT INTO sessions VALUES (?,?)', (self.digest(token), (time.time() if now is None else now) + YEAR))
        return token

    def check(self, token, now=None):
        if not token or len(token) > 128:
            return False
        with self.store.connect() as db:
            row = db.execute('SELECT expires FROM sessions WHERE token=?', (self.digest(token),)).fetchone()
        return bool(row and row[0] > (time.time() if now is None else now))

    def logout(self, token):
        with self.store.connect() as db:
            db.execute('DELETE FROM sessions WHERE token=?', (self.digest(token),))
