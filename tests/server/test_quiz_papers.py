import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from server import papers
from server.app import Application, create_server
from server.auth import Auth
from server.store import Conflict

PAPER = '''# N1 第111–120条语法练习（10道选择题）

- 日期：2026-10-14

## 第一部分：文の文法１（形式选择）（1–3）

### 1. 転んだ（　）、頭を打ってしまった。

1. ばかりに
2. ことなく
3. 拍子に
4. ともなると

## 第二部分：文の文法２（句子排序）（2–3）

### 2. 先生は来年 ＿＿ ★ ＿＿ ＿＿ そうだ。

1. アメリカの
2. 講演に
3. 大学から
4. 招かれる

#### 3.

1. いき
2. き

## 答案填写区

```text
第一部分（1–1）：
1-__

第二部分（2–3，可提交完整语序，如“2：2314”）：
2-__, 3-
```
'''


class PaperFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.quizzes = self.root / 'jlpt-notes/quizzes'
        (self.quizzes / 'papers').mkdir(parents=True)
        (self.quizzes / 'results').mkdir()
        self.path = self.quizzes / 'papers/2026-10-14-n1-111-120-test-1.md'
        self.path.write_text(PAPER)

    def test_list_reports_title_question_count_and_status(self):
        (self.quizzes / 'papers/2026-10-13-old.md').write_text(PAPER.replace('1-__', '1-3'))
        (self.quizzes / 'papers/2026-10-12-graded.md').write_text(PAPER)
        (self.quizzes / 'results/2026-10-12-graded-result.md').write_text('# 成绩')
        listed = papers.list_papers(self.root)
        self.assertEqual([p['slug'] for p in listed], ['2026-10-14-n1-111-120-test-1', '2026-10-13-old', '2026-10-12-graded'])
        self.assertEqual(listed[0], {'slug': '2026-10-14-n1-111-120-test-1', 'title': 'N1 第111–120条语法练习（10道选择题）',
                                     'date': '2026-10-14', 'questions': 3, 'answered': 0, 'status': 'new'})
        self.assertEqual([p['status'] for p in listed[1:]], ['submitted', 'graded'])

    def test_list_keeps_only_the_most_recent_papers(self):
        for day in range(1, 25):
            (self.quizzes / f'papers/2026-09-{day:02d}-n2-test.md').write_text(PAPER)
        listed = papers.list_papers(self.root)
        self.assertEqual(len(listed), 20)
        self.assertEqual(listed[0]['slug'], '2026-10-14-n1-111-120-test-1')
        self.assertEqual(listed[-1]['slug'], '2026-09-06-n2-test')

    def test_write_fills_only_answer_lines_and_marks_uncertain(self):
        result = papers.write_answers(self.root, self.path.stem, {
            '1': {'answer': '3', 'uncertain': False},
            '2': {'answer': '3124', 'uncertain': True},
        })
        text = self.path.read_text()
        self.assertIn('```text\n第一部分（1–1）：\n1-3\n\n第二部分（2–3，可提交完整语序，如“2：2314”）：\n*2-3124, 3-__\n```', text)
        self.assertEqual(text.split('## 答案填写区')[0], PAPER.split('## 答案填写区')[0])
        self.assertEqual(result['answers'], {'1': {'answer': '3', 'uncertain': False},
                                             '2': {'answer': '3124', 'uncertain': True},
                                             '3': {'answer': '', 'uncertain': False}})
        self.assertEqual(result['status'], 'submitted')

    def test_resubmission_replaces_previous_answers_until_graded(self):
        papers.write_answers(self.root, self.path.stem, {'1': {'answer': '3', 'uncertain': True}})
        papers.write_answers(self.root, self.path.stem, {'1': {'answer': '4', 'uncertain': False}, '3': {'answer': '2'}})
        self.assertIn('1-4\n', self.path.read_text())
        self.assertIn('2-__, 3-2\n', self.path.read_text())
        (self.quizzes / f'results/{self.path.stem}-result.md').write_text('# 成绩')
        with self.assertRaises(Conflict):
            papers.write_answers(self.root, self.path.stem, {'1': {'answer': '1'}})

    def test_invalid_answers_and_paths_are_rejected_without_writing(self):
        for answers in ({'9': {'answer': '1'}}, {'1': {'answer': '1, 2-3'}}, {'1': {'answer': 'x'}},
                        {'1': {'answer': '1', 'uncertain': 'yes'}}, {'1': '1'}, []):
            with self.assertRaises(ValueError):
                papers.write_answers(self.root, self.path.stem, answers)
        for slug in ('../secret', 'a/b', '.hidden', ''):
            with self.assertRaises((ValueError, KeyError)):
                papers.read_paper(self.root, slug)
        self.assertEqual(self.path.read_text(), PAPER)

    def test_read_includes_result_text_when_graded(self):
        (self.quizzes / f'results/{self.path.stem}-result.md').write_text('# 成绩\n\n9/10')
        paper = papers.read_paper(self.root, self.path.stem)
        self.assertEqual(paper['status'], 'graded')
        self.assertEqual(paper['result'], '# 成绩\n\n9/10')
        self.assertEqual(paper['text'], PAPER)
        self.assertEqual(paper['numbers'], [1, 2, 3])

    def register_plan_paper(self, folder, item_id, slug, raw=None):
        (self.quizzes / f'papers/{slug}.md').write_text(PAPER)
        material = self.root / f'jlpt-notes/groups/{folder}/{item_id}.json'
        material.parent.mkdir(parents=True, exist_ok=True)
        material.write_text(raw if raw is not None else json.dumps({'paper': slug}))

    def test_plan_papers_are_hidden_from_regular_api(self):
        self.register_plan_paper('units', 'B-01-1', '2026-10-17-b-01-1')
        self.register_plan_paper('reviews', 'review-01', '2026-10-18-review-01')
        # A damaged material file still hides its paper instead of exposing it.
        self.register_plan_paper('units', 'B-01-2', '2026-10-17-b-01-2', raw='{"paper": "2026-10-17-b-01-2",')
        self.assertEqual(papers.plan_slugs(self.root), {'2026-10-17-b-01-1', '2026-10-18-review-01', '2026-10-17-b-01-2'})
        self.assertEqual([p['slug'] for p in papers.list_papers(self.root)], ['2026-10-14-n1-111-120-test-1'])
        for slug in ('2026-10-17-b-01-1', '2026-10-18-review-01', '2026-10-17-b-01-2'):
            with self.assertRaises(KeyError):
                papers.read_paper(self.root, slug)
            with self.assertRaises(KeyError):
                papers.write_answers(self.root, slug, {'1': {'answer': '2'}})
            self.assertEqual((self.quizzes / f'papers/{slug}.md').read_text(), PAPER)

    def test_plan_paper_helpers_only_accept_plan_papers(self):
        self.register_plan_paper('units', 'B-01-1', '2026-10-17-b-01-1')
        paper = papers.read_plan_paper(self.root, '2026-10-17-b-01-1')
        self.assertEqual(paper['text'], PAPER.split('\n## 答案填写区')[0])
        self.assertEqual(paper['numbers'], [1, 2, 3])
        with self.assertRaises(KeyError):
            papers.read_plan_paper(self.root, self.path.stem)
        with self.assertRaises(KeyError):
            papers.write_plan_answers(self.root, self.path.stem, {'1': {'answer': '2'}})
        self.assertEqual(self.path.read_text(), PAPER)
        saved = papers.write_plan_answers(self.root, '2026-10-17-b-01-1', {'1': {'answer': '2', 'uncertain': True}})
        self.assertEqual(saved['answers']['1'], {'answer': '2', 'uncertain': True})
        self.assertNotIn('## 答案填写区', saved['text'])
        self.assertIn('\n*1-2\n', (self.quizzes / 'papers/2026-10-17-b-01-1.md').read_text())
        with self.assertRaises(ValueError):
            papers.write_plan_answers(self.root, '2026-10-17-b-01-1', {'9': {'answer': '1'}})
        (self.quizzes / 'results/2026-10-17-b-01-1-result.md').write_text('# 成绩')
        with self.assertRaises(Conflict):
            papers.write_plan_answers(self.root, '2026-10-17-b-01-1', {'1': {'answer': '3'}})


class PaperHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        study = root / 'study'
        (study / 'jlpt-notes/quizzes/papers').mkdir(parents=True)
        self.paper = study / 'jlpt-notes/quizzes/papers/2026-10-14-n1-test.md'
        self.paper.write_text(PAPER)
        (root / 'static').mkdir()
        config = {'state': str(root), 'study': str(study), 'static': str(root / 'static'),
                  'origin': 'http://test.local', 'secure_cookie': False, 'password_hash': Auth.hash_password('secret')}
        self.server = create_server(Application(config), ('127.0.0.1', 0))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.cookie = ''

    def request(self, path, data=None, origin='http://test.local'):
        headers = {'Cookie': self.cookie}
        if data is not None:
            headers.update({'Content-Type': 'application/json', 'Origin': origin})
        req = urllib.request.Request(self.url + path, data=None if data is None else json.dumps(data).encode(), headers=headers)
        try:
            return urllib.request.urlopen(req)
        except urllib.error.HTTPError as error:
            return error

    def test_endpoints_need_login_and_same_origin(self):
        answers = {'answers': {'1': {'answer': '3', 'uncertain': False}}}
        self.assertEqual(self.request('/api/quiz/papers').status, 401)
        self.assertEqual(self.request('/api/quiz/papers/2026-10-14-n1-test/answers', answers).status, 401)
        response = self.request('/api/login', {'password': 'secret'})
        self.cookie = response.headers['Set-Cookie'].split(';')[0]
        self.assertEqual(self.request('/api/quiz/papers/2026-10-14-n1-test/answers', answers, origin='https://evil.example').status, 403)
        self.assertEqual(self.paper.read_text(), PAPER)
        self.assertEqual(json.load(self.request('/api/quiz/papers'))[0]['slug'], '2026-10-14-n1-test')
        self.assertEqual(json.load(self.request('/api/quiz/papers/2026-10-14-n1-test'))['numbers'], [1, 2, 3])
        saved = json.load(self.request('/api/quiz/papers/2026-10-14-n1-test/answers', answers))
        self.assertEqual(saved['answers']['1'], {'answer': '3', 'uncertain': False})
        self.assertIn('\n1-3\n', self.paper.read_text())
        self.assertEqual(self.request('/api/quiz/papers/missing').status, 404)
