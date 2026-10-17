import tempfile
import unittest
from pathlib import Path

from server.auth import Auth
from server.store import Store


class StateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'state.sqlite'
        self.store = Store(self.path)

    def test_password_and_session_survive_restart_and_revoke(self):
        auth = Auth(self.store, Auth.hash_password('a long password'))
        self.assertIsNone(auth.login('wrong'))
        token = auth.login('a long password')
        self.assertNotIn(token, self.path.read_bytes().decode(errors='ignore'))
        restarted = Auth(Store(self.path), auth.password_hash)
        self.assertTrue(restarted.check(token))
        restarted.logout(token)
        self.assertFalse(auth.check(token))
        token = auth.login('a long password', now=100)
        self.assertFalse(auth.check(token, now=100 + 366 * 86400))
