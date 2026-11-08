"""Helpers for the Yahoo News tests: fixtures wrapped in a page, and a fake fetch."""
import json
from pathlib import Path

DIR = Path(__file__).parent / 'news_fixtures'
ARTICLE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f9001122334'
ARTICLE_URL = 'https://news.yahoo.co.jp/articles/' + ARTICLE_ID
PICKUP_URL = 'https://news.yahoo.co.jp/pickup/1'


def wrap(state):
    """A Yahoo-like page carrying `state` as window.__PRELOADED_STATE__."""
    page = ('<!DOCTYPE html><html><head><title>t</title></head><body><div id="root"></div>'
            '<script>window.__PRELOADED_STATE__ = %s</script></body></html>'
            % json.dumps(state, ensure_ascii=False))
    return page.encode('utf-8')


def load(name):
    """Bytes of a fixture. name.json is wrapped as a Yahoo page; .html/.xml are raw."""
    path = DIR / (name + '.json')
    if path.exists():
        return wrap(json.loads(path.read_text('utf-8')))
    for ext in ('.html', '.xml'):
        if (DIR / (name + ext)).exists():
            return (DIR / (name + ext)).read_bytes()
    raise FileNotFoundError(name)


def article_page(n, total, image=None, current=None):
    """Self-written page n of a `total`-page article: one paragraph 「第n頁の本文。」 and, with
    `image`, one image (caption 「写真n」). `current` overrides the page's own currentPage."""
    items = [{'type': 'image', 'caption': '写真%d' % n, 'credit': '', 'resizedViewUrl': {'jpeg': image}}] if image else []
    return wrap({'articleDetail': {
        'headline': '複数ページの見出し', 'media': {'mediaName': 'テスト通信'},
        'createDateTime': '2026-11-08T15:30:00+09:00', 'author': '記者 太郎',
        'currentPage': n if current is None else current, 'maxPage': total,
        'paragraphs': [{'head': '', 'textDetails': [{'text': '第%d頁の本文。' % n}], 'objectItems': items}]}})


def article_pages(total, upto=None, images=None):
    """{url: page} for pages 1..min(total, upto) of ARTICLE_URL; images maps page -> image src."""
    images = images or {}
    out = {}
    for n in range(1, min(total, upto or total) + 1):
        out[ARTICLE_URL if n == 1 else '%s?page=%d' % (ARTICLE_URL, n)] = (200, article_page(n, total, images.get(n)))
    return out


def fake_fetch(mapping):
    """A fetch(url) -> (status, bytes). Values may be (status, bytes) or an Exception to raise,
    or a list of those answered in turn (the last one repeats). Unmapped URLs answer 404; the
    real network is never touched. Every requested url is recorded in `calls`."""
    def fetch(url):
        fetch.calls.append(url)
        value = mapping.get(url, (404, b''))
        if isinstance(value, list):
            value = value.pop(0) if len(value) > 1 else value[0]
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
