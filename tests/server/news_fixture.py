"""Helpers for the Yahoo News tests: fixtures wrapped in a page, and a fake fetch."""
import json
from pathlib import Path

DIR = Path(__file__).parent / 'news_fixtures'
ARTICLE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f9001122334'
ARTICLE_URL = 'https://news.yahoo.co.jp/articles/' + ARTICLE_ID
PICKUP_URL = 'https://news.yahoo.co.jp/pickup/1'


def load(name):
    """Bytes of a fixture. name.json is wrapped as a Yahoo page; .html/.xml are raw."""
    path = DIR / (name + '.json')
    if path.exists():
        state = json.dumps(json.loads(path.read_text('utf-8')), ensure_ascii=False)
        page = ('<!DOCTYPE html><html><head><title>t</title></head><body><div id="root"></div>'
                '<script>window.__PRELOADED_STATE__ = %s</script></body></html>' % state)
        return page.encode('utf-8')
    for ext in ('.html', '.xml'):
        if (DIR / (name + ext)).exists():
            return (DIR / (name + ext)).read_bytes()
    raise FileNotFoundError(name)


def fake_fetch(mapping):
    """A fetch(url) -> (status, bytes). Values may be (status, bytes) or an Exception to raise.
    Unmapped URLs answer 404; the real network is never touched."""
    def fetch(url):
        value = mapping.get(url, (404, b''))
        if isinstance(value, Exception):
            raise value
        if isinstance(value, bytes):
            return 200, value
        return value
    fetch.calls = []
    return fetch


class FakeResponse:
    """Enough of an HTTP response for Yahoo.image: status, headers, read(n), close()."""
    def __init__(self, status, body, headers=None, reads=None):
        self.status = status
        self.headers = dict(headers or {})
        self._body = body
        self._reads = reads if reads is not None else []

    def read(self, n=-1):
        self._reads.append(n)
        data = self._body if n is None or n < 0 else self._body[:n]
        self._body = self._body[len(data):]
        return data

    def close(self):
        pass


def fake_open(mapping):
    """An open_image(url) for Yahoo: values are bytes, (status, bytes), (status, bytes, headers)
    or an Exception to raise. Unmapped URLs answer 404. Records `calls` and `reads` (read sizes)."""
    def open_image(url):
        open_image.calls.append(url)
        value = mapping.get(url, (404, b''))
        if isinstance(value, Exception):
            raise value
        if isinstance(value, bytes):
            value = (200, value)
        return FakeResponse(value[0], value[1], value[2] if len(value) > 2 else None, open_image.reads)
    open_image.calls = []
    open_image.reads = []
    return open_image
