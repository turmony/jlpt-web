import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from server import review
from server.app import Application, create_server
from server.auth import Auth
from server.store import Conflict
from tests.server.review_fixture import finish_unit, make_study, paper_slug, prepare_review

UNIT_PAPER = '2026-10-17-b-01-1'


class ReviewModuleTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.study = make_study(self.tmp)
        self.notes = self.study / 'jlpt-notes'

    def paper_text(self, slug=UNIT_PAPER):
        return (self.notes / 'quizzes/papers' / f'{slug}.md').read_text()

    def test_today_reports_learn_state_from_study_repo(self):
        state = review.today(self.study)
        self.assertEqual(state['state'], 'learn')
        self.assertEqual(state['unit']['id'], 'B-01-1')
        self.assertEqual((state['progress']['learned'], state['progress']['total']), (0, 2))

    def test_unit_view_before_recall_returns_rows_only(self):
        view = review.unit_view(self.study, 'B-01-1')
        self.assertEqual(view['unit'], {'id': 'B-01-1', 'title': 'に', 'kind': 'system',
                                        'position': ['基础体系表', 'B-01 助词用法地图', 'B-01-1 に']})
        self.assertEqual(view['session'], {'started': False, 'submitted': False, 'locked_at': None, 'submitted_at': None})
        self.assertEqual(view['recall'], {'items': [{'form': 'に', 'usage': '时间点'}, {'form': 'へ', 'usage': '动作的方向'}],
                                          'missed': None})
        for key in ('page', 'cards', 'paper', 'sentence', 'note'):
            self.assertNotIn(key, view)

    def test_unit_view_after_recall_rewrites_images_and_card_links(self):
        review.load_groups(self.study).start_unit(self.notes, 'B-01-1', [])
        view = review.unit_view(self.study, 'B-01-1')
        self.assertTrue(view['session']['started'])
        self.assertFalse(view['session']['submitted'])
        self.assertRegex(view['session']['locked_at'], r'\+08:00$')
        self.assertEqual(view['recall']['missed'], [])
        page = view['page']
        self.assertIn('![时点に接续图](/api/review/asset?path=assets/grammar/n5/N5-G-0013-connection.png)', page)
        self.assertIn('### [N5-G-0013 助词：动作进行时点「に」](#card-N5-G-0013)', page)
        self.assertIn('### [N5-G-0032 助词：动作对象「に」](#card-N5-G-0032)', page)
        self.assertNotIn('grammar_system_unit', page)
        self.assertTrue(page.startswith('# B-01-1 に'))
        self.assertEqual(view['cards'], [
            {'id': 'N5-G-0013', 'title': '助词：动作进行时点「に」', 'core': '时间词＋に，表示动作发生的时间点。'},
            {'id': 'N5-G-0032', 'title': '助词：动作对象「に」', 'core': '「に」标出动作指向的对象。'}])
        self.assertEqual(view['paper']['slug'], UNIT_PAPER)
        self.assertEqual(view['paper']['numbers'], [1, 2, 3, 4, 5])
        self.assertNotIn('## 答案填写区', view['paper']['text'])
        self.assertIn('### 5. 三時（　）会いましょう。', view['paper']['text'])
        self.assertEqual(view['sentence'], {'card': 'N5-G-0013', 'prompt': '用本单元的语法翻译：三点见面吧。', 'text': None})
        self.assertIsNone(view['note'])

    def test_unknown_or_unprepared_unit_is_missing(self):
        for unit_id in ('B-01-2', 'G-001', 'B-09-9'):
            with self.subTest(unit_id=unit_id), self.assertRaises(KeyError):
                review.unit_view(self.study, unit_id)

    def test_asset_serves_png_from_assets(self):
        data, mime = review.asset(self.study, 'assets/grammar/n5/N5-G-0013-connection.png')
        self.assertEqual(mime, 'image/png')
        self.assertEqual(data, (self.notes / 'assets/grammar/n5/N5-G-0013-connection.png').read_bytes())

    def test_asset_rejects_traversal_and_symlinks(self):
        (self.tmp / 'secret.png').write_bytes(b'secret')
        (self.tmp / 'outside').mkdir()
        (self.tmp / 'outside/secret.png').write_bytes(b'secret')
        (self.notes / 'assets/link.png').symlink_to(self.tmp / 'secret.png')
        (self.notes / 'assets/linked').symlink_to(self.tmp / 'outside', target_is_directory=True)
        for path in ('../../.git/config', 'assets/../../secret.png', '/etc/passwd', 'assets/link.png',
                     'assets/linked/secret.png', 'grammar/n5/N5-G-0013.md', 'assets/grammar/n5/missing.png',
                     'assets/../groups/mapping.json', 'assets\\..\\..\\secret.png', ''):
            with self.subTest(path=path), self.assertRaises((ValueError, KeyError)):
                review.asset(self.study, path)

    def test_plan_data_error_becomes_study_data_error(self):
        path = self.notes / 'groups/submissions/r1/B-01-1.json'
        path.parent.mkdir(parents=True)
        path.write_text('{')
        with self.assertRaisesRegex(review.StudyDataError, '资料格式错误：groups/submissions/r1/B-01-1.json'):
            review.today(self.study)
        with self.assertRaisesRegex(review.StudyDataError, 'groups/submissions/r1/B-01-1.json'):
            review.unit_view(self.study, 'B-01-1')

    def test_missing_groups_module_is_study_data_error(self):
        (self.study / 'src/jlpt_notes/groups.py').unlink()
        with self.assertRaisesRegex(review.StudyDataError, 'src/jlpt_notes/groups.py'):
            review.today(self.study)

    def test_rule_refusals_become_forbidden_conflict_or_invalid(self):
        with self.assertRaises(review.Forbidden):
            review.recall(self.study, 'B-01-2', [])
        with self.assertRaises(ValueError) as caught:
            review.recall(self.study, 'B-01-1', [2])
        self.assertIs(type(caught.exception), ValueError)
        view = review.recall(self.study, 'B-01-1', [1])
        self.assertEqual(view['recall']['missed'], [1])
        self.assertIn('page', view)
        with self.assertRaises(Conflict):
            review.recall(self.study, 'B-01-1', [])
        self.assertEqual(review.unit_view(self.study, 'B-01-1')['recall']['missed'], [1])

    def test_recall_records_missed_rows(self):
        review.recall(self.study, 'B-01-1', [1])
        marks = json.loads((self.notes / 'groups/submissions/r1/B-01-1.json').read_text())['recall']['marks']
        self.assertEqual(marks, [{'card': 'N5-G-0013', 'item': 0, 'recalled': True},
                                 {'card': 'N5-G-0032', 'item': 1, 'recalled': False}])

    def test_legacy_recall_text_does_not_crash_view(self):
        path = self.notes / 'groups/submissions/r1/B-01-1.json'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'schema_version': 1, 'unit_id': 'B-01-1', 'round': 1, 'paper': UNIT_PAPER,
                                    'recall': {'text': '回忆', 'locked_at': '2026-10-17T20:00:00+08:00'}}))
        view = review.unit_view(self.study, 'B-01-1')
        self.assertIsNone(view['recall']['missed'])
        self.assertIn('page', view)

    def test_submit_unit_writes_answers_then_locks_everything(self):
        with self.assertRaises(review.Forbidden):
            review.submit_unit(self.study, 'B-01-1', {'1': {'answer': '2'}}, '三時に会いましょう。', '')
        self.assertIn('1-__,', self.paper_text())
        review.recall(self.study, 'B-01-1', [])
        state = review.submit_unit(self.study, 'B-01-1', {'1': {'answer': '2', 'uncertain': True}},
                                   '三時に会いましょう。', '对比页少了例句')
        self.assertEqual(state['progress']['study_day'], 1)
        self.assertEqual(state['pending_grading'], [{'id': 'B-01-1', 'paper': UNIT_PAPER}])
        self.assertIn('*1-2, 2-__', self.paper_text())
        submission = json.loads((self.notes / 'groups/submissions/r1/B-01-1.json').read_text())
        self.assertEqual(submission['sentence'], {'card': 'N5-G-0013', 'text': '三時に会いましょう。'})
        self.assertEqual(submission['note'], '对比页少了例句')
        view = review.unit_view(self.study, 'B-01-1')
        self.assertTrue(view['session']['submitted'])
        self.assertEqual((view['sentence']['text'], view['note']), ('三時に会いましょう。', '对比页少了例句'))
        with self.assertRaises(Conflict):
            review.submit_unit(self.study, 'B-01-1', {'1': {'answer': '3'}}, '別の文。', '')
        self.assertIn('*1-2, 2-__', self.paper_text())

    def test_submit_unit_rejects_bad_answers_without_submitting(self):
        review.recall(self.study, 'B-01-1', [])
        with self.assertRaises(ValueError):
            review.submit_unit(self.study, 'B-01-1', {'9': {'answer': '1'}}, '三時に会いましょう。', '')
        self.assertNotIn('submitted_at', json.loads((self.notes / 'groups/submissions/r1/B-01-1.json').read_text()))


class ReviewSessionTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.study = make_study(Path(tmp.name), units=8)
        self.notes = self.study / 'jlpt-notes'
        self.covers = [f'B-01-{index}' for index in range(1, 8)]
        for minute, unit_id in enumerate(self.covers):
            finish_unit(self.notes, unit_id, minute)

    def test_review_view_needs_a_due_prepared_review(self):
        with self.assertRaises(review.Forbidden):
            review.review_view(self.study, 'review-01')
        prepare_review(self.notes, 'review-01', self.covers)
        view = review.review_view(self.study, 'review-01')
        self.assertEqual(view['review'], {'id': 'review-01', 'covers': self.covers})
        self.assertEqual(view['session'], {'submitted': False, 'submitted_at': None})
        self.assertEqual(view['paper']['numbers'], list(range(1, 13)))
        self.assertNotIn('## 答案填写区', view['paper']['text'])
        prepare_review(self.notes, 'review-02', self.covers)
        with self.assertRaises(review.Forbidden):
            review.review_view(self.study, 'review-02')

    def test_submit_review_writes_answers_and_closes_the_review(self):
        prepare_review(self.notes, 'review-01', self.covers)
        state = review.submit_review(self.study, 'review-01', {'12': {'answer': '4'}})
        self.assertEqual(state['progress']['reviews_done'], 1)
        self.assertEqual((state['state'], state['unit']['id']), ('not_prepared', 'B-01-8'))
        self.assertIn(', 12-4\n', (self.notes / 'quizzes/papers' / f"{paper_slug('review-01')}.md").read_text())
        view = review.review_view(self.study, 'review-01')
        self.assertTrue(view['session']['submitted'])
        with self.assertRaises(Conflict):
            review.submit_review(self.study, 'review-01', {'12': {'answer': '1'}})


