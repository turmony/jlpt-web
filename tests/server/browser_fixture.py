import json
import os
import sys
import time
from pathlib import Path
from server.app import Application, create_server
from server.auth import Auth
from server.llm import Hub
from server.news import NewsService
from server.news_yahoo import FEEDS, Yahoo
from tests.server.fake_hub import FakeHub
from tests.server.news_fixture import ARTICLE_URL, PICKUP_URL, fake_fetch, load
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


def news_wiring(base):
    """Fake Yahoo + FakeHub for the /news/ pages; nothing here touches the network.

    NEWS_HUB_SCRIPT: path of a JSON file, either a list (the FakeHub script) or an object
    {"script": [...], "models": [...]}; unset gives one 'ok' chunk and FakeHub's default models.
    NEWS_SELECTED_MODEL: model id stored as the page header's selection at start (default none).
    Controls a test can flip while the server runs, by creating/removing files in the state dir:
      news-rss-fail     every RSS fetch raises (shows the stale notice once the cache has aged)
      news-clock-offset a number of seconds added to the news service clock (ages the RSS cache)"""
    spec = {}
    if os.environ.get('NEWS_HUB_SCRIPT'):
        spec = json.loads(Path(os.environ['NEWS_HUB_SCRIPT']).read_text('utf-8'))
    if isinstance(spec, list):
        spec = {'script': spec}
    hub_server = FakeHub(spec.get('script'), spec.get('models'))
    rss = load('rss').decode('utf-8')
    mapping = {PICKUP_URL: (200, load('pickup')), ARTICLE_URL: (200, load('single'))}
    for slug in FEEDS:
        # One distinct headline prefix per category so a test can tell which list is showing.
        mapping['https://news.yahoo.co.jp/rss/topics/%s.xml' % slug] = (200, rss.replace('見出し', slug + 'の見出し').encode('utf-8'))
    inner = fake_fetch(mapping)
    fail, offset = base / 'news-rss-fail', base / 'news-clock-offset'

    def fetch(url):
        if '/rss/' in url and fail.exists():
            raise OSError('simulated RSS outage')
        return inner(url)
    service = NewsService(app.config, base, yahoo=Yahoo(fetch=fetch, sleep=lambda s: None),
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
