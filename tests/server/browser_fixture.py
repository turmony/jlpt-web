import json
import os
import sys
import time
from pathlib import Path
from server.app import Application, create_server
from server.auth import Auth
from server.llm import Hub
from server.news import NewsService
import server.news as news_module
from server.news_text import split_sentences
from server.news_yahoo import FEEDS, Yahoo
from tests.server.fake_hub import FakeHub
from tests.server.news_fixture import ARTICLE_URL, PICKUP_URL, fake_fetch, fake_open, load
from tests.server.review_fixture import COMPARE, make_study

PAPER = '''# 测试试卷

## 第一部分

### 1. 入院（　）、毎日運動しようと思った。

1. を契機に
2. を問わず
3. を除いて
4. をはじめ

### 2. 先生は来年 ＿＿ ★ ＿＿ ＿＿ そうだ。

1. アメリカの
2. 講演に
3. 大学から
4. 招かれる

## 答案填写区

```text
1-__, 2-__
```
'''

base = Path(sys.argv[1])
# A study repository with the plan's first unit prepared, plus one regular paper.
make_study(base)
unit_json = base / 'study/jlpt-notes/groups/units/B-01-1.json'
unit_json.write_text(json.dumps({**json.loads(unit_json.read_text()), 'compare': COMPARE}, ensure_ascii=False))
papers = base / 'study/jlpt-notes/quizzes/papers'
(papers / '2026-10-14-test.md').write_text(PAPER)
app = Application({'state': str(base), 'study': str(base / 'study'), 'static': str(Path('server-public').resolve()),
                   'origin': 'http://127.0.0.1', 'secure_cookie': False,
                   'password_hash': Auth.hash_password('browser-test-password')})


# ---- Reader article: self-written text, three pages, images, two videos and an unknown block ----
READER_ID = 'b2c3d4e5f6a7081929304a5b6c7d8e9f00112233'
READER_URL = 'https://news.yahoo.co.jp/articles/' + READER_ID
IMAGE_HOST = 'https://newsatcl-pctr.c.yimg.jp/t/reader/'


def _png():
    """A 2x2 opaque PNG, so <img> really decodes in the browser."""
    import struct
    import zlib

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    raw = b''.join(b'\x00' + b'\x80\x60\x20' * 2 for _ in range(2))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 2, 2, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def _reader_page(n, paragraphs, rich_extra=None):
    """A Yahoo article page (as news_fixture.load would wrap it) from (head, text, images) tuples."""
    rich = []
    items = []
    for head, text, images in paragraphs:
        items.append({'head': head, 'textDetails': [{'text': text}],
                      'objectItems': [{'type': 'image', 'caption': caption, 'credit': credit,
                                       'resizedViewUrl': {'jpeg': IMAGE_HOST + name}}
                                      for name, caption, credit in images]})
        rich.append({'tagName': 'yjrf-paragraph', 'children': [{'tagName': 'p', 'children': [text]}]})
        rich.extend((rich_extra or {}).get(len(rich), []))
    state = {'articleDetail': {'headline': '台風が島に接近', 'media': {'mediaName': 'テスト通信'},
                               'createDateTime': '2026-11-08T15:30:00+09:00', 'author': '記者 太郎',
                               'currentPage': n, 'maxPage': 3, 'paragraphs': items,
                               'richBody': {'tagName': 'yjrf-article', 'children': rich}}}
    page = ('<!DOCTYPE html><html><head><title>t</title></head><body><div id="root"></div>'
            '<script>window.__PRELOADED_STATE__ = %s</script></body></html>' % json.dumps(state, ensure_ascii=False))
    return page.encode('utf-8')


READER_PAGES = {
    1: _reader_page(1, [
        ('台風の接近', '台風は強い勢力で島に接近するおそれがあります。気象庁は早めの準備を呼びかけました。',
         [('photo1.jpg', '港に並ぶ船。', 'テスト提供')]),
        ('', '10日(火)から11日(水)にかけて雨が降ります。', []),
    ], rich_extra={1: [
        {'tagName': 'yjrf-yvp', 'attributes': {'src': 'https://news.yahoo.co.jp/video/reader/1', 'poster': IMAGE_HOST + 'poster1.jpg'}},
        {'tagName': 'yjrf-yvp', 'attributes': {'src': 'https://news.yahoo.co.jp/video/reader/2'}},
        {'tagName': 'yjrf-table', 'children': [{'tagName': 'p', 'children': ['表']}]},
    ]}),
    2: _reader_page(2, [('', '%d番目の段落です。町の人々は静かに過ごしています。' % n, []) for n in range(1, 31)]),
    3: _reader_page(3, [('', '最後の段落の文です。', [])]),
}

# Readings for the words the browser tests tap; everything else is cut by character class.
WORDS = {
    '台風': ('たいふう', '名詞'), 'は': ('は', '助詞'), '強い': ('つよい', '形容詞'), '勢力': ('せいりょく', '名詞'),
    'で': ('で', '助詞'), '島': ('しま', '名詞'), 'に': ('に', '助詞'), '接近': ('せっきん', '名詞'),
    'する': ('する', '動詞'), 'おそれ': ('おそれ', '名詞'), 'が': ('が', '助詞'), 'あり': ('あり', '動詞', 'ある'),
    'ます': ('ます', '助動詞'), '気象庁': ('きしょうちょう', '名詞'), '早め': ('はやめ', '名詞'), 'の': ('の', '助詞'),
    '準備': ('じゅんび', '名詞'), 'を': ('を', '助詞'), '呼びかけ': ('よびかけ', '動詞', '呼びかける'),
    'まし': ('まし', '助動詞', 'ます'), 'た': ('た', '助動詞'), '港': ('みなと', '名詞'), '並ぶ': ('ならぶ', '動詞'),
    '船': ('ふね', '名詞'), '日': ('にち', '名詞'), 'から': ('から', '助詞'), 'にかけて': ('にかけて', '助詞'),
    '雨': ('あめ', '名詞'), '降り': ('ふり', '動詞', '降る'), '最後': ('さいご', '名詞'), '段落': ('だんらく', '名詞'),
    '文': ('ぶん', '名詞'), 'です': ('です', '助動詞'),
}


