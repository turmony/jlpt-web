"""Per-device bearer tokens for the news userscript. Only a SHA-256 digest of each token is kept on disk."""
import hashlib
import hmac
import json
import os
import secrets
import sys
import threading
import time
import unicodedata
from pathlib import Path

MAX_DEVICES = 10
NAME_MAX = 20
TOUCH_INTERVAL = 600
FILE_NAME = 'devices.json'


def _digest(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def _valid(data):
    """The device list of a parsed devices.json; ValueError when it has any other shape."""
    devices = data.get('devices') if isinstance(data, dict) else None
    if not isinstance(devices, list):
        raise ValueError('no device list')
    for d in devices:
        if not isinstance(d, dict) or not all(isinstance(d.get(k), str) for k in ('id', 'name', 'hash')) \
                or not isinstance(d.get('installed'), (int, float)) \
                or not (d.get('last_used') is None or isinstance(d.get('last_used'), (int, float))):
            raise ValueError('bad device record')
    return devices


def _clean_name(name):
    name = name.strip()
    if not 1 <= len(name) <= NAME_MAX or '/' in name or any(
            unicodedata.category(ch) == 'Cc' for ch in name):
        raise ValueError('设备名称为 1–20 字，不能含 /')
    return name


class DeviceStore:
    def __init__(self, path, now=time.time):
        self.dir = Path(path)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.file = self.dir / FILE_NAME
        self.now = now
        self.lock = threading.Lock()

    def _load(self):
        try:
            text = self.file.read_text(encoding='utf-8')
        except FileNotFoundError:
            return []
        try:
            return _valid(json.loads(text))
        except ValueError as error:  # JSONDecodeError and UnicodeDecodeError are ValueErrors too
            self._set_aside(error)
            return []

    def _set_aside(self, error):
        """Keep an unreadable devices.json for diagnosis and start empty: every device must reinstall."""
        stamp = time.strftime('%Y%m%d-%H%M%S', time.localtime(self.now()))
        aside = self.dir / f'{FILE_NAME}.corrupt-{stamp}'
        n = 1
        while aside.exists():
            n += 1
            aside = self.dir / f'{FILE_NAME}.corrupt-{stamp}-{n}'
        os.replace(self.file, aside)
        sys.stderr.write('news devices: %s is unreadable (%s), moved to %s; every device must reinstall\n'
                         % (FILE_NAME, type(error).__name__, aside.name))
        sys.stderr.flush()

    def _save(self, devices):
        tmp = self.file.with_name(FILE_NAME + '.tmp')
        tmp.write_text(json.dumps({'devices': devices}, ensure_ascii=False), encoding='utf-8')
        os.replace(tmp, self.file)

    @staticmethod
    def _public(record):
        return {'id': record['id'], 'name': record['name'],
                'installed': record['installed'], 'last_used': record['last_used']}

    def install(self, name):
        name = _clean_name(name)
        with self.lock:
            devices = [d for d in self._load() if d['name'] != name]
            if len(devices) >= MAX_DEVICES:
                raise ValueError('设备已满 10 台，请先作废不用的设备')
            token = secrets.token_urlsafe(32)
            record = {'id': secrets.token_hex(8), 'name': name, 'installed': self.now(),
                      'last_used': None, 'hash': _digest(token)}
            devices.append(record)
            self._save(devices)
            return self._public(record), token

    def check(self, token):
        if not isinstance(token, str) or not token:
            return None
        digest = _digest(token)
        with self.lock:
            devices = self._load()
            for record in devices:
                if hmac.compare_digest(record['hash'], digest):
                    now = self.now()
                    last = record['last_used'] if record['last_used'] is not None else record['installed']
                    if now - last >= TOUCH_INTERVAL:
                        record['last_used'] = now
                        self._save(devices)
                    return record['id']
            return None

    def revoke(self, device_id):
        with self.lock:
            devices = self._load()
            kept = [d for d in devices if d['id'] != device_id]
            if len(kept) == len(devices):
                raise KeyError(device_id)
            self._save(kept)

    def list(self) -> 'list':
        with self.lock:
            devices = sorted(self._load(), key=lambda d: d['installed'])
            return [self._public(d) for d in devices]