class ReviewHTTPTests(unittest.TestCase):
    SUBMIT = {'answers': {'1': {'answer': '2', 'uncertain': True}}, 'sentence': '日本に行きます。', 'note': ''}

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.study = make_study(root)
        self.notes = self.study / 'jlpt-notes'
        (root / 'static').mkdir()
        config = {'state': str(root / 'state'), 'study': str(self.study), 'static': str(root / 'static'),
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

    def login(self):
        response = self.request('/api/login', {'password': 'secret'})
        self.assertEqual(response.status, 200)
        self.cookie = response.headers['Set-Cookie'].split(';')[0]

    def paper_text(self):
        return (self.notes / f'quizzes/papers/{UNIT_PAPER}.md').read_text()

    def submission(self):
        return json.loads((self.notes / 'groups/submissions/r1/B-01-1.json').read_text())

    def test_review_endpoints_require_login(self):
        for path in ('/api/review/today', '/api/review/units/B-01-1', '/api/review/reviews/review-01',
                     '/api/review/asset?path=assets/grammar/n5/N5-G-0013-connection.png'):
            with self.subTest(path=path):
                self.assertEqual(self.request(path).status, 401)
        self.assertEqual(self.request('/api/review/units/B-01-1/recall', {'missed': []}).status, 401)
        self.assertEqual(self.request('/api/review/units/B-01-1/submit', self.SUBMIT).status, 401)
        self.assertFalse((self.notes / 'groups/submissions').exists())

    def test_full_unit_flow_over_http(self):
        self.login()
        self.assertEqual(json.load(self.request('/api/review/today'))['state'], 'learn')
        before = json.load(self.request('/api/review/units/B-01-1'))
        for key in ('page', 'cards', 'paper', 'sentence'):
            self.assertNotIn(key, before)
        response = self.request('/api/review/units/B-01-1/recall', {'missed': []})
        self.assertEqual(response.status, 200)
        view = json.load(response)
        self.assertIn('/api/review/asset?path=assets/grammar/n5/N5-G-0013-connection.png', view['page'])
        self.assertEqual(view['paper']['numbers'], [1, 2, 3, 4, 5])
        state = json.load(self.request('/api/review/units/B-01-1/submit', self.SUBMIT))
        self.assertEqual(state['progress']['study_day'], 1)
        self.assertEqual(state['pending_grading'], [{'id': 'B-01-1', 'paper': UNIT_PAPER}])
        self.assertRegex(self.paper_text(), r'\*1-2')
        self.assertEqual(self.submission()['sentence']['text'], '日本に行きます。')
        self.assertEqual(self.submission()['recall']['marks'][0]['recalled'], True)

    def test_second_submit_conflicts(self):
        self.login()
        self.request('/api/review/units/B-01-1/recall', {'missed': []})
        self.assertEqual(self.request('/api/review/units/B-01-1/submit', self.SUBMIT).status, 200)
        again = {'answers': {'1': {'answer': '3'}}, 'sentence': '別の文。', 'note': '改'}
        self.assertEqual(self.request('/api/review/units/B-01-1/submit', again).status, 409)
        self.assertRegex(self.paper_text(), r'\*1-2')
        self.assertEqual((self.submission()['sentence']['text'], self.submission()['note']), ('日本に行きます。', ''))
        self.assertEqual(self.request('/api/review/units/B-01-1/recall', {'missed': [0]}).status, 403)
        self.assertEqual(self.submission()['recall']['marks'][0]['recalled'], True)

    def test_second_recall_conflicts(self):
        self.login()
        self.assertEqual(self.request('/api/review/units/B-01-1/recall', {'missed': []}).status, 200)
        self.assertEqual(self.request('/api/review/units/B-01-1/recall', {'missed': [0]}).status, 409)
        self.assertEqual(self.submission()['recall']['marks'][0]['recalled'], True)

    def test_submit_before_recall_is_forbidden(self):
        self.login()
        response = self.request('/api/review/units/B-01-1/submit', self.SUBMIT)
        self.assertEqual(response.status, 403)
        self.assertIn('尚未提交回忆', json.load(response)['error'])
        self.assertNotIn('*1-2', self.paper_text())
        self.assertFalse((self.notes / 'groups/submissions').exists())

    def test_recall_rejected_from_other_origin(self):
        self.login()
        self.assertEqual(self.request('/api/review/units/B-01-1/recall', {'missed': []}, origin='https://evil.example').status, 403)
        self.assertFalse((self.notes / 'groups/submissions').exists())

    def test_invalid_input_is_400(self):
        self.login()
        for body in ({'missed': True}, {'missed': [True]}, {'missed': [5]}, {'missed': ['1']}, {}):
            with self.subTest(body=body):
                self.assertEqual(self.request('/api/review/units/B-01-1/recall', body).status, 400)
        self.assertFalse((self.notes / 'groups/submissions').exists())
        self.request('/api/review/units/B-01-1/recall', {'missed': []})
        for body in ({**self.SUBMIT, 'sentence': ''}, {**self.SUBMIT, 'answers': {'9': {'answer': '1'}}},
                     {**self.SUBMIT, 'answers': None}):
            with self.subTest(body=body):
                self.assertEqual(self.request('/api/review/units/B-01-1/submit', body).status, 400)
        self.assertNotIn('submitted_at', self.submission())

    def test_unknown_or_malformed_ids_are_404(self):
        self.login()
        for path in ('/api/review/units/../x', '/api/review/units/X-1', '/api/review/units/B-01-2',
                     '/api/review/units/%2e%2e%2fmapping', '/api/review/units/B-01-1/other', '/api/review/reviews/review-1',
                     '/api/review/reviews/B-01-1', '/api/review/nothing'):
            with self.subTest(path=path):
                self.assertEqual(self.request(path).status, 404)
        self.assertEqual(self.request('/api/review/units/X-1/recall', {'missed': []}).status, 404)

    def test_review_that_is_not_due_is_forbidden(self):
        self.login()
        self.assertEqual(self.request('/api/review/reviews/review-01').status, 403)
        self.assertEqual(self.request('/api/review/reviews/review-01/submit', {'answers': {}}).status, 403)

    def test_material_without_recall_items_is_500_with_path(self):
        self.login()
        path = self.notes / 'groups/units/B-01-1.json'
        material = json.loads(path.read_text())
        del material['recall_items']
        path.write_text(json.dumps(material))
        response = self.request('/api/review/units/B-01-1')
        self.assertEqual(response.status, 500)
        self.assertIn('groups/units/B-01-1.json', json.load(response)['error'])

    def test_corrupt_study_data_returns_500_with_path(self):
        self.login()
        path = self.notes / 'groups/submissions/r1/B-01-1.json'
        path.parent.mkdir(parents=True)
        path.write_text('{')
        for url in ('/api/review/today', '/api/review/units/B-01-1'):
            with self.subTest(url=url):
                response = self.request(url)
                self.assertEqual(response.status, 500)
                self.assertIn('groups/submissions/r1/B-01-1.json', json.load(response)['error'])

    def test_regular_papers_api_cannot_open_plan_paper(self):
        self.login()
        self.assertEqual(self.request(f'/api/quiz/papers/{UNIT_PAPER}').status, 404)
        self.assertEqual(self.request(f'/api/quiz/papers/{UNIT_PAPER}/answers', {'answers': {'1': {'answer': '2'}}}).status, 404)
        self.assertNotIn(UNIT_PAPER, [paper['slug'] for paper in json.load(self.request('/api/quiz/papers'))])
        self.assertNotIn('1-2', self.paper_text())

    def test_asset_endpoint_serves_images_only(self):
        self.login()
        response = self.request('/api/review/asset?path=assets/grammar/n5/N5-G-0013-connection.png')
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers['Content-Type'], 'image/png')
        self.assertEqual(response.headers['Cache-Control'], 'private, max-age=3600')
        self.assertEqual(response.read(), (self.notes / 'assets/grammar/n5/N5-G-0013-connection.png').read_bytes())
        for query in ('path=../../.git/config', 'path=assets/%2e%2e/%2e%2e/.git/config', 'path=%2e%2e%2f%2e%2e%2f.git%2fconfig',
                      'path=assets/%2e%2e/groups/mapping.json', '', 'path=assets/grammar/n5/N5-G-0013-connection.png&path=x'):
            with self.subTest(query=query):
                self.assertIn(self.request('/api/review/asset?' + query).status, (400, 404))
