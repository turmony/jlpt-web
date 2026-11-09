import hashlib
import os
import tempfile
import unittest
from pathlib import Path

from server.news_devices import DeviceStore


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t


class DeviceTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.clock = Clock()
        self.store = DeviceStore(self.dir, now=self.clock)

    def test_install_returns_token_and_stores_only_its_hash(self):
        device, token = self.store.install('iPad')
        self.assertEqual(self.store.check(token), device['id'])
        raw = (self.dir / 'devices.json').read_text()
        self.assertNotIn(token, raw)
        self.assertIn(hashlib.sha256(token.encode()).hexdigest(), raw)

    def test_two_devices_work_and_revoking_one_keeps_the_other(self):
        ipad, ipad_token = self.store.install('iPad')
        _, phone_token = self.store.install('iPhone')
        self.assertIsNotNone(self.store.check(ipad_token))
        self.assertIsNotNone(self.store.check(phone_token))
        self.store.revoke(ipad['id'])
        self.assertIsNone(self.store.check(ipad_token))
        self.assertIsNotNone(self.store.check(phone_token))

    def test_same_name_reinstall_replaces_only_that_device(self):
        _, old_ipad_token = self.store.install('iPad')
        _, phone_token = self.store.install('iPhone')
        new_ipad, new_ipad_token = self.store.install('iPad')
        self.assertIsNone(self.store.check(old_ipad_token))
        self.assertEqual(self.store.check(new_ipad_token), new_ipad['id'])
        self.assertIsNotNone(self.store.check(phone_token))
        self.assertEqual(len(self.store.list()), 2)

    def test_eleventh_device_is_refused(self):
        for i in range(10):
            self.store.install(f'device{i}')
        with self.assertRaises(ValueError) as ctx:
            self.store.install('第11台')
        self.assertIn('设备已满 10 台', str(ctx.exception))

    def test_name_rules(self):
        for bad in ['', '   ', 'a/b', 'x' * 21, 'a\nb']:
            with self.subTest(name=bad):
                with self.assertRaises(ValueError):
                    self.store.install(bad)
        device, _ = self.store.install(' 我的iPad ')
        self.assertEqual(device['name'], '我的iPad')
        device, _ = self.store.install('📱')
        self.assertEqual(device['name'], '📱')

    def test_last_used_is_written_at_most_every_ten_minutes(self):
        device, token = self.store.install('iPad')
        path = self.dir / 'devices.json'
        self.assertIsNone(self.store.list()[0]['last_used'])

        # Pin the mtime so the check does not depend on filesystem timestamp granularity.
        os.utime(path, ns=(0, 0))

        self.clock.t = 1100.0
        self.assertEqual(self.store.check(token), device['id'])
        self.assertIsNone(self.store.list()[0]['last_used'])
        self.assertEqual(path.stat().st_mtime_ns, 0)

        self.clock.t = 1700.0
        self.assertEqual(self.store.check(token), device['id'])
        self.assertEqual(self.store.list()[0]['last_used'], 1700)
        self.assertNotEqual(path.stat().st_mtime_ns, 0)

    def test_unknown_or_malformed_token_is_none(self):
        self.store.install('iPad')
        for bad in ['', 'x', None]:
            with self.subTest(token=bad):
                self.assertIsNone(self.store.check(bad))

    def test_list_has_no_secrets(self):
        self.store.install('iPad')
        self.store.install('iPhone')
        for item in self.store.list():
            self.assertEqual(set(item.keys()), {'id', 'name', 'installed', 'last_used'})


if __name__ == '__main__':
    unittest.main()