def _kind(ch):
    if ch.isdigit():
        return 'digit'
    if '\u3041' <= ch <= '\u309f':
        return 'hiragana'
    if '\u30a0' <= ch <= '\u30ff':
        return 'katakana'
    if '\u4e00' <= ch <= '\u9fff' or ch in '々〆':
        return 'kanji'
    if ch.isalpha():
        return 'latin'
    return 'punct'


def fixture_tokenize(sentence):
    """Deterministic stand-in for fugashi (not installed for the browser fixture): fixture words
    first (longest match), otherwise runs of one character class. Digits and punctuation untappable."""
    tokens, i, n = [], 0, len(sentence)

    def word_at(i):
        return next((w for w in sorted(WORDS, key=len, reverse=True) if sentence.startswith(w, i)), None)
    while i < n:
        word = word_at(i)
        if word:
            entry = WORDS[word]
            tokens.append({'s': word, 'r': entry[0], 'l': entry[2] if len(entry) > 2 else word, 'p': entry[1], 't': True})
            i += len(word)
            continue
        kind, j = _kind(sentence[i]), i + 1
        while j < n and _kind(sentence[j]) == kind and not word_at(j):
            j += 1
        surface = sentence[i:j]
        pos = {'digit': '名詞', 'punct': '補助記号'}.get(kind, '名詞')
        tokens.append({'s': surface, 'r': '', 'l': surface, 'p': pos, 't': kind not in ('digit', 'punct')})
        i = j
    return tokens


def fixture_sentences(text, start_id):
    return [{'id': start_id + i, 'tokens': fixture_tokenize(s)} for i, s in enumerate(split_sentences(text))]


def news_wiring(base):
    """Fake Yahoo + FakeHub for the /news/ pages; nothing here touches the network.

    NEWS_HUB_SCRIPT: path of a JSON file, either a list (the FakeHub script) or an object
    {"script": [...], "models": [...]}; unset gives one 'ok' chunk and FakeHub's default models.
    NEWS_SELECTED_MODEL: model id stored as the page header's selection at start (default none).
    Controls a test can flip while the server runs, by creating/removing files in the state dir:
      news-rss-fail     every RSS fetch raises (shows the stale notice once the cache has aged)
      news-clock-offset a number of seconds added to the news service clock (ages the RSS cache;
                        120 also gets past the 60 s reuse of a just-opened article)
      news-hold-page2   fetching page 2 of READER_URL waits while this file exists (progress stays visible)
      news-page3-fail   page 3 of READER_URL answers 503 (a partial article with a missing page)
    READER_URL is a three-page article (see READER_PAGES); its two images are served by a fake
    image host. Tokenizing uses fixture_sentences instead of fugashi."""
    spec = {}
    if os.environ.get('NEWS_HUB_SCRIPT'):
        spec = json.loads(Path(os.environ['NEWS_HUB_SCRIPT']).read_text('utf-8'))
    if isinstance(spec, list):
        spec = {'script': spec}
    hub_server = FakeHub(spec.get('script'), spec.get('models'))
    rss = load('rss').decode('utf-8')
    mapping = {PICKUP_URL: (200, load('pickup')), ARTICLE_URL: (200, load('single')),
               READER_URL: (200, READER_PAGES[1]), READER_URL + '?page=2': (200, READER_PAGES[2]),
               READER_URL + '?page=3': (200, READER_PAGES[3])}
    for slug in FEEDS:
        # One distinct headline prefix per category so a test can tell which list is showing.
        mapping['https://news.yahoo.co.jp/rss/topics/%s.xml' % slug] = (200, rss.replace('見出し', slug + 'の見出し').encode('utf-8'))
    inner = fake_fetch(mapping)
    fail, offset = base / 'news-rss-fail', base / 'news-clock-offset'
    hold, page3_fail = base / 'news-hold-page2', base / 'news-page3-fail'

    def fetch(url):
        if '/rss/' in url and fail.exists():
            raise OSError('simulated RSS outage')
        if url == READER_URL + '?page=2':
            deadline = time.time() + 20
            while hold.exists() and time.time() < deadline:
                time.sleep(0.05)
        if url == READER_URL + '?page=3' and page3_fail.exists():
            return 503, b''
        return inner(url)
    images = fake_open({IMAGE_HOST + 'photo1.jpg': _png(), IMAGE_HOST + 'poster1.jpg': _png()})
    news_module.to_sentences = fixture_sentences
    service = NewsService(app.config, base, yahoo=Yahoo(fetch=fetch, sleep=lambda s: None, open_image=images),
                          hub=Hub(hub_server.base_url, 'fixture-key'))
    service.clock = lambda: time.time() + (float(offset.read_text()) if offset.exists() else 0)
    if os.environ.get('NEWS_SELECTED_MODEL'):
        service.store.save_settings({'model': os.environ['NEWS_SELECTED_MODEL']})
    app.news = service


news_wiring(base)
server = create_server(app, ('127.0.0.1', 0))
app.config['origin'] = f'http://127.0.0.1:{server.server_port}'
print(app.config['origin'], flush=True)
server.serve_forever()
