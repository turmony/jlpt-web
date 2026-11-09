import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from server.app import Application, create_server
from server.auth import Auth
from server.llm import Hub
from server.news import NewsService
import server.news as news_module
from server.news_text import split_sentences
from tests.server.fake_hub import FakeHub
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


class _Recorded(list):
    """FakeHub's request list, mirrored to a JSON file after every append."""
    def __init__(self, path):
        super().__init__()
        self.path = path

    def append(self, item):
        super().append(item)
        part = self.path.with_suffix('.part')
        part.write_text(json.dumps(self, ensure_ascii=False), 'utf-8')
        part.replace(self.path)


class RecordingHub(FakeHub):
    """FakeHub whose requests and disconnect count are visible to the browser tests as files."""
    def __init__(self, base, script=None, models=None):
        self._disconnects_file = base / 'news-hub-disconnects'
        super().__init__(script, models)
        self.requests = _Recorded(base / 'news-hub-requests.json')

    @property
    def disconnects(self):
        return getattr(self, '_disconnects', 0)

    @disconnects.setter
    def disconnects(self, value):
        self._disconnects = value
        self._disconnects_file.write_text(str(value))


def news_wiring(base):
    """A FakeHub behind the news service; nothing here touches the network.

    NEWS_HUB_SCRIPT: path of a JSON file, either a list (the FakeHub script) or an object
    {"script": [...], "models": [...]}; unset gives one 'ok' chunk and FakeHub's default models.
    NEWS_SELECTED_MODEL: model id stored as the selected model at start (default none).
    Tokenizing uses fixture_sentences instead of fugashi.
    What the FakeHub saw is written to the state dir for the browser tests to read:
      news-hub-requests.json  every chat request body, in arrival order (rewritten on each request)
      news-hub-disconnects    the number of chat requests whose client (the news server) hung up early"""
    spec = {}
    if os.environ.get('NEWS_HUB_SCRIPT'):
        spec = json.loads(Path(os.environ['NEWS_HUB_SCRIPT']).read_text('utf-8'))
    if isinstance(spec, list):
        spec = {'script': spec}
    hub_server = RecordingHub(base, spec.get('script'), spec.get('models'))
    news_module.to_sentences = fixture_sentences
    service = NewsService(app.config, base, hub=Hub(hub_server.base_url, 'fixture-key'))
    if os.environ.get('NEWS_SELECTED_MODEL'):
        service.store.save_settings({'model': os.environ['NEWS_SELECTED_MODEL']})
    app.news = service


ARTICLE = Path(__file__).with_name('news_site') / 'article.html'


class SampleSite(BaseHTTPRequestHandler):
    """A Yahoo-like news site on its own port: every /articles/<hex>[/...] path serves article.html
    (query parameters are read by the page's own script; see the file)."""
    def do_GET(self):
        if not re.fullmatch(r'/articles/[0-9a-f]+(/images/\d+)?', self.path.split('?')[0]):
            self.send_error(404)
            return
        body = ARTICLE.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


sample = ThreadingHTTPServer(('127.0.0.1', 0), SampleSite)
threading.Thread(target=sample.serve_forever, daemon=True).start()
site_origin = f'http://127.0.0.1:{sample.server_port}'
# The sample site is the only news site: loader @match, CORS allow-list and site detection all derive from it.
app.config['news_sites'] = [{'name': '样例新闻', 'origin': site_origin, 'match': site_origin + '/articles/*',
                             'path': '^/articles/[0-9a-f]+$', 'parts': ['h1', '.article_body']}]
news_wiring(base)
server = create_server(app, ('127.0.0.1', 0))
app.config['origin'] = f'http://127.0.0.1:{server.server_port}'
print(f"{app.config['origin']} {site_origin}", flush=True)
server.serve_forever()
