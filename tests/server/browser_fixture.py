import json
import sys
from pathlib import Path
from server.app import Application, create_server
from server.auth import Auth
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
server = create_server(app, ('127.0.0.1', 0))
app.config['origin'] = f'http://127.0.0.1:{server.server_port}'
print(app.config['origin'], flush=True)
server.serve_forever()
